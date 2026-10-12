import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { WorkspaceAssistant } from '../electron/workspace-assistant';
import { TaskRepository } from '../electron/task-repository';
import type { ModelCall, ModelCredentials } from '../electron/task-models';
import type { WireMessage } from '../shared/contracts';

async function main() {
  const guide = path.resolve(process.argv[2]), output = path.resolve(process.argv[3]), profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-assistant-'));
  const key = crypto.randomBytes(32), codec = {
    encrypt(value: string) { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv), body = Buffer.concat([cipher.update(value), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), body]); },
    decrypt(bytes: Buffer) { const cipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString(); },
  };
  const tasks = new TaskRepository(profile); tasks.put({ id: 'existing-task', title: '真实状态通知的合成任务', status: 'completed', updated: '2000-01-01', approvals: [], messages: [{ text: 'private-task-content' }], rounds: [], review: { revision: 'existing-review' } } as any);
  const taskBefore = JSON.stringify(tasks.all()), model: ModelCredentials = { id: 'controlled', label: '受控助手', model: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1', configured: true, apiKey: 'secret-must-not-appear' };
  let calls = 0, hold = false, fail = false, tool = false, lastMessages: WireMessage[] = [];
  const call: ModelCall = async (_config, messages, signal, chunk) => {
    calls++; lastMessages = messages;
    chunk('一'); chunk('二'); await new Promise(resolve => setTimeout(resolve, 160)); chunk('三');
    if (hold) await new Promise<void>(resolve => { signal.addEventListener('abort', () => resolve(), { once: true }); });
    if (fail) throw new Error('secret-must-not-appear');
    return { text: '一二三。来源：Soul Next 产品说明，创建与使用专家。', calls: tool ? [{ id: 'attempt', type: 'function', function: { name: 'write_artifact', arguments: '{}' } }] : [], usage: { inputTokens: 10, outputTokens: 20 } };
  };
  const models = { list: () => [model], resolve: (id: string) => { if (id !== model.id) throw new Error('尚未配置模型'); return model; } };
  let runtime = new WorkspaceAssistant(profile, guide, models, tasks, codec, 'fixture-version', undefined, call);
  const checks: string[] = [], check = async (name: string, action: () => void | Promise<void>) => { await action(); checks.push(name); console.log(name); };
  const chat = () => runtime.createChat(crypto.randomUUID()), current = (id: string) => runtime.read().chats.find(item => item.id === id)!;
  const send = (id: string, text: string) => ({ chatId: id, requestId: crypto.randomUUID(), revision: current(id).revision, text, model: model.id });
  const settle = async (id: string) => { for (let i = 0; i < 150; i++) { const item = current(id).turns.at(-1)!; if (item.state !== 'running') return item; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('assistant did not settle'); };
  try {
    await check('opening-or-creating-the-assistant-does-not-call-a-model-or-create-a-task', () => { const id = chat(); runtime.createChat(id); assert.equal(runtime.read().chats.length, 1); assert.equal(calls, 0); assert.equal(JSON.stringify(tasks.all()), taskBefore); });
    const id = chat(), request = send(id, '合成问题：如何创建专家？'); runtime.send(request);
    await check('one-user-submission-is-idempotent-before-and-after-completion', async () => { runtime.send(request); const turn = await settle(id); assert.equal(turn.state, 'done'); runtime.send(request); assert.equal(calls, 1); assert.equal(current(id).turns.length, 1); assert.throws(() => runtime.send({ ...request, text: '其他问题' }), /其他内容/); });
    await check('product-answers-receive-guide-and-own-history-without-task-content-or-credentials', () => { const wire = JSON.stringify(lastMessages); assert(wire.includes('产品说明')); assert(wire.includes('个人IM自动采集与消息代发未接通')); assert(!wire.includes('private-task-content')); assert(!wire.includes(model.apiKey)); assert.equal(current(id).turns[0].usage?.outputTokens, 20); });
    await check('stale-or-unconfigured-requests-cannot-add-turns-or-start-billing', () => { const count = calls; assert.throws(() => runtime.send({ ...send(id, '第二问'), revision: 0 }), /变化/); assert.throws(() => runtime.send({ ...send(id, '第二问'), model: 'missing' }), /配置/); assert.equal(calls, count); assert.equal(current(id).turns.length, 1); });
    await check('rapid-stream-chunks-remain-visible-and-cancellation-is-not-an-auto-retry', async () => { hold = true; const next = chat(); runtime.send(send(next, '合成流式问题')); await new Promise(resolve => setTimeout(resolve, 180)); assert.equal(current(next).turns[0].answer, '一二三'); const count = calls; runtime.cancel(next); await settle(next); assert.equal(current(next).turns[0].state, 'cancelled'); assert.equal(current(next).turns[0].usageUnknown, true); runtime.read(); assert.equal(calls, count); hold = false; });
    await check('model-failure-keeps-one-visible-turn-without-secret-error-or-hidden-repair', async () => { fail = true; const next = chat(); runtime.send(send(next, '合成失败问题')); const turn = await settle(next), count = calls; assert.equal(turn.state, 'failed'); assert(!turn.error.includes(model.apiKey)); runtime.read(); assert.equal(calls, count); assert.equal(current(next).turns.length, 1); fail = false; runtime.send(send(next, '手动的新问题')); await settle(next); assert(!JSON.stringify(lastMessages).includes('合成失败问题')); });
    await check('unexpected-tool-replies-never-execute-and-preserve-known-usage', async () => { tool = true; const next = chat(); runtime.send(send(next, '合成工具门禁问题')); const turn = await settle(next); assert.equal(turn.state, 'failed'); assert.equal(turn.usage?.inputTokens, 10); assert.equal(turn.usageUnknown, false); assert.equal(JSON.stringify(tasks.all()), taskBefore); tool = false; });
    await check('notification-read-is-local-and-does-not-approve-or-review-the-source-task', () => { const notification = runtime.read().notifications[0]; assert(!notification.read); runtime.markRead(notification.id); assert(runtime.read().notifications[0].read); assert.equal(JSON.stringify(tasks.all()), taskBefore); assert.throws(() => runtime.markRead('missing'), /变化/); });
    const feedbackId = crypto.randomUUID(), feedback = { id: feedbackId, text: '合成验收反馈：学习记忆需在页面可见。', email: 'qa@example.invalid', images: [] };
    await check('feedback-is-idempotent-and-truthfully-recorded-locally-with-no-model-transmission', () => { const count = calls; runtime.feedback(feedback); runtime.feedback(feedback); assert.equal(runtime.read().feedback.length, 1); assert.equal(runtime.feedbackRecord(feedbackId).state, 'local'); assert.equal(runtime.feedbackRecord(feedbackId).version, 'fixture-version'); assert.equal(calls, count); assert.throws(() => runtime.feedback({ ...feedback, text: 'other' }), /其他内容/); assert.throws(() => runtime.feedback({ ...feedback, id: crypto.randomUUID(), email: 'bad' }), /邮箱/); assert.throws(() => runtime.feedback({ ...feedback, id: crypto.randomUUID(), images: ['file:/private.png'] }), /PNG/); });
    await check('private-assistant-text-and-feedback-are-encrypted-in-local-storage', () => { const db = new Database(path.join(profile, 'soul.sqlite')); for (const table of ['assistant_chats_v3', 'assistant_feedback_v3']) for (const row of db.prepare('SELECT value FROM '+table).all() as Array<{ value: Buffer }>) { assert(!row.value.includes(Buffer.from('合成'))); assert(!row.value.includes(Buffer.from('qa@example.invalid'))); } db.close(); });
    await check('interrupted-request-recovers-with-unknown-usage-without-replaying-a-model', () => { const recovering = chat(), row = current(recovering); row.turns.push({ id: crypto.randomUUID(), text: '中断样本', answer: '部分内容', model: model.label, at: '2000-01-01', state: 'running', error: '', usageUnknown: true }); const db = new Database(path.join(profile, 'soul.sqlite')); db.prepare('UPDATE assistant_chats_v3 SET value=? WHERE id=?').run(codec.encrypt(JSON.stringify(row)), recovering); db.close(); const count = calls; runtime.close(); runtime = new WorkspaceAssistant(profile, guide, models, tasks, codec, 'fixture-version', undefined, call); assert.equal(current(recovering).turns[0].state, 'failed'); assert(current(recovering).turns[0].usageUnknown); assert.equal(calls, count); });
    await check('restart-keeps-history-feedback-and-read-marks-with-original-tasks-unchanged', () => { const count = calls; runtime.close(); runtime = new WorkspaceAssistant(profile, guide, models, tasks, codec, 'fixture-version', undefined, call); assert.equal(runtime.read().feedback.length, 1); assert(runtime.read().notifications[0].read); assert.equal(current(id).turns[0].state, 'done'); assert.equal(calls, count); assert.equal(JSON.stringify(tasks.all()), taskBefore); });
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify({ ok: true, checks, calls, model: 'controlled', profile }, null, 2));
  } finally { runtime.close(); tasks.close(); fs.rmSync(profile, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
