import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import type { ChannelInput, ChannelView, IMEvent, IMSession } from '../shared/integrations';
import type { TaskSendInput } from '../shared/contracts';
import type { TaskRuntime } from './task-runtime';
import type { ExpertLibrary } from './expert-library';
import type { SecretCodec } from './task-models';
import { required, now, digest } from './task-repository';
import { createFeishu, type IMAdapter, type IMFactory, type IncomingIM } from './feishu-adapter';
import { safeTaskPath } from './task-tools';
const uid = () => crypto.randomUUID();
interface Journal extends IMEvent { input?: TaskSendInput }
export class IMRuntime {
  private db: Database.Database;
  private adapters = new Map<string, IMAdapter>();
  private errors = new Map<string, string>();
  private closing = false;
  constructor(profile: string, private codec: SecretCodec, private library: ExpertLibrary, private tasks: TaskRuntime, private changed: () => void, private factory: IMFactory = createFeishu) {
    this.db = new Database(path.join(profile, 'soul.sqlite')); this.db.pragma('synchronous = FULL');
    this.db.exec('CREATE TABLE IF NOT EXISTS im_channels_v3(id TEXT PRIMARY KEY,value TEXT NOT NULL,secret BLOB NOT NULL); CREATE TABLE IF NOT EXISTS im_sessions_v3(id TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS im_events_v3(id TEXT PRIMARY KEY,value TEXT NOT NULL)');
    for (const event of this.events()) if (event.state === 'unknown') { event.error = '上次发送中断，外部结果未知；请先在飞书核对，系统不会自动重发'; this.put(event); }
  }
  private put(event: Journal): void { this.db.prepare('INSERT INTO im_events_v3 VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(event.id, JSON.stringify(event)); }
  channels(): ChannelView[] { return (this.db.prepare('SELECT value FROM im_channels_v3').all() as Array<{ value: string }>).map(row => { const c = JSON.parse(row.value); return { ...c, state: this.errors.has(c.id) ? 'failed' : this.adapters.get(c.id)?.state() ?? 'idle', error: this.errors.get(c.id) ?? '' }; }); }
  sessions(): IMSession[] { return (this.db.prepare('SELECT value FROM im_sessions_v3').all() as Array<{ value: string }>).map(row => JSON.parse(row.value)); }
  events(): Journal[] { return (this.db.prepare('SELECT value FROM im_events_v3 ORDER BY rowid DESC LIMIT 1000').all() as Array<{ value: string }>).map(row => JSON.parse(row.value)); }
  publicEvents(): IMEvent[] { return this.events().map(({ input: _input, ...event }) => event); }
  async start(): Promise<void> { for (const c of this.channels().filter(c => c.enabled)) void this.connect(c.id); for (const event of this.events().filter(e => e.state === 'received')) this.dispatch(event); this.synchronize(); }
  async saveChannel(input: ChannelInput): Promise<void> {
    const id = input.id || uid(), name = required(input.name, '连接名称', 80).trim(), appId = required(input.appId, 'App ID', 200).trim();
    if (!/^cli_[\w]+$/.test(appId) || typeof input.enabled !== 'boolean') throw new Error('飞书 App ID 或开关无效');
    const previous = this.db.prepare('SELECT secret FROM im_channels_v3 WHERE id=?').get(id) as { secret: Buffer } | undefined;
    const secret = required(input.secret, 'App Secret', 4000, true); if (!secret && !previous) throw new Error('请输入 App Secret');
    this.adapters.get(id)?.close(); this.adapters.delete(id); this.errors.delete(id);
    this.db.prepare('INSERT INTO im_channels_v3 VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,secret=excluded.secret').run(id, JSON.stringify({ id, name, appId, enabled: input.enabled }), secret || !previous ? this.codec.encrypt(secret) : previous.secret);
    this.changed(); if (input.enabled) await this.connect(id);
  }
  private async connect(id: string): Promise<void> {
    if (this.closing) return;
    const c = this.channels().find(c => c.id === id); if (!c?.enabled) return;
    const row = this.db.prepare('SELECT secret FROM im_channels_v3 WHERE id=?').get(id) as { secret: Buffer };
    let adapter: IMAdapter | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    try {
      adapter = this.factory(c.appId, this.codec.decrypt(row.secret), () => { if (!this.closing) this.changed(); }); this.adapters.set(id, adapter); this.changed();
      await Promise.race([adapter.start(message => { if (this.closing || this.adapters.get(id) !== adapter) return; try { this.receive(id, message); } catch { this.errors.set(id, '消息处理失败，请核对专家、模型和会话配置'); this.changed(); } }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('连接超时')), 30_000); })]);
    }
    catch { adapter?.close(); if (!this.closing && (!adapter || this.adapters.get(id) === adapter)) { this.errors.set(id, '飞书连接失败，请检查 App ID、密钥、机器人能力和事件长连接设置'); this.changed(); } }
    finally { if (timer) clearTimeout(timer); }
  }
  removeChannel(id: string): void { if (this.sessions().some(s => s.channelId === id)) throw new Error('请先移除该连接的会话'); this.adapters.get(id)?.close(); this.adapters.delete(id); this.errors.delete(id); this.db.prepare('DELETE FROM im_channels_v3 WHERE id=?').run(id); this.changed(); }
  saveSession(input: IMSession): void {
    const id = input.id || uid();
    if (!this.channels().some(c => c.id === input.channelId)) throw new Error('请选择 IM 连接');
    for (const key of ['chatId', 'senderId', 'name', 'expertId', 'model'] as const) required(input[key], key, 200);
    if (!['direct', 'group'].includes(input.type) || typeof input.enabled !== 'boolean') throw new Error('会话类型无效');
    const expert = this.library.detail(input.expertId); if (!expert.installed || expert.draft) throw new Error('请安装完整专家');
    if (input.groupId && !this.library.list().groups.some(g => g.id === input.groupId)) throw new Error('专家组不存在');
    if (input.directory) safeTaskPath(input.directory, 'Soul-Outputs');
    if (this.sessions().some(s => s.id !== id && s.channelId === input.channelId && s.chatId === input.chatId && s.senderId === input.senderId)) throw new Error('这个会话与发送人已配对');
    this.db.prepare('INSERT INTO im_sessions_v3 VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(id, JSON.stringify({ ...input, id })); this.changed();
  }
  removeSession(id: string): void { this.db.prepare('DELETE FROM im_sessions_v3 WHERE id=?').run(id); this.changed(); }
  receive(channelId: string, message: IncomingIM): void {
    const id = digest(channelId + ':' + required(message.messageId, '消息 ID', 200)); if (this.db.prepare('SELECT id FROM im_events_v3 WHERE id=?').get(id)) return;
    for (const key of ['chatId', 'senderId', 'text'] as const) required(message[key], key, key === 'text' ? 10000 : 200);
    const session = this.sessions().find(s => s.enabled && s.channelId === channelId && s.chatId === message.chatId && s.senderId === message.senderId && s.type === message.type);
    const event: Journal = { ...message, id, channelId, state: 'pairing', taskId: '', response: '', receipt: '', error: '', at: now() };
    if (session) { event.state = 'received'; event.input = this.input(event, session); }
    this.put(event); this.changed(); if (session) this.dispatch(event);
  }
  private input(event: Journal, session: IMSession): TaskSendInput { return { requestId: `im-${event.id}`, taskId: '', expertId: session.expertId, groupId: session.groupId, model: session.model, directory: session.directory, projectId: '', attachments: [], text: `[飞书会话 ${session.name} · 消息 ${event.messageId}]\n${event.text}\n\n回复只在 Soul 内生成草稿；外部发送由用户在 IM 页面审批。` }; }
  pair(id: string, session: IMSession | null): void { const event = this.events().find(e => e.id === id); if (!event || event.state !== 'pairing') throw new Error('申请已处理'); if (!session) { event.state = 'rejected'; this.put(event); } else { if (session.channelId !== event.channelId || session.chatId !== event.chatId || session.senderId !== event.senderId || session.type !== event.type) throw new Error('配对目标与申请不一致'); this.saveSession(session); event.state = 'received'; event.input = this.input(event, session); this.put(event); this.dispatch(event); } this.changed(); }
  private dispatch(event: Journal): void {
    if (!event.input || this.closing) return;
    try { event.taskId = this.tasks.send(event.input); event.state = 'running'; } catch { event.state = 'failed'; event.error = '专家任务创建失败，请检查模型和专家配置'; }
    this.put(event); this.changed();
  }
  synchronize(): void {
    if (this.closing) return;
    for (const event of this.events().filter(e => e.state === 'running')) {
      const task = this.tasks.repository.get(event.taskId);
      if (task.status === 'completed') { event.response = task.messages.filter(m => m.role === 'assistant').map(m => m.text).join('\n\n').slice(0, 20000); event.state = 'ready'; this.put(event); this.changed(); }
      if (['failed', 'stopped'].includes(task.status)) { event.state = 'failed'; event.error = task.error || '任务已停止'; this.put(event); this.changed(); }
    }
  }
  async sendReply(id: string): Promise<void> {
    const event = this.events().find(e => e.id === id); if (!event || event.state !== 'ready' || !event.response) throw new Error('回复未就绪或已处理');
    const adapter = this.adapters.get(event.channelId); if (adapter?.state() !== 'connected') throw new Error('飞书尚未连接');
    event.state = 'unknown'; event.error = '正在发送；中断后需人工核对'; this.put(event); this.changed();
    try { const receipt = await adapter.send(event.messageId, event.response, event.id.slice(0, 32)); if (this.closing) return; event.receipt = receipt; event.state = 'sent'; event.error = ''; this.put(event); this.changed(); }
    catch { if (!this.closing) { event.error = '外部发送结果未知，请在飞书核对；不会自动重发'; this.put(event); this.changed(); } }
  }
  close(): void { this.closing = true; for (const adapter of this.adapters.values()) adapter.close(); this.adapters.clear(); this.db.close(); }
}
