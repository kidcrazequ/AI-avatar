import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import type { ChannelInput, ChannelView, IMAccessRule, IMEvent, IMParticipant, IMSession } from '../shared/integrations';
import type { TaskSendInput } from '../shared/contracts';
import type { TaskRuntime } from './task-runtime';
import type { ExpertLibrary } from './expert-library';
import type { SecretCodec } from './task-models';
import { required, now, digest } from './task-repository';
import { type IMAdapter, type IMFactory, type IMReplyAddress, type IncomingIM } from './feishu-adapter';
import { createIMAdapter } from './im-adapters';
import { safeTaskPath } from './task-tools';
const uid = () => crypto.randomUUID();
interface Journal extends IMEvent { input?: TaskSendInput; inputs?: TaskSendInput[] }
export class IMRuntime {
  private db: Database.Database;
  private adapters = new Map<string, IMAdapter>();
  private errors = new Map<string, string>();
  private closing = false;
  private sending = 0;
  isSending(): boolean { return this.sending > 0; }
  constructor(profile: string, private codec: SecretCodec, private library: ExpertLibrary, private tasks: TaskRuntime, private changed: () => void, private factory: IMFactory = createIMAdapter) {
    this.db = new Database(path.join(profile, 'soul.sqlite')); this.db.pragma('synchronous = FULL');
    this.db.exec('CREATE TABLE IF NOT EXISTS im_channels_v3(id TEXT PRIMARY KEY,value TEXT NOT NULL,secret BLOB NOT NULL); CREATE TABLE IF NOT EXISTS im_sessions_v3(id TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS im_events_v3(id TEXT PRIMARY KEY,value TEXT NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS im_rules_v3(id TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS im_reply_routes_v3(id TEXT PRIMARY KEY,secret BLOB NOT NULL)');
    for (const event of this.events()) if (event.state === 'unknown') { event.error = '上次发送中断，外部结果未知；请先在 IM 核对，系统不会自动重发'; this.put(event); }
  }
  private put(event: Journal): void { this.db.prepare('INSERT INTO im_events_v3 VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(event.id, JSON.stringify(event)); }
  channels(): ChannelView[] { return (this.db.prepare('SELECT value FROM im_channels_v3').all() as Array<{ value: string }>).map(row => { const c = JSON.parse(row.value); return { ...c, provider: c.provider || 'feishu', state: this.errors.has(c.id) ? 'failed' : this.adapters.get(c.id)?.state() ?? 'idle', error: this.errors.get(c.id) ?? '' }; }); }
  sessions(): IMSession[] { return (this.db.prepare('SELECT value FROM im_sessions_v3').all() as Array<{ value: string }>).map(row => JSON.parse(row.value)); }
  events(): Journal[] { return (this.db.prepare('SELECT value FROM im_events_v3 ORDER BY rowid DESC LIMIT 1000').all() as Array<{ value: string }>).map(row => JSON.parse(row.value)); }
  publicEvents(): IMEvent[] { return this.events().map(({ input: _input, inputs: _inputs, ...event }) => event); }
  rules(): IMAccessRule[] { return (this.db.prepare('SELECT value FROM im_rules_v3').all() as Array<{ value: string }>).map(row => JSON.parse(row.value)); }
  async start(): Promise<void> { for (const c of this.channels().filter(c => c.enabled)) void this.connect(c.id); for (const event of this.events().filter(e => e.state === 'received')) this.dispatch(event); this.synchronize(); }
  async saveChannel(input: ChannelInput): Promise<void> {
    const id = input.id || uid(), name = required(input.name, '连接名称', 80).trim(), appId = required(input.appId, 'App ID', 200).trim();
    const provider = input.provider || 'feishu';
    if (!['feishu', 'dingtalk', 'wecom', 'qq'].includes(provider) || typeof input.enabled !== 'boolean' || (provider === 'feishu' && !/^cli_[\w]+$/.test(appId))) throw new Error('平台、App ID 或开关无效');
    const old = this.channels().find(c => c.id === id);
    if (old && (old.provider !== provider || old.appId !== appId) && this.sessions().some(s => s.channelId === id)) throw new Error('此连接已有聊天，请先移除绑定后更换平台或账号');
    if (this.channels().some(c => c.id !== id && c.provider === provider && c.appId === appId)) throw new Error('此机器人已配置，不能重复连接同一账号');
    const previous = this.db.prepare('SELECT secret FROM im_channels_v3 WHERE id=?').get(id) as { secret: Buffer } | undefined;
    const secret = required(input.secret, 'App Secret', 4000, true); if (!secret && !previous) throw new Error('请输入 App Secret');
    const encrypted = secret || !previous ? this.codec.encrypt(secret) : previous.secret;
    this.db.prepare('INSERT INTO im_channels_v3 VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,secret=excluded.secret').run(id, JSON.stringify({ id, name, appId, provider, enabled: input.enabled }), encrypted);
    this.adapters.get(id)?.close(); this.adapters.delete(id); this.errors.delete(id);
    this.changed(); if (input.enabled) await this.connect(id);
  }
  private async connect(id: string): Promise<void> {
    if (this.closing) return;
    const c = this.channels().find(c => c.id === id); if (!c?.enabled) return;
    const row = this.db.prepare('SELECT secret FROM im_channels_v3 WHERE id=?').get(id) as { secret: Buffer };
    let adapter: IMAdapter | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    try {
      adapter = this.factory(c.appId, this.codec.decrypt(row.secret), () => { if (!this.closing) this.changed(); }, c.provider); this.adapters.set(id, adapter); this.changed();
      await Promise.race([adapter.start(message => { if (this.closing || this.adapters.get(id) !== adapter) return; try { this.receive(id, message); } catch { this.errors.set(id, '消息处理失败，请核对专家、模型和会话配置'); this.changed(); } }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('连接超时')), 30_000); })]);
    }
    catch { adapter?.close(); if (!this.closing && (!adapter || this.adapters.get(id) === adapter)) { this.errors.set(id, '机器人连接失败，请检查账号、密钥、机器人能力和消息事件设置'); this.changed(); } }
    finally { if (timer) clearTimeout(timer); }
  }
  removeChannel(id: string): void { if (this.sessions().some(s => s.channelId === id)) throw new Error('请先移除该连接的会话'); this.adapters.get(id)?.close(); this.adapters.delete(id); this.errors.delete(id); this.db.transaction(() => { this.db.prepare('DELETE FROM im_channels_v3 WHERE id=?').run(id); this.db.prepare('DELETE FROM im_rules_v3 WHERE id=?').run(id); })(); this.changed(); }
  private participants(input: IMParticipant[]): IMParticipant[] {
    if (!Array.isArray(input) || !input.length || input.length > 8) throw new Error('请选择 1—8 个响应专家');
    const models = this.tasks.read().models;
    return input.map((p, i) => {
      const expertId = required(p.expertId, '专家', 200), model = required(p.model, '模型', 200), directory = required(p.directory, '工作目录', 4000, true);
      if (input.slice(0, i).some(prior => prior.expertId === expertId)) throw new Error('响应专家不能重复');
      const expert = this.library.detail(expertId); if (!expert.installed || expert.draft) throw new Error('请安装完整专家');
      if (model !== 'Auto' && !models.some(m => m.id === model)) throw new Error('所选模型未配置');
      if (directory) safeTaskPath(directory, 'Soul-Outputs'); return { expertId, model, directory };
    });
  }
  saveRule(input: IMAccessRule): void {
    if (!this.channels().some(c => c.id === input.channelId)) throw new Error('请选择 IM 连接');
    if (!['pairing', 'open'].includes(input.mode) || typeof input.enabled !== 'boolean' || typeof input.allowModelOverride !== 'boolean') throw new Error('接入规则无效');
    if (!Array.isArray(input.confirmers) || input.confirmers.length > 100 || !Array.isArray(input.participants)) throw new Error('确认人或专家列表无效');
    const confirmers = [...new Set(input.confirmers.map(id => required(id, '确认人 ID', 200).trim()))];
    const participants = input.enabled ? this.participants(input.participants) : input.participants.length ? this.participants(input.participants) : [];
    const rule = { channelId: input.channelId, enabled: input.enabled, mode: input.mode, participants, confirmers, allowModelOverride: input.allowModelOverride, instructions: required(input.instructions, '分派说明', 4000, true) };
    this.db.prepare('INSERT INTO im_rules_v3 VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(input.channelId, JSON.stringify(rule)); this.changed();
  }
  saveSession(input: IMSession): void {
    const id = input.id || uid();
    if (!this.channels().some(c => c.id === input.channelId)) throw new Error('请选择 IM 连接');
    for (const key of ['chatId', 'senderId', 'name', 'expertId', 'model'] as const) required(input[key], key, 200);
    if (!['direct', 'group'].includes(input.type) || typeof input.enabled !== 'boolean') throw new Error('会话类型无效');
    if (input.allowModelOverride !== undefined && typeof input.allowModelOverride !== 'boolean') throw new Error('模型切换开关无效');
    const participants = this.participants(input.participants?.length ? input.participants : [{ expertId: input.expertId, model: input.model, directory: input.directory }]);
    if (input.groupId && !this.library.list().groups.some(g => g.id === input.groupId)) throw new Error('专家组不存在');
    if (input.directory) safeTaskPath(input.directory, 'Soul-Outputs');
    if (this.sessions().some(s => s.id !== id && s.channelId === input.channelId && s.chatId === input.chatId && s.senderId === input.senderId)) throw new Error('这个会话与发送人已配对');
    if (input.groupId && participants.length > 1) throw new Error('多个响应专家与专家组只能选择一种');
    this.db.prepare('INSERT INTO im_sessions_v3 VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(id, JSON.stringify({ ...input, id, expertId: participants[0].expertId, model: participants[0].model, directory: participants[0].directory, participants, allowModelOverride: Boolean(input.allowModelOverride), instructions: required(input.instructions || '', '分派说明', 4000, true) })); this.changed();
  }
  removeSession(id: string): void { this.db.prepare('DELETE FROM im_sessions_v3 WHERE id=?').run(id); this.changed(); }
  receive(channelId: string, message: IncomingIM): void {
    const id = digest(channelId + ':' + required(message.messageId, '消息 ID', 200)); if (this.db.prepare('SELECT id FROM im_events_v3 WHERE id=?').get(id)) return;
    for (const key of ['chatId', 'senderId', 'text'] as const) required(message[key], key, key === 'text' ? 10000 : 200);
    if (!['group', 'direct'].includes(message.type) || !this.channels().some(c => c.id === channelId)) throw new Error('消息来源无效');
    const { reply, ...incoming } = message;
    const event: Journal = { ...incoming, id, channelId, state: 'pairing', taskId: '', response: '', receipt: '', error: '', at: now() };
    const rule = this.rules().find(r => r.channelId === channelId && r.enabled);
    const code = /^配对码[：: ]+([A-Z0-9]{6})$/.exec(message.text.trim());
    if (code) {
      const pending = this.events().find(e => e.channelId === channelId && e.state === 'pairing' && e.pairingCode === code[1] && Date.parse(e.expires || '') > Date.now());
      event.state = 'rejected'; event.error = '配对指令未获授权或已过期';
      if (pending && rule?.confirmers.includes(message.senderId)) { this.pair(pending.id, this.ruleSession(pending, rule)); event.error = '接入申请已由配置的确认人批准'; }
      this.put(event); this.changed(); return;
    }
    let session = this.sessions().find(s => s.channelId === channelId && s.chatId === message.chatId && s.senderId === message.senderId && s.type === message.type);
    if (!session && rule?.mode === 'open') { session = this.ruleSession(event, rule); this.saveSession(session); }
    if (session?.enabled) { try { event.inputs = this.inputs(event, session); event.state = 'received'; } catch { event.state = 'failed'; event.error = '专家、目录或消息指定的模型无效，未创建任务'; } }
    else if (session) { event.state = 'rejected'; event.error = '此聊天与发送人已停用'; }
    else if (rule) { do { event.pairingCode = crypto.randomInt(0, 1000000).toString().padStart(6, '0'); } while (this.events().some(e => e.state === 'pairing' && e.pairingCode === event.pairingCode && Date.parse(e.expires || '') > Date.now())); event.expires = new Date(Date.now() + 900000).toISOString(); event.codeState = 'unsent'; }
    const encrypted = reply ? this.codec.encrypt(JSON.stringify(reply)) : undefined;
    this.db.transaction(() => { this.put(event); if (encrypted) this.db.prepare('INSERT INTO im_reply_routes_v3 VALUES (?,?)').run(id, encrypted); })();
    this.changed(); if (event.state === 'received') this.dispatch(event);
  }
  private ruleSession(event: IMEvent, rule: IMAccessRule): IMSession { const first = rule.participants[0]; if (!first) throw new Error('接入规则没有专家'); return { id: uid(), channelId: event.channelId, chatId: event.chatId, senderId: event.senderId, type: event.type, name: `${event.type === 'group' ? '群聊' : '私聊'} ${event.chatId.slice(0, 24)}`, groupId: '', expertId: first.expertId, model: first.model, directory: first.directory, enabled: true, participants: rule.participants, allowModelOverride: rule.allowModelOverride, instructions: rule.instructions }; }
  private inputs(event: Journal, session: IMSession): TaskSendInput[] {
    const participants = this.participants(session.participants?.length ? session.participants : [{ expertId: session.expertId, model: session.model, directory: session.directory }]);
    const override = session.allowModelOverride ? /^\/模型\s+(\S+)\s*(?:\n|$)/.exec(event.text)?.[1] : undefined;
    if (override && !this.tasks.read().models.some(m => m.id === override)) throw new Error('消息指定的模型未配置');
    let text = `[IM 会话 ${session.name} · 消息 ${event.messageId}]\n${event.text}\n\n${session.instructions || ''}\n回复只在 Soul 内生成草稿；外部发送由用户在 IM 页面审批。`;
    required(text, '消息及分派说明', 10000);
    const history = this.events().filter(e => e.id !== event.id && e.channelId === event.channelId && e.chatId === event.chatId && e.senderId === event.senderId && e.type === event.type && !['pairing', 'rejected', 'failed'].includes(e.state)).slice(0, 4).reverse().map(e => `[${e.messageId}] ${e.text}\n${e.response ? '专家草案：' + e.response : ''}`).join('\n\n');
    const heading = '\n\n此授权发送人的历史摘录（可能截断；草案不作为原始事实或授权）：\n';
    const room = Math.min(4000, 10000 - text.length - heading.length);
    if (history && room > 0) text += heading + history.slice(-room);
    return participants.map((p, index) => ({ requestId: `im-${event.id}${participants.length > 1 ? '-' + index : ''}`, taskId: '', expertId: p.expertId, groupId: session.groupId, model: override || p.model, directory: p.directory, projectId: '', attachments: [], text }));
  }
  pair(id: string, session: IMSession | null): void { const event = this.events().find(e => e.id === id); if (!event || event.state !== 'pairing') throw new Error('申请已处理'); if (!session) { event.state = 'rejected'; this.put(event); } else { if (!session.enabled || session.channelId !== event.channelId || session.chatId !== event.chatId || session.senderId !== event.senderId || session.type !== event.type) throw new Error('配对目标与申请不一致或未启用'); const inputs = this.inputs(event, session); this.saveSession(session); event.state = 'received'; event.inputs = inputs; this.put(event); this.dispatch(event); } this.changed(); }
  private dispatch(event: Journal): void {
    const inputs = event.inputs || (event.input ? [event.input] : []); if (!inputs.length || this.closing) return;
    try { for (const input of inputs) this.tasks.validateNewTask(input); event.taskIds = inputs.map(input => this.tasks.send(input)); event.taskId = event.taskIds[0]; event.state = 'running'; } catch { event.state = 'failed'; event.error = '专家任务创建失败，请检查模型和专家配置'; }
    this.put(event); this.changed();
  }
  synchronize(): void {
    if (this.closing) return;
    for (const event of this.events().filter(e => e.state === 'running')) {
      const tasks = (event.taskIds?.length ? event.taskIds : [event.taskId]).map(id => this.tasks.repository.get(id));
      if (tasks.every(t => t.status === 'completed')) { event.response = tasks.map(t => (tasks.length > 1 ? `${t.members[0]?.name || '专家'}\n` : '') + t.messages.filter(m => m.role === 'assistant').map(m => m.text).join('\n\n')).join('\n\n').slice(0, 20000); event.state = 'ready'; this.put(event); this.changed(); }
      const failed = tasks.find(t => ['failed', 'stopped'].includes(t.status)); if (failed) { event.state = 'failed'; event.error = failed.error || '任务已停止'; this.put(event); this.changed(); }
    }
  }
  async sendReply(id: string): Promise<void> {
    const event = this.events().find(e => e.id === id); if (!event || event.state !== 'ready' || !event.response) throw new Error('回复未就绪或已处理');
    const adapter = this.adapters.get(event.channelId); if (adapter?.state() !== 'connected') throw new Error('机器人尚未连接');
    adapter.validateReply?.(event.response, this.reply(event));
    event.state = 'unknown'; event.error = '正在发送；中断后需人工核对'; this.put(event); this.changed();
    this.sending++;
    try { const receipt = await adapter.send(event.messageId, event.response, event.id.slice(0, 32), this.reply(event)); if (this.closing) return; event.receipt = receipt; event.state = 'sent'; event.error = ''; this.put(event); this.changed(); }
    catch { if (!this.closing) { event.error = '外部发送结果未知，请在 IM 核对；不会自动重发'; this.put(event); this.changed(); } }
    finally { this.sending--; }
  }
  private reply(event: Journal): IMReplyAddress | undefined { const row = this.db.prepare('SELECT secret FROM im_reply_routes_v3 WHERE id=?').get(event.id) as { secret: Buffer } | undefined; return row ? { ...JSON.parse(this.codec.decrypt(row.secret)), sequence: event.codeState === 'sent' ? 2 : 1 } : undefined; }
  async sendPairingCode(id: string): Promise<void> {
    const event = this.events().find(e => e.id === id); if (!event || event.state !== 'pairing' || !event.pairingCode || event.codeState !== 'unsent' || Date.parse(event.expires || '') <= Date.now()) throw new Error('配对码已处理或过期');
    const adapter = this.adapters.get(event.channelId); if (adapter?.state() !== 'connected') throw new Error('机器人尚未连接');
    const text = `聊天接入需要确认人批准。配对码：${event.pairingCode}（15分钟内有效）。请让配置的确认人向本机器人回复“配对码 ${event.pairingCode}”。`;
    adapter.validateReply?.(text, this.reply(event));
    event.codeState = 'unknown'; this.put(event); this.changed(); this.sending++;
    try { await adapter.send(event.messageId, text, event.id.slice(0, 26) + '-code', this.reply(event)); if (!this.closing) { event.codeState = 'sent'; this.put(event); this.changed(); } }
    catch { if (!this.closing) { event.error = '配对码发送结果未知，请在 IM 核对；不会自动重发'; this.put(event); this.changed(); } }
    finally { this.sending--; }
  }
  close(): void { this.closing = true; for (const adapter of this.adapters.values()) adapter.close(); this.adapters.clear(); this.db.close(); }
}
