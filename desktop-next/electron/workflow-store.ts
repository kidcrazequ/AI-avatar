import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TaskRepository, required, now } from './task-repository';
import { ExpertLibrary } from './expert-library';
import type { AutomationInput, WorkflowConfig, WorkflowRecord, WorkflowRun, WorkflowSpec, WorkflowTrigger, WorkflowVersion } from '../shared/contracts';

import { localTimezone, nextScheduled } from '../shared/schedule';
export { localTimezone, nextScheduled } from '../shared/schedule';
export const defaultWorkflowConfig = (): WorkflowConfig => ({ directory: '', projectId: '', model: 'Auto', timeout: 30, concurrency: 'skip', prompt: '', enabled: false, triggers: [] });
export const workflowVersion = (flow: WorkflowRecord, reason: string): WorkflowVersion => ({ version: flow.version, at: now(), reason, spec: { name: flow.name, description: flow.description, steps: structuredClone(flow.steps) }, config: structuredClone(flow.config), ...(flow.automation ? { automation: structuredClone(flow.automation) } : {}) });
export class WorkflowStore {
  constructor(readonly tasks: TaskRepository, private library: ExpertLibrary) {
    tasks.transaction(db => db.exec(`CREATE TABLE IF NOT EXISTS workflows_v3(id TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workflow_runs_v3(id TEXT PRIMARY KEY,workflow_id TEXT NOT NULL,occurrence TEXT NOT NULL,value TEXT NOT NULL,UNIQUE(workflow_id,occurrence));
      CREATE TABLE IF NOT EXISTS workflow_api_tokens_v3(id TEXT PRIMARY KEY,value BLOB NOT NULL);`));
  }
  all(): WorkflowRecord[] { return this.tasks.transaction(db => (db.prepare('SELECT value FROM workflows_v3 ORDER BY rowid DESC').all() as { value: string }[]).map(row => JSON.parse(row.value))); }
  get(id: string): WorkflowRecord { const flow = this.all().find(item => item.id === id && !item.removed); if (!flow) throw new Error('工作流不存在'); return flow; }
  put(flow: WorkflowRecord): void { this.tasks.transaction(db => db.prepare('INSERT INTO workflows_v3 VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(flow.id, JSON.stringify(flow))); }
  runs(id = ''): WorkflowRun[] { return this.tasks.transaction(db => (db.prepare(`SELECT value FROM workflow_runs_v3 ${id ? 'WHERE workflow_id=?' : ''} ORDER BY rowid DESC`).all(...(id ? [id] : [])) as { value: string }[]).map(row => JSON.parse(row.value))); }
  run(id: string): WorkflowRun { const run = this.runs().find(item => item.id === id); if (!run) throw new Error('运行记录不存在'); return run; }
  putRun(run: WorkflowRun): void { this.tasks.transaction(db => db.prepare('INSERT INTO workflow_runs_v3 VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(run.id, run.workflowId, run.occurrence, JSON.stringify(run))); }
  token(id: string): Buffer | undefined { return this.tasks.transaction(db => (db.prepare('SELECT value FROM workflow_api_tokens_v3 WHERE id=?').get(id) as { value: Buffer } | undefined)?.value); }
  putToken(id: string, value: Buffer): void { this.tasks.transaction(db => db.prepare('INSERT OR IGNORE INTO workflow_api_tokens_v3 VALUES (?,?)').run(id, value)); }
  private spec(input: WorkflowSpec): WorkflowSpec {
    const name = required(input?.name, '工作流名称', 80).trim(), description = required(input.description, '描述', 10000, true);
    if (!Array.isArray(input.steps) || input.steps.length > 8) throw new Error('最多配置 8 个专家步骤');
    const steps = input.steps.map((step, index) => {
      const expert = this.library.detail(required(step?.expert, `步骤 ${index + 1} 专家`, 200));
      if (!expert.installed || expert.draft) throw new Error(`步骤 ${index + 1} 需要已安装的完整专家`);
      return { expert: expert.id, prompt: required(step.prompt, `步骤 ${index + 1} 的任务要求`, 4000).trim() };
    });
    return { name, description, steps };
  }
  private checked(id: string, version: number): WorkflowRecord { const flow = this.get(id); if (flow.version !== version) throw new Error('配置已被其他窗口更新，请刷新后重试'); return flow; }
  resolve(flow: WorkflowRecord): WorkflowRecord {
    if (flow.automation?.kind !== 'workflow') return flow;
    const target = this.get(flow.automation.targetId);
    if (target.automation || !target.steps.length) throw new Error('请选择配置完整步骤的工作流');
    return { ...flow, steps: structuredClone(target.steps), automation: { ...flow.automation, targetVersion: target.version }, config: { ...flow.config, directory: target.config.directory, projectId: target.config.projectId, model: target.config.model, timeout: target.config.timeout, prompt: `执行工作流：${target.name}` } };
  }
  saveAutomation(id: string, version: number, input: AutomationInput, requestId: string): string {
    return this.tasks.command(requestId, { op: 'automation-save', id, version, input }, () => {
      if (!['expert', 'workflow'].includes(input?.executor?.kind)) throw new Error('执行方式无效');
      const name = required(input.name, '自动任务名称', 80).trim(), targetId = required(input.executor.targetId, '执行对象', 200);
      const flow: WorkflowRecord = id ? this.checked(id, version) : { id: crypto.randomUUID(), version: 0, name, description: '', steps: [], config: defaultWorkflowConfig(), created: now(), updated: now(), removed: false, versions: [] };
      if (id && !flow.automation) throw new Error('请从工作流详情编辑旧版触发配置');
      flow.name = name; flow.automation = { kind: input.executor.kind, targetId };
      flow.steps = input.executor.kind === 'expert' ? this.spec({ name, description: '', steps: [{ expert: targetId, prompt: '完成本次自动任务要求。' }] }).steps : this.resolve(flow).steps;
      flow.config = this.config(flow, input.config);
      if (!flow.config.triggers.length) throw new Error('请至少配置一个触发方式');
      if (flow.automation.kind === 'workflow') flow.config.prompt = this.resolve(flow).config.prompt;
      if (flow.automation.kind === 'expert' && !flow.config.prompt.trim()) throw new Error('请输入执行指令');
      flow.description = flow.automation.kind === 'expert' ? flow.config.prompt : '';
      flow.version++; flow.updated = now(); flow.versions.unshift(workflowVersion(flow, '保存自动任务')); this.put(flow); return flow.id;
    });
  }
  save(id: string, version: number, input: WorkflowSpec, requestId: string): string {
    return this.tasks.command(requestId, { op: 'workflow-save', id, version, input }, () => {
      const spec = this.spec(input);
      const flow: WorkflowRecord = id ? this.checked(id, version) : { ...spec, id: crypto.randomUUID(), version: 0, created: now(), updated: now(), removed: false, config: defaultWorkflowConfig(), versions: [] };
      Object.assign(flow, spec); if (!spec.steps.length) flow.config.enabled = false; flow.version++; flow.updated = now(); flow.versions.unshift(workflowVersion(flow, '保存专家步骤')); this.put(flow); return flow.id;
    });
  }
  private config(flow: WorkflowRecord, input: WorkflowConfig): WorkflowConfig {
      required(input?.directory, '工作目录', 2000, true); required(input.projectId, '项目', 200, true); required(input.model, '模型', 200); required(input.prompt, '自动任务要求', 10000, true);
      if (input.directory && (!path.isAbsolute(input.directory) || fs.lstatSync(input.directory).isSymbolicLink() || !fs.statSync(input.directory).isDirectory())) throw new Error('请选择存在的本地工作目录');
      if (!Number.isInteger(input.timeout) || input.timeout < 1 || input.timeout > 240 || !['skip', 'queue'].includes(input.concurrency) || typeof input.enabled !== 'boolean') throw new Error('运行配置无效');
      if (!Array.isArray(input.triggers) || input.triggers.length > 5) throw new Error('最多添加 5 个触发方式');
      if (!Number.isInteger(input.maxRuns ?? 0) || (input.maxRuns ?? 0) < 0 || (input.maxRuns ?? 0) > 100000) throw new Error('最大运行次数应为0至100000的整数');
      if (input.until && (!/^\d{4}-\d{2}-\d{2}$/.test(input.until) || !Number.isFinite(Date.parse(`${input.until}T00:00:00Z`)) || new Date(`${input.until}T00:00:00Z`).toISOString().slice(0, 10) !== input.until)) throw new Error('截止日期无效');
      const ids = new Set<string>();
      const triggers = input.triggers.map(tr => {
        required(tr?.id, '触发 ID', 100); if (ids.has(tr.id)) throw new Error('触发 ID 重复'); ids.add(tr.id);
        if (!['timer', 'event', 'api'].includes(tr.type)) throw new Error('触发类型无效');
        const result: WorkflowTrigger = { id: tr.id, type: tr.type, schedule: tr.schedule, repeat: tr.repeat, at: tr.at, time: tr.time, weekday: tr.weekday, day: tr.day, branch: tr.branch, apiName: tr.apiName, cron: tr.cron, timezone: localTimezone(), nextAt: null, lastCommit: '', error: '' };
        if (tr.type === 'timer') {
          if (!['once', 'repeat'].includes(tr.schedule)) throw new Error('定时模式无效');
          if (tr.schedule === 'once') { if (!Number.isFinite(Date.parse(tr.at)) || (input.enabled && Date.parse(tr.at) <= Date.now())) throw new Error('一次性触发需要未来的有效时间'); result.nextAt = Date.parse(tr.at); }
          else { if (!['hourly', 'daily', 'weekly', 'monthly', 'cron'].includes(tr.repeat) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(tr.time) || !Number.isInteger(tr.weekday) || tr.weekday < 0 || tr.weekday > 6 || !Number.isInteger(tr.day) || tr.day < 1 || tr.day > 31) throw new Error('重复时间无效'); result.nextAt = nextScheduled(result, Date.now()); }
        }
        if (tr.type === 'event') { if (!input.directory || !/^[A-Za-z0-9][A-Za-z0-9_./-]{0,199}$/.test(tr.branch) || tr.branch.includes('..') || tr.branch.includes('//') || tr.branch.endsWith('.lock')) throw new Error('Git 触发需要本地仓库目录和有效分支'); }
        if (tr.type === 'api' && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(tr.apiName)) throw new Error('API 名称应为字母、数字、下划线或连字符');
        const old = flow.config.triggers.find(item => item.id === tr.id);
        if (flow.config.enabled && input.enabled && old && old.type === result.type && flow.config.directory === input.directory && ['schedule', 'repeat', 'cron', 'at', 'time', 'weekday', 'day', 'branch'].every(key => old[key as keyof WorkflowTrigger] === result[key as keyof WorkflowTrigger])) { result.nextAt = old.nextAt; result.lastCommit = old.lastCommit; }
        return result;
      });
      if (input.enabled && (!flow.steps.length || flow.automation?.kind !== 'workflow' && !input.prompt.trim() || !triggers.length)) throw new Error('启用前请配置专家步骤、自动任务要求和触发方式');
      return { directory: input.directory, projectId: input.projectId, model: input.model, timeout: input.timeout, concurrency: input.concurrency, prompt: input.prompt, enabled: input.enabled, triggers, maxRuns: input.maxRuns ?? 0, until: input.until ?? '' };
  }
  configure(id: string, version: number, input: WorkflowConfig, requestId: string): void {
    this.tasks.command(requestId, { op: 'workflow-configure', id, version, input }, () => {
      const flow = this.checked(id, version);
      flow.config = this.config(flow, input);
      flow.version++; flow.updated = now(); flow.versions.unshift(workflowVersion(flow, '保存运行与触发配置')); this.put(flow); return null;
    });
  }
  restore(id: string, version: number, target: number, requestId: string): void {
    this.tasks.command(requestId, { op: 'workflow-restore', id, version, target }, () => {
      const flow = this.checked(id, version), saved = flow.versions.find(item => item.version === target);
      if (!saved) throw new Error('版本不存在');
      Object.assign(flow, this.spec(saved.spec)); flow.config = structuredClone(saved.config); flow.config.enabled = false;
      flow.automation = saved.automation ? structuredClone(saved.automation) : undefined;
      for (const trigger of flow.config.triggers) { trigger.lastCommit = ''; trigger.nextAt = trigger.type === 'timer' ? nextScheduled(trigger, Date.now()) : null; }
      flow.version++; flow.updated = now(); flow.versions.unshift(workflowVersion(flow, `恢复 v${target}，自动触发已停用`)); this.put(flow); return null;
    });
  }
  remove(id: string, requestId: string): void { this.tasks.command(requestId, { op: 'workflow-remove', id }, () => { const flow = this.get(id); flow.removed = true; flow.config.enabled = false; this.put(flow); return null; }); }
  restoreRemoved(requestId: string, automationOnly: boolean | 'resources' = false): void { this.tasks.command(requestId, { op: 'workflow-restore-removed', automationOnly }, () => { for (const flow of this.all().filter(item => item.removed && (automationOnly === 'resources' ? !item.automation : !automationOnly || item.automation || item.config.triggers.length))) { flow.removed = false; flow.config.enabled = false; this.put(flow); } return null; }); }
}
