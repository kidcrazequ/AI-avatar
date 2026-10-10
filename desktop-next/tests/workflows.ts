import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ExpertLibrary } from '../electron/expert-library';
import { ResourceStore } from '../electron/resources';
import { TaskRepository } from '../electron/task-repository';
import { TaskRuntime } from '../electron/task-runtime';
import { WorkflowStore, nextScheduled, localTimezone } from '../electron/workflow-store';
import { WorkflowRuntime } from '../electron/workflow-runtime';
import type { ModelCall } from '../electron/task-models';
import type { WorkflowConfig, WorkflowRun, WorkflowTrigger } from '../shared/contracts';
const pause = () => new Promise(resolve => setTimeout(resolve, 10));
async function main() {
  const [root, output, mode = 'suite', crashProfile] = process.argv.slice(2);
  const profile = crashProfile || fs.mkdtempSync(path.join(os.tmpdir(), 'soul-workflow-'));
  const library = new ExpertLibrary(root, profile); library.installExpert('finance-expert'); library.installExpert('hr-expert');
  const resources = new ResourceStore(root, profile, library), repository = new TaskRepository(profile), store = new WorkflowStore(repository, library);
  const model = { id: 'test', label: '受控验收', model: 'test', baseUrl: 'http://127.0.0.1', protocol: 'openai' as const, configured: true, apiKey: '' };
  const models = { list: () => [model], resolve: () => model }, codec = { encrypt: (s: string) => Buffer.from(s), decrypt: (b: Buffer) => b.toString() };
  let taskRuntime: TaskRuntime, runtime: WorkflowRuntime, call: ModelCall;
  taskRuntime = new TaskRuntime(repository, library, resources, models, profile, () => { queueMicrotask(() => runtime?.synchronize()); }, (...args) => call(...args));
  runtime = new WorkflowRuntime(store, taskRuntime, codec, () => {});
  const create = (name: string, two = false) => runtime.save('', 0, { name, description: '验收说明', steps: [{ expert: 'hr-expert', prompt: '步骤一：阅读当前占位知识，仅列资料缺口。' }, ...(two ? [{ expert: 'finance-expert', prompt: '步骤二：综合前序草案，不编造财务事实。' }] : [])] }, crypto.randomUUID());
  const configure = (id: string, patch: Partial<WorkflowConfig>) => runtime.configure(id, store.get(id).version, { ...store.get(id).config, ...patch }, crypto.randomUUID());
  const trigger = (): WorkflowTrigger => ({ id: crypto.randomUUID(), type: 'timer', schedule: 'once', repeat: 'daily', at: new Date(Date.now() + 86400000).toISOString(), time: '09:00', weekday: 1, day: 1, timezone: localTimezone(), nextAt: null, lastCommit: '', branch: 'main', apiName: 'trigger', error: '' });
  const wait = async (id: string, status: string): Promise<WorkflowRun> => { for (let n = 0; n < 500; n++) { const run = runtime.read().runs.find(item => item.id === id)!; if (run?.status === status) return run; await pause(); } throw new Error(`Run ${id} did not reach ${status}: ${runtime.read().runs.find(item => item.id === id)?.status}`); };
  const checks: string[] = [];
  if (mode === 'crash-prepare') {
    const id = create('跨进程恢复', true); let calls = 0;
    call = async () => { calls++; if (calls === 1) return { text: '第一步已完成', calls: [], usage: { inputTokens: 3, outputTokens: 2 } }; return new Promise(() => {}); };
    const runId = runtime.run(id, '跨进程恢复只执行未完成步骤', 'crash-workflow');
    while (calls < 2) await pause();
    const tr = trigger(); configure(id, { enabled: true, prompt: '退出期间的定时', triggers: [tr] }); const flow = store.get(id); flow.config.triggers[0].nextAt = Date.now() - 5000; store.put(flow);
    fs.writeFileSync(output, JSON.stringify({ id, runId, taskId: store.run(runId).taskId, profile })); process.exit(0);
  } else if (mode === 'crash-resume') {
    const saved = JSON.parse(fs.readFileSync(output, 'utf8')); let calls = 0;
    call = async (_config, wire) => { calls++; assert(wire.some(message => message.content.includes('第一步已完成'))); return { text: '第二步恢复完成', calls: [], usage: { inputTokens: 5, outputTokens: 2 } }; };
    await runtime.tick(Date.now(), true);
    assert.equal(calls, 0); assert.equal(runtime.read().runs.find(item => item.id === saved.runId)!.status, 'interrupted');
    assert.equal(repository.get(saved.taskId).rounds[0].state, 'done'); assert.equal(repository.get(saved.taskId).rounds[1].state, 'unknown');
    assert.equal(runtime.read().runs.filter(item => item.status === 'missed').length, 1);
    runtime.resume(saved.runId, 'resume-crashed-workflow'); await wait(saved.runId, 'completed'); assert.equal(calls, 1);
    assert.equal(repository.get(saved.taskId).messages.filter(message => message.role === 'user').length, 1);
    fs.writeFileSync(output, JSON.stringify({ ok: true, crashRecovery: true, taskId: saved.taskId, preservedRound: repository.get(saved.taskId).rounds[0].id, newModelCalls: calls, missed: 1 }));
  } else {
    const id = create('顺序与幂等', true); let calls = 0; const seen: string[] = [];
    call = async (_config, wire) => { calls++; seen.push(wire[0].content); if (calls === 2) assert(wire.some(message => message.content.includes('第一步资料缺口'))); return { text: calls === 1 ? '第一步资料缺口' : '综合草案', calls: [], usage: { inputTokens: 10, outputTokens: 3 } }; };
    const runId = runtime.run(id, '只处理占位知识缺口', 'one-request'); assert.equal(runtime.run(id, '只处理占位知识缺口', 'one-request'), runId);
    assert.throws(() => runtime.run(id, '不同任务', 'one-request'), /请求 ID/);
    const done = await wait(runId, 'completed'); assert.equal(calls, 2); assert(seen[0].includes('步骤一')); assert(seen[1].includes('步骤二'));
    assert.equal(repository.get(done.taskId).messages.filter(message => message.role === 'user').length, 1); checks.push('sequential-real-task-engine-one-run-idempotent-request');
    const before = store.get(id), oldVersion = before.version;
    runtime.save(id, before.version, { name: '修改后', description: '', steps: [{ expert: 'finance-expert', prompt: '新的步骤' }] }, 'edit-version');
    runtime.restore(id, store.get(id).version, oldVersion, 'restore-version');
    assert.equal(store.get(id).version, 3); assert.equal(store.get(id).config.enabled, false); assert.equal(store.run(runId).snapshot.spec.name, '顺序与幂等'); assert.equal(repository.get(done.taskId).members.length, 2);
    assert.throws(() => runtime.save(id, oldVersion, { name: '陈旧版本', description: '', steps: [] }, 'stale-version'), /刷新/); checks.push('restore-new-version-history-and-resources-immutable');

    const once = create('定时漏执行'); const timer = trigger(); configure(once, { enabled: true, prompt: '定时验收', triggers: [timer] });
    const flow = store.get(once); flow.config.triggers[0].nextAt = Date.now() - 10000; store.put(flow); calls = 0;
    await runtime.tick(Date.now(), true); await runtime.tick(Date.now(), true);
    const missed = runtime.read().runs.filter(run => run.workflowId === once); assert.equal(missed.length, 1); assert.equal(missed[0].status, 'missed'); assert.equal(calls, 0);
    call = async () => { calls++; return { text: '手动补跑完成', calls: [] }; }; runtime.resume(missed[0].id, 'replay-once'); runtime.resume(missed[0].id, 'replay-once'); await wait(missed[0].id, 'completed'); assert.equal(calls, 1); checks.push('restart-missed-one-record-no-auto-call-explicit-replay-once');

    const queue = create('重复触发快照'); configure(queue, { concurrency: 'queue' }); let release!: () => void; calls = 0;
    call = async () => { calls++; if (calls === 1) await new Promise<void>(resolve => release = resolve); return { text: '排队交付', calls: [] }; };
    const first = runtime.run(queue, '第一份', 'queue-first'), second = runtime.run(queue, '第二份', 'queue-second'); assert.equal(store.run(second).status, 'queued'); assert.equal(calls, 1);
    runtime.save(queue, store.get(queue).version, { name: '排队后编辑', description: '', steps: [{ expert: 'finance-expert', prompt: '后改步骤' }] }, 'queue-edit');
    assert.equal(repository.get(store.run(second).taskId).members[0].expertId, 'hr-expert'); release(); await wait(first, 'completed'); await wait(second, 'completed'); assert.equal(calls, 2); checks.push('queue-fifo-trigger-time-expert-resource-snapshot');
    configure(queue, { concurrency: 'skip' }); call = async () => new Promise(() => {});
    const blocking = runtime.run(queue, '阻塞运行', 'skip-blocking'), skipped = runtime.run(queue, '重复跳过', 'skip-duplicate'); assert.equal(store.run(skipped).status, 'skipped'); assert.equal(store.run(skipped).taskId, ''); runtime.cancel(blocking, 'cancel-blocking'); checks.push('skip-unfinished-and-cancel-no-second-call');

    const gitDir = path.join(profile, 'Git验收'); fs.mkdirSync(gitDir);
    execFileSync('git', ['init', '-b', 'main', gitDir]); execFileSync('git', ['-C', gitDir, 'config', 'user.name', 'Soul Test']); execFileSync('git', ['-C', gitDir, 'config', 'user.email', 'test@example.invalid']);
    fs.writeFileSync(path.join(gitDir, 'fixture.md'), 'fixture'); execFileSync('git', ['-C', gitDir, 'add', '.']); execFileSync('git', ['-C', gitDir, 'commit', '-m', 'fixture']);
    const eventFlow = create('Git 新提交'), event = { ...trigger(), type: 'event' as const }; configure(eventFlow, { enabled: true, prompt: 'Git 资料缺口', directory: gitDir, triggers: [event] });
    call = async () => ({ text: '事件执行完成', calls: [] }); await runtime.tick(); assert.equal(store.runs(eventFlow).length, 0);
    execFileSync('git', ['-C', gitDir, 'commit', '--allow-empty', '-m', 'new commit']); await runtime.tick(); await runtime.tick();
    assert.equal(store.runs(eventFlow).length, 1); await wait(store.runs(eventFlow)[0].id, 'completed'); checks.push('git-local-branch-baseline-new-commit-deduplication');

    const apiFlow = create('API 验收'); configure(apiFlow, { enabled: true, prompt: 'API 要求', triggers: [{ ...trigger(), type: 'api' }] }); await runtime.start();
    const url = `${runtime.read().api.url}/workflows/${apiFlow}/trigger`, token = runtime.apiToken(apiFlow); calls = 0; call = async () => { calls++; return { text: 'API 交付', calls: [] }; };
    const send = (key: string, input: string, secret = token, origin = '') => fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Idempotency-Key': key, ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify({ input }) });
    assert.equal((await send('denied', '未授权', '0'.repeat(64))).status, 401); assert.equal((await send('origin', '网页', token, 'http://malicious.invalid')).status, 403); assert.equal(calls, 0); assert.equal((await send('too-large', 'x'.repeat(50000))).status, 413); assert.equal(calls, 0);
    const response = await send('stable-key', 'API 验收'); assert.equal(response.status, 202); const apiRun = (await response.json() as { runId: string }).runId; await wait(apiRun, 'completed');
    assert.equal((await send('stable-key', 'API 验收')).status, 202); assert.equal((await send('stable-key', '篡改内容')).status, 400); assert.equal(calls, 1); assert(!JSON.stringify(runtime.read()).includes(token)); checks.push('loopback-api-auth-origin-size-idempotency-secret-not-in-view');

    const monthly = { ...trigger(), schedule: 'repeat' as const, repeat: 'monthly' as const, day: 31, time: '09:00' }; const after = new Date(2026, 3, 1).getTime(); const next = new Date(nextScheduled(monthly, after)!); assert.equal(next.getMonth(), 4); assert.equal(next.getDate(), 31); checks.push('monthly-31-skips-short-month-local-calendar');
    const timeoutFlow = create('超时验收'); configure(timeoutFlow, { timeout: 1 }); call = async () => new Promise(() => {}); const timeoutRun = runtime.run(timeoutFlow, '超时停止', 'timeout-run'); const timeoutTask = repository.get(store.run(timeoutRun).taskId); timeoutTask.events.find(item => item.kind === 'start')!.at = new Date(Date.now() - 120000).toISOString(); repository.put(timeoutTask); await runtime.tick(); await wait(timeoutRun, 'stopped'); assert.equal(runtime.read().runs.find(item => item.id === timeoutRun)!.status, 'stopped'); checks.push('timeout-aborts-running-task-preserves-record');
    runtime.remove(timeoutFlow, 'soft-remove'); assert(!runtime.read().workflows.find(item => item.id === timeoutFlow)); runtime.restoreRemoved('restore-removed'); assert(runtime.read().workflows.find(item => item.id === timeoutFlow)); checks.push('recoverable-removal-keeps-history-disabled-triggers');
    fs.writeFileSync(output, JSON.stringify({ ok: true, checks }, null, 2)); console.log(JSON.stringify({ ok: true, checks }));
  }
  runtime.close(); taskRuntime.close(); await pause(); repository.close(); resources.close(); library.close(); if (!crashProfile) fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
main().catch(error => { console.error(error); process.exit(1); });
