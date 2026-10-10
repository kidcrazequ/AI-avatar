import crypto from 'node:crypto';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WorkflowStore, nextScheduled, workflowVersion } from './workflow-store';
import { TaskRuntime } from './task-runtime';
import { required, now } from './task-repository';
import type { WorkflowConfig, WorkflowRecord, WorkflowRun, WorkflowSnapshot, WorkflowSpec } from '../shared/contracts';
const git = promisify(execFile);
const activeStates = ['pending', 'running', 'waiting', 'interrupted', 'queued'];
interface SecretCodec { encrypt(value: string): Buffer; decrypt(value: Buffer): string }
export class WorkflowRuntime {
  private timer?: NodeJS.Timeout;
  private server?: http.Server;
  private closing = false;
  private ticking = false;
  private lastTick = Date.now();
  private api = { url: '', error: '' };
  constructor(readonly store: WorkflowStore, readonly tasks: TaskRuntime, private codec: SecretCodec, private changed: () => void) {
    store.tasks.transaction(() => {
      for (const run of store.runs()) if (run.status === 'queued' || run.status === 'running' || (run.status === 'pending' && run.taskId)) { run.status = 'interrupted'; run.note = '应用退出后暂停；请继续原运行，已完成步骤不会重复执行。'; store.putRun(run); }
    });
  }
  read(): WorkflowSnapshot {
    const runs = this.store.runs().map(run => {
      if (run.taskId) {
        const status = this.store.tasks.get(run.taskId).status;
        if (!(['interrupted', 'queued'].includes(run.status) && status === 'pending')) run.status = status;
      }
      return run;
    });
    return { workflows: this.store.all().filter(item => !item.removed), runs, api: this.api };
  }
  save(id: string, version: number, spec: WorkflowSpec, requestId: string): string { const result = this.store.save(id, version, spec, requestId); this.changed(); return result; }
  configure(id: string, version: number, config: WorkflowConfig, requestId: string): void {
    if (config.enabled) this.tasks.prepareWorkflow({ ...this.store.get(id), config }, 'configuration-check', config.prompt);
    this.store.configure(id, version, config, requestId); this.changed();
  }
  restore(id: string, version: number, target: number, requestId: string): void { this.store.restore(id, version, target, requestId); this.changed(); }
  remove(id: string, requestId: string): void {
    if (this.read().runs.some(run => run.workflowId === id && activeStates.includes(run.status))) throw new Error('请先处理或停止该工作流的运行');
    this.store.remove(id, requestId); this.changed();
  }
  restoreRemoved(requestId: string): void { this.store.restoreRemoved(requestId); this.changed(); }
  private enqueue(flow: WorkflowRecord, text: string, origin: string, occurrence: string, missed = false): string {
    const previous = this.store.runs(flow.id).find(run => run.occurrence === occurrence); if (previous) return previous.id;
    const busy = this.read().runs.some(run => run.workflowId === flow.id && activeStates.includes(run.status));
    const run: WorkflowRun = { id: crypto.randomUUID(), workflowId: flow.id, name: flow.name, version: flow.version, created: now(), origin, occurrence, status: missed ? 'missed' : busy && flow.config.concurrency === 'skip' ? 'skipped' : busy ? 'queued' : 'pending', taskId: '', note: missed ? '应用退出或休眠期间错过触发；尚未调用模型，可手动补跑一次。' : busy ? flow.config.concurrency === 'skip' ? '已有未完成运行，本次跳过。' : '已固定全部步骤与资源快照，等待前次运行结束。' : '', resumed: false, snapshot: workflowVersion(flow, '运行时配置快照'), input: text };
    if (!['missed', 'skipped'].includes(run.status)) {
      const task = this.tasks.prepareWorkflow(flow, run.id, text); this.store.tasks.put(task); run.taskId = task.id;
    }
    this.store.putRun(run); return run.id;
  }
  run(id: string, text: string, requestId: string, origin = '手动', occurrence = `manual:${requestId}`): string {
    required(text, '本次任务要求', 10000);
    const runId = this.store.tasks.command(requestId, { op: 'workflow-run', id, text, origin, occurrence }, () => this.enqueue(this.store.get(id), text, origin, occurrence));
    const run = this.store.run(runId); if (run.taskId && run.status === 'pending') this.tasks.launchPrepared(run.taskId);
    this.changed(); return runId;
  }
  resume(id: string, requestId: string): void {
    const taskId = this.store.tasks.command(requestId, { op: 'workflow-resume', id }, () => {
      const run = this.store.run(id);
      if (run.status === 'missed' || (run.status === 'failed' && !run.taskId)) {
        if (run.resumed) throw new Error('该漏执行已补跑');
        const original = this.store.get(run.workflowId), flow = { ...original, ...run.snapshot.spec, version: run.version, config: run.snapshot.config };
        if (this.read().runs.some(item => item.workflowId === flow.id && activeStates.includes(item.status))) throw new Error('请先完成当前运行再补跑');
        const task = this.tasks.prepareWorkflow(flow, run.id, run.input); this.store.tasks.put(task); run.taskId = task.id; run.resumed = true; run.note = '用户补跑漏执行，沿用漏执行时的版本配置。';
      } else if (!['interrupted', 'failed', 'pending', 'queued'].includes(this.read().runs.find(item => item.id === id)!.status)) throw new Error('当前运行无需继续');
      if (this.read().runs.some(item => item.id !== id && item.workflowId === run.workflowId && ['running', 'waiting', 'interrupted'].includes(item.status))) throw new Error('请先处理前次运行');
      run.status = 'pending'; this.store.putRun(run); return run.taskId;
    });
    const status = this.store.tasks.get(taskId).status;
    if (['pending', 'interrupted', 'failed'].includes(status)) this.tasks.resume(taskId, `workflow-task:${requestId}`);
    this.changed();
  }
  cancel(id: string, requestId: string): void {
    const run = this.store.run(id);
    if (run.taskId) this.tasks.cancel(run.taskId, requestId);
    else this.store.tasks.command(requestId, { op: 'workflow-cancel', id }, () => { run.status = 'stopped'; run.note = '用户取消漏执行；不调用模型。'; this.store.putRun(run); return null; });
    this.changed();
  }
  synchronize(): void {
    if (this.closing) return;
    const snapshot = this.read();
    for (const view of snapshot.runs) {
      const run = this.store.run(view.id);
      if (run.status !== view.status) { run.status = view.status; this.store.putRun(run); }
    }
    for (const flow of snapshot.workflows) {
      const runs = this.read().runs.filter(run => run.workflowId === flow.id);
      if (runs.some(run => ['running', 'waiting', 'interrupted', 'pending'].includes(run.status))) continue;
      const next = runs.filter(run => run.status === 'queued').at(-1);
      if (next) { next.status = 'pending'; this.store.putRun(next); this.tasks.launchPrepared(next.taskId); }
    }
    this.changed();
  }
  async start(): Promise<void> {
    await this.tick(Date.now(), true);
    this.timer = setInterval(() => { void this.tick().catch(error => { this.api.error = String(error).slice(0, 300); this.changed(); }); }, 1000);
    this.server = http.createServer((request, response) => { void this.receive(request, response); });
    this.server.on('error', error => { this.api.error = error.message; this.changed(); });
    await new Promise<void>(resolve => { this.server!.listen(0, '127.0.0.1', () => { const address = this.server!.address(); if (address && typeof address !== 'string') this.api.url = `http://127.0.0.1:${address.port}`; resolve(); }); this.server!.once('error', resolve); });
    this.changed();
  }
  async tick(at = Date.now(), startup = false): Promise<void> {
    if (this.closing || this.ticking) return;
    this.ticking = true;
    const missed = startup || at - this.lastTick > 60_000; this.lastTick = at;
    try {
      for (const flow of this.store.all().filter(item => !item.removed && item.config.enabled)) {
        for (const trigger of flow.config.triggers) {
          try {
            if (trigger.type === 'timer' && trigger.nextAt && trigger.nextAt <= at) {
              const due = trigger.nextAt;
              this.store.tasks.transaction(() => {
                trigger.nextAt = nextScheduled(trigger, at); this.store.put(flow);
                try { this.enqueue(flow, flow.config.prompt, '定时', `timer:${trigger.id}:${due}`, missed); }
                catch (error) { trigger.error = error instanceof Error ? error.message : String(error); this.store.put(flow); this.recordFailure(flow, `timer:${trigger.id}:${due}`, '定时', trigger.error); }
              });
            } else if (trigger.type === 'event') {
              const result = await git('git', ['-C', flow.config.directory, 'rev-parse', '--verify', `refs/heads/${trigger.branch}`], { timeout: 3000, maxBuffer: 4096 });
              if (this.closing) return;
              // The config may have changed while Git was being read.
              const current = this.store.get(flow.id); if (current.version !== flow.version || !current.config.enabled) continue;
              const commit = result.stdout.trim(); if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('Git 未返回有效提交');
              if (commit !== trigger.lastCommit) this.store.tasks.transaction(() => {
                const previous = trigger.lastCommit; trigger.lastCommit = commit; trigger.error = ''; this.store.put(flow);
                if (previous) { try { this.enqueue(flow, flow.config.prompt, `Git 本地提交 ${trigger.branch} ${commit}`, `git:${trigger.id}:${commit}`, missed); } catch (error) { this.recordFailure(flow, `git:${trigger.id}:${commit}`, 'Git 提交', String(error)); } }
              });
            }
          } catch (error) { if (!this.closing) { trigger.error = error instanceof Error ? error.message : String(error); this.store.put(flow); } }
        }
      }
      if (this.closing) return;
      this.synchronize();
      for (const run of this.read().runs.filter(item => item.status === 'running')) {
        const task = this.store.tasks.get(run.taskId), began = task.events.filter(item => item.kind === 'start').at(-1)?.at;
        if (began && at - Date.parse(began) > run.snapshot.config.timeout * 60_000) { this.tasks.cancel(task.id, `workflow-timeout:${run.id}:${began}`); run.note = '达到本轮运行超时，任务已停止。'; run.status = 'stopped'; this.store.putRun(run); }
      }
    } finally { this.ticking = false; }
    for (const run of this.store.runs().filter(item => item.status === 'pending' && item.taskId)) this.tasks.launchPrepared(run.taskId);
  }
  private recordFailure(flow: WorkflowRecord, occurrence: string, origin: string, note: string): void {
    if (this.store.runs(flow.id).some(item => item.occurrence === occurrence)) return;
    this.store.putRun({ id: crypto.randomUUID(), workflowId: flow.id, name: flow.name, version: flow.version, created: now(), origin, occurrence, status: 'failed', taskId: '', note: note.slice(0, 1200), resumed: false, snapshot: workflowVersion(flow, '触发失败时配置'), input: flow.config.prompt });
  }
  apiToken(id: string): string {
    this.store.get(id);
    let encrypted = this.store.token(id);
    if (!encrypted) { this.store.putToken(id, this.codec.encrypt(crypto.randomBytes(32).toString('hex'))); encrypted = this.store.token(id); }
    return this.codec.decrypt(encrypted!);
  }
  private async receive(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const reply = (status: number, value: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
    try {
      if (this.closing || request.method !== 'POST' || request.headers.origin || request.headers.host !== this.api.url.replace('http://', '')) return reply(403, { error: '仅允许本机脚本 POST 调用' });
      const match = /^\/workflows\/([a-f0-9-]{36})\/([A-Za-z0-9_-]{1,64})$/.exec(request.url ?? '');
      const flow = match && this.store.all().find(item => item.id === match[1] && !item.removed && item.config.enabled && item.config.triggers.some(trigger => trigger.type === 'api' && trigger.apiName === match[2]));
      if (!flow) return reply(404, { error: '触发入口未启用' });
      const token = this.store.token(flow.id), bearer = request.headers.authorization?.replace(/^Bearer /, '');
      if (!token || !bearer || !/^[a-f0-9]{64}$/.test(bearer) || !crypto.timingSafeEqual(Buffer.from(bearer), Buffer.from(this.codec.decrypt(token)))) return reply(401, { error: '认证失败' });
      const key = request.headers['idempotency-key']; if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(key)) return reply(400, { error: '需要 Idempotency-Key，1–80 位字母数字或连字符' });
      const chunks: Buffer[] = []; let bytes = 0; request.setTimeout(5000, () => request.destroy());
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 48_000) { reply(413, { error: '请求过大' }); request.destroy(); return; } chunks.push(Buffer.from(chunk)); }
      if (this.closing) return reply(503, { error: '应用正在退出' });
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const runId = this.run(flow.id, required(input.input ?? flow.config.prompt, '任务要求', 10000), `api:${crypto.createHash('sha256').update(flow.id + ':' + key).digest('hex')}`, 'API', `api:${key}`);
      reply(202, { runId, taskId: this.store.run(runId).taskId, status: this.read().runs.find(run => run.id === runId)?.status });
    } catch { reply(400, { error: '请求无效或幂等键已用于其他内容' }); }
  }
  close(): void { this.closing = true; if (this.timer) clearInterval(this.timer); this.server?.close(); this.server?.closeAllConnections(); }
}
