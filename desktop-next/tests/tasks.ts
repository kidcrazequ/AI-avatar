import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { ExpertLibrary } from '../electron/expert-library';
import { ResourceStore } from '../electron/resources';
import { TaskRepository, digest } from '../electron/task-repository';
import { TaskRuntime } from '../electron/task-runtime';
import { safeTaskPath } from '../electron/task-tools';
import type { ModelCall } from '../electron/task-models';
import type { TaskSendInput } from '../shared/contracts';

async function main() {
const [resourcesRoot, output, mode = 'suite', crashProfile] = process.argv.slice(2);
const profile = crashProfile || fs.mkdtempSync(path.join(os.tmpdir(), 'soul-task-tests-'));
const library = new ExpertLibrary(resourcesRoot, profile);
library.installExpert('finance-expert'); library.installExpert('hr-expert');
const resources = new ResourceStore(resourcesRoot, profile, library);
let repository = new TaskRepository(profile);
const model = { id: 'test', label: '受控验收模型', model: 'test', baseUrl: 'http://127.0.0.1', protocol: 'openai' as const, configured: true, apiKey: '' };
const models = { list: () => [model], resolve: () => model };
let runtime: TaskRuntime;
const start = (call: ModelCall) => runtime = new TaskRuntime(repository, library, resources, models, profile, () => {}, call);
const input = (text: string, extra: Partial<TaskSendInput> = {}): TaskSendInput => ({ requestId: crypto.randomUUID(), taskId: '', expertId: 'finance-expert', groupId: '', model: 'Auto', directory: profile, projectId: '', text, attachments: [], ...extra });
const pause = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (id: string, state: string) => { for (let n = 0; n < 400; n++) { if (repository.get(id).status === state) return repository.get(id); await pause(); } throw new Error(`Task did not reach ${state}: ${repository.get(id).status}`); };
const checks: string[] = [];

if (mode === 'crash-prepare') {
  let calls = 0;
  start(async () => { calls++; if (calls === 1) return { text: '', calls: [{ id: 'checkpoint-call', type: 'function', function: { name: 'read_knowledge', arguments: JSON.stringify({ id: 'expert:finance-expert/README.md' }) } }], usage: { inputTokens: 5, outputTokens: 2 } }; return new Promise(() => {}); });
  const id = runtime.send(input('重启恢复验收：保留已完成轮次'));
  for (let n = 0; n < 100 && calls !== 2; n++) await pause();
  assert.equal(calls, 2); assert.equal(repository.get(id).rounds.length, 2);
  fs.writeFileSync(output, JSON.stringify({ taskId: id, profile, state: repository.get(id).status }));
  process.exit(0); // Deliberately skip all close hooks to model process loss.
}
if (mode === 'crash-resume') {
  const { taskId } = JSON.parse(fs.readFileSync(output, 'utf8'));
  const before = repository.get(taskId);
  assert.equal(before.status, 'interrupted'); assert.equal(before.rounds[0].state, 'done'); assert.equal(before.rounds[1].state, 'unknown');
  assert(before.checkpoint.wire.some(message => message.role === 'tool'));
  let calls = 0;
  start(async (_config, messages) => { calls++; assert(messages.some(message => message.role === 'tool')); return { text: '恢复后完成', calls: [], usage: { inputTokens: 3, outputTokens: 2 } }; });
  runtime.resume(taskId, 'resume-after-process-loss');
  const done = await wait(taskId, 'completed'); assert.equal(calls, 1); assert.equal(done.messages.filter(message => message.role === 'user').length, 1);
  fs.writeFileSync(output, JSON.stringify({ ok: true, taskId, crashRecovery: true, preservedRound: done.rounds[0].id, unknownRound: done.rounds[1].id, newCalls: calls }));
} else {
  let release!: () => void, calls = 0;
  start(async () => { calls++; await new Promise<void>(resolve => release = resolve); return { text: '完成', calls: [], usage: { inputTokens: 1, outputTokens: 1 } }; });
  const duplicate = input('同一个客户端请求不得创建重复任务或重复计费');
  const id = runtime.send(duplicate); assert.equal(runtime.send(duplicate), id); assert.equal(calls, 1);
  assert.throws(() => runtime.send({ ...duplicate, text: '不同内容' }), /请求 ID/);
  release(); await wait(id, 'completed'); assert.equal(repository.get(id).messages.filter(message => message.role === 'user').length, 1); checks.push('duplicate-send-single-task-single-model-call');

  calls = 0;
  start(async () => { calls++; return calls === 1 ? { text: '', calls: [], usage: { inputTokens: 10, outputTokens: 0 } } : { text: '内部修复后交付', calls: [], usage: { inputTokens: 20, outputTokens: 4 } }; });
  const repaired = await wait(runtime.send(input('内部修复不能污染用户历史或重复累计用量')), 'completed');
  assert.equal(repaired.messages.filter(message => message.role === 'user').length, 1);
  assert.deepEqual(repaired.rounds.map(round => round.kind), ['normal', 'repair']);
  assert.equal(repaired.rounds.reduce((sum, round) => sum + (round.usage?.inputTokens ?? 0), 0), 30);
  assert.equal(repository.views().find(task => task.id === repaired.id)!.rounds[1].text, ''); checks.push('hidden-repair-one-user-message-actual-round-usage');

  const groupId = 'task-acceptance-group';
  library.saveGroup({ id: groupId, name: '群组执行验收', leader: 'finance-expert', members: [{ expertId: 'finance-expert', model: 'Auto', directory: profile }, { expertId: 'hr-expert', model: 'Auto', directory: profile }] });
  const seen: string[] = [];
  start(async (_config, messages) => { const leader = messages[0].content.includes('财研'); seen.push(leader ? 'leader' : 'member'); if (leader) assert(messages.some(message => message.content.includes('成员专业草案'))); return { text: leader ? 'Leader 综合交付' : '成员专业草案', calls: [] }; });
  const grouped = await wait(runtime.send(input('群组成员实际调用与 Leader 汇总', { groupId })), 'completed');
  assert.deepEqual(grouped.members.map(member => member.expertId), ['hr-expert', 'finance-expert']); assert.equal(seen.length, 2);
  assert.equal(grouped.messages.filter(message => message.role === 'assistant').length, 2); checks.push('group-members-run-before-leader-synthesis');

  start(async (_config, messages) => messages.some(message => message.role === 'tool') ? { text: '成果已写出', calls: [] } : { text: '申请写出成果', calls: [{ id: 'artifact-call', type: 'function', function: { name: 'write_artifact', arguments: JSON.stringify({ file: '审批成果.md', content: '只批准一次的成果' }) } }] });
  const approvalTask = await wait(runtime.send(input('批准前不写文件；重启后继续原审批')), 'waiting');
  const approval = approvalTask.approvals[0]; assert(!fs.existsSync(approval.destination));
  await pause(); runtime.close(); repository.close(); repository = new TaskRepository(profile);
  assert.equal(repository.get(approvalTask.id).status, 'waiting');
  start(async (_config, messages) => { assert(messages.some(message => message.role === 'tool' && message.content.includes('已写入'))); return { text: '重启后完成成果写入', calls: [] }; });
  runtime.approve(approvalTask.id, approval.id, true, '验收批准', 'same-approval-request');
  runtime.approve(approvalTask.id, approval.id, true, '验收批准', 'same-approval-request');
  const approved = await wait(approvalTask.id, 'completed'); assert.equal(approved.artifacts.length, 1); assert.equal(digest(fs.readFileSync(approval.destination, 'utf8')), approval.hash);
  assert.throws(() => runtime.approve(approvalTask.id, approval.id, false, '', 'another-approval-request'), /审批已处理/); checks.push('approval-persisted-before-write-and-restart-safe-idempotent-commit');

  start(async () => ({ text: '申请写入', calls: [{ id: 'reject-write', type: 'function', function: { name: 'write_artifact', arguments: JSON.stringify({ file: '拒绝成果.md', content: '不能写入' }) } }] }));
  const rejected = await wait(runtime.send(input('拒绝审批必须停止且不产生文件')), 'waiting');
  runtime.approve(rejected.id, rejected.approvals[0].id, false, '拒绝', 'reject-request');
  assert.equal(repository.get(rejected.id).status, 'stopped'); assert(!fs.existsSync(rejected.approvals[0].destination)); checks.push('rejected-approval-never-writes-artifact');

  start(async (_config, messages) => {
    const outputs = messages.filter(message => message.role === 'tool').length;
    return outputs < 2 ? { text: '', calls: [{ id: 'reused-provider-id', type: 'function', function: { name: 'write_artifact', arguments: JSON.stringify({ file: `${outputs}.md`, content: `成果${outputs}` }) } }] } : { text: '两次审批独立完成', calls: [] };
  });
  const repeatedId = runtime.send(input('服务商重用工具 ID 不得复用前一轮审批'));
  const firstApproval = (await wait(repeatedId, 'waiting')).approvals[0];
  runtime.approve(repeatedId, firstApproval.id, true, '', 'first-write');
  const secondApproval = (await wait(repeatedId, 'waiting')).approvals[1];
  assert(secondApproval); assert.notEqual(firstApproval.roundId, secondApproval.roundId); assert(!fs.existsSync(secondApproval.destination));
  runtime.approve(repeatedId, secondApproval.id, true, '', 'second-write');
  assert.equal((await wait(repeatedId, 'completed')).artifacts.length, 2); checks.push('provider-tool-id-reuse-requires-new-round-approval');

  calls = 0;
  start(async () => { calls++; return { text: '', calls: [{ id: 'model-change', type: 'function', function: { name: 'write_artifact', arguments: JSON.stringify({ file: '模型变更检查.md', content: '独立模型变更验收' }) } }] }; });
  const changedModel = await wait(runtime.send(input('修改模型配置不能把旧任务请求发往新服务')), 'waiting');
  model.baseUrl = 'http://localhost:12345';
  runtime.approve(changedModel.id, changedModel.approvals[0].id, true, '', 'model-change-approve');
  assert.equal((await wait(changedModel.id, 'failed')).error.includes('模型配置已改变'), true); assert.equal(calls, 1);
  model.baseUrl = 'http://127.0.0.1'; checks.push('changed-model-endpoint-blocks-resumed-model-request');

  let late!: () => void;
  start(async () => { await new Promise<void>(resolve => late = resolve); return { text: '不应出现在已取消任务中', calls: [] }; });
  const cancelledId = runtime.send(input('取消后的迟到回包不得覆盖已停止状态'));
  runtime.cancel(cancelledId, 'cancel-request'); late(); await pause(30);
  assert.equal(repository.get(cancelledId).status, 'stopped'); assert.equal(repository.get(cancelledId).messages.length, 1); checks.push('cancel-rejects-late-model-results');

  for (const unsafe of ['../outside.md', '.env', 'CON.md', 'nested/../outside.md', '/absolute.md']) assert.throws(() => safeTaskPath(profile, unsafe));
  const link = path.join(profile, 'link'); fs.symlinkSync(os.tmpdir(), link, process.platform === 'win32' ? 'junction' : 'dir'); assert.throws(() => safeTaskPath(profile, 'link/outside.md'), /符号链接/); fs.unlinkSync(link); checks.push('project-tools-block-path-traversal-windows-aliases-and-symlinks');

  const task = repository.get(grouped.id), originalHash = task.members[0].knowledge[0].hash;
  resources.saveMemory('hr-expert', '之后修改的独立记忆', resources.read('hr-expert').memory!.revision, '用户偏好');
  assert.equal(repository.get(grouped.id).members[0].knowledge[0].hash, originalHash);
  assert(!repository.get(grouped.id).members[0].system.includes('之后修改的独立记忆')); checks.push('task-resource-snapshots-survive-expert-resource-edits');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ ok: true, platform: process.platform, arch: process.arch, evidence: 'controlled-provider-runtime-tests', checks }, null, 2));
}
runtime!.close(); await pause(); repository.close(); resources.close(); library.close();
if (!crashProfile) fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
console.log(JSON.stringify({ ok: true, mode, checks }));

}
main().catch(error => { console.error(error); process.exitCode = 1; });
