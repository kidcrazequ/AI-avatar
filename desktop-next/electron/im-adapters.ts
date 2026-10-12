import crypto from 'node:crypto';
import type { IMProvider } from '../shared/integrations';
import { createFeishu, type IMAdapter, type IMFactory, type IMReplyAddress, type IncomingIM } from './feishu-adapter';

type Json = Record<string, any>;
export interface IMTransport { fetch: typeof fetch; socket(url: string): WebSocket }
const nativeTransport: IMTransport = { fetch: (...args) => fetch(...args), socket: url => new WebSocket(url) };
const uuid = () => crypto.randomUUID();
function official(url: string, protocol: string, hosts: string[]): string {
  const parsed = new URL(url);
  if (parsed.protocol !== protocol || parsed.username || parsed.password || parsed.port || !hosts.some(host => parsed.hostname === host || parsed.hostname.endsWith('.' + host))) throw new Error('平台返回了无效地址');
  return url;
}
async function json(transport: IMTransport, url: string, options: RequestInit = {}): Promise<Json> {
  const response = await transport.fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (!response.ok || Number(response.headers.get('content-length') || 0) > 262144) throw new Error('平台请求失败');
  const reader = response.body?.getReader(); if (!reader) throw new Error('平台响应为空');
  const parts: Uint8Array[] = []; let size = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 262144) throw new Error('平台响应过大'); parts.push(part.value); } }
  finally { await reader.cancel().catch(() => {}); }
  const value = JSON.parse(Buffer.concat(parts).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('平台响应无效'); return value;
}
const post = (body: Json, headers: Record<string, string> = {}): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
function message(value: Json, provider: IMProvider): IncomingIM | undefined {
  let result: IncomingIM;
  if (provider === 'dingtalk') {
    if (value.msgtype !== 'text' || (value.conversationType === '2' && value.isInAtList !== true)) return;
    result = { messageId: value.msgId, chatId: value.conversationId, senderId: value.senderStaffId || value.senderId, type: value.conversationType === '2' ? 'group' : 'direct', text: value.text?.content?.trim(), reply: { url: value.sessionWebhook, expires: Number(value.sessionWebhookExpiredTime) } };
    official(result.reply!.url!, 'https:', ['oapi.dingtalk.com']);
  } else if (provider === 'wecom') {
    if (value.msgtype !== 'text') return;
    result = { messageId: value.msgid, chatId: value.chatid || value.from?.userid, senderId: value.from?.userid, type: value.chattype === 'group' ? 'group' : 'direct', text: value.text?.content?.trim() };
  } else {
    if (value.message_type && value.message_type !== 0 || value.author?.bot) return;
    const sender = value.author?.member_openid || value.author?.user_openid || value.author?.id;
    result = { messageId: value.id, chatId: value.group_openid || sender, senderId: sender, type: value.group_openid ? 'group' : 'direct', text: value.content?.trim(), reply: { chatId: value.group_openid || sender, type: value.group_openid ? 'group' : 'direct', expires: Date.parse(value.timestamp) + 300000 } };
  }
  if (!['messageId', 'chatId', 'senderId', 'text'].every(key => typeof result[key as keyof IncomingIM] === 'string' && (result[key as keyof IncomingIM] as string).length > 0) || result.text.length > 10000) return;
  return result;
}

// Reconnect transports; never retry a reply whose external result is unknown.
class Stream implements IMAdapter {
  private ws?: WebSocket;
  private closed = false;
  private terminal = false;
  private current = 'idle';
  private generation = 0;
  private attempt = 0;
  private reconnect?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private heartbeatAt = 0;
  private ready?: () => void;
  private receive?: (message: IncomingIM) => void;
  private pending = new Map<string, { resolve(value: Json): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private token = '';
  private expires = 0;
  private seq: number | null = null;
  private session = '';
  constructor(private provider: Exclude<IMProvider, 'feishu'>, private appId: string, private secret: string, private changed: () => void, private transport: IMTransport) {}
  state(): string { return this.current; }
  private set(state: string): void { this.current = state; this.changed(); }
  async start(receive: (message: IncomingIM) => void): Promise<void> {
    this.receive = receive;
    await new Promise<void>((resolve, reject) => { this.ready = resolve; void this.open().catch(() => { this.set('failed'); reject(new Error('机器人连接失败')); }); });
  }
  private async access(): Promise<string> {
    if (this.token && this.expires > Date.now() + 60000) return this.token;
    const data = this.provider === 'qq'
      ? await json(this.transport, 'https://api.bot.qq.com/app/getAppAccessToken', post({ appId: this.appId, clientSecret: this.secret }))
      : await json(this.transport, 'https://oapi.dingtalk.com/gettoken?' + new URLSearchParams({ appkey: this.appId, appsecret: this.secret }));
    if (typeof data.access_token !== 'string' || !data.access_token || data.errcode) throw new Error('令牌获取失败');
    this.token = data.access_token; this.expires = Date.now() + Math.max(60, Number(data.expires_in) || 7200) * 1000; return this.token;
  }
  private async open(): Promise<void> {
    if (this.closed || this.terminal) return;
    const generation = ++this.generation; this.set(this.attempt ? 'reconnecting' : 'connecting');
    let url: string;
    if (this.provider === 'dingtalk') {
      const data = await json(this.transport, 'https://api.dingtalk.com/v1.0/gateway/connections/open', post({ clientId: this.appId, clientSecret: this.secret, ua: 'Soul Next', subscriptions: [{ type: 'CALLBACK', topic: '/v1.0/im/bot/messages/get' }] }));
      url = official(data.endpoint, 'wss:', ['dingtalk.com']) + '?ticket=' + encodeURIComponent(data.ticket);
    } else if (this.provider === 'qq') {
      const token = await this.access(); const data = await json(this.transport, 'https://api.bot.qq.com/gateway', { headers: { Authorization: 'QQBot ' + token } });
      url = official(data.url, 'wss:', ['api.bot.qq.com']);
    } else url = 'wss://openws.work.weixin.qq.com';
    if (this.closed || generation !== this.generation) return;
    const ws = this.transport.socket(url); this.ws = ws;
    ws.addEventListener('open', () => {
      if (this.closed || generation !== this.generation) { ws.close(); return; }
      if (this.provider === 'wecom') { const id = uuid(); this.request({ cmd: 'aibot_subscribe', headers: { req_id: id }, body: { bot_id: this.appId, secret: this.secret } }, id).then(() => { if (generation === this.generation && !this.closed) { this.connected(); this.beat(30000, () => ({ cmd: 'ping', headers: { req_id: uuid() } })); } }).catch(() => ws.close()); }
    });
    ws.addEventListener('message', event => {
      if (this.closed || generation !== this.generation || typeof event.data !== 'string' || Buffer.byteLength(event.data) > 262144) return;
      try { this.parse(JSON.parse(event.data)); } catch { this.set('failed'); ws.close(); }
    });
    ws.addEventListener('error', () => ws.close());
    ws.addEventListener('close', () => {
      if (generation !== this.generation) return;
      this.clearPending(); if (this.heartbeat) clearInterval(this.heartbeat); this.heartbeat = undefined;
      if (this.closed || this.terminal) return;
      this.set('reconnecting'); this.reconnect = setTimeout(() => void this.open().catch(() => { this.set('failed'); this.retry(); }), Math.min(60000, 1000 * 2 ** Math.min(6, this.attempt++)));
    });
  }
  private retry(): void { if (!this.closed && !this.terminal) this.reconnect = setTimeout(() => void this.open().catch(() => { this.set('failed'); this.retry(); }), 60000); }
  private connected(): void { this.attempt = 0; this.set('connected'); this.ready?.(); this.ready = undefined; }
  private write(value: Json): void { if (this.ws?.readyState !== 1) throw new Error('机器人尚未连接'); this.ws.send(JSON.stringify(value)); }
  private beat(interval: number, payload: () => Json): void {
    if (this.heartbeat) clearInterval(this.heartbeat); this.heartbeatAt = Date.now();
    this.heartbeat = setInterval(() => { if (Date.now() - this.heartbeatAt > interval * 2) { this.ws?.close(); return; } try { this.write(payload()); } catch { this.ws?.close(); } }, interval);
  }
  private request(value: Json, id: string): Promise<Json> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('回复未收到平台回执')); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write(value); } catch { clearTimeout(timer); this.pending.delete(id); reject(new Error('机器人尚未连接')); }
    });
  }
  private parse(data: Json): void {
    if (this.provider === 'dingtalk') {
      if (data.type === 'SYSTEM') { if (data.headers?.topic === 'ping') this.write({ code: 200, headers: data.headers, message: 'OK', data: data.data }); if (data.headers?.topic === 'REGISTERED') this.connected(); if (data.headers?.topic === 'disconnect') this.ws?.close(); }
      if (data.type === 'CALLBACK' && data.headers?.topic === '/v1.0/im/bot/messages/get') {
        const incoming = message(JSON.parse(data.data), this.provider); if (incoming) this.receive?.(incoming);
        this.write({ code: 200, headers: { contentType: 'application/json', messageId: data.headers.messageId }, message: 'OK', data: JSON.stringify({ response: {} }) });
      }
    } else if (this.provider === 'wecom') {
      const id = data.headers?.req_id, pending = this.pending.get(id);
      if (pending && 'errcode' in data) { clearTimeout(pending.timer); this.pending.delete(id); if (data.errcode === 0) pending.resolve(data); else pending.reject(new Error('平台拒绝请求')); }
      if ('errcode' in data && data.errcode === 0) this.heartbeatAt = Date.now();
      if (data.cmd === 'aibot_msg_callback') { const incoming = message(data.body, this.provider); if (incoming) { incoming.reply = { requestId: id, expires: Date.now() + 86400000 }; this.receive?.(incoming); } }
      if (data.cmd === 'aibot_event_callback' && data.body?.event?.eventtype === 'disconnected_event') { this.terminal = true; this.set('failed'); this.ws?.close(); }
    } else {
      if (typeof data.s === 'number') this.seq = data.s;
      if (data.op === 10) {
        this.beat(Math.max(5000, Number(data.d?.heartbeat_interval) || 45000), () => ({ op: 1, d: this.seq }));
        this.write(this.session ? { op: 6, d: { token: 'QQBot ' + this.token, session_id: this.session, seq: this.seq } } : { op: 2, d: { token: 'QQBot ' + this.token, intents: 1 << 25, shard: [0, 1], properties: { $os: process.platform, $browser: 'Soul', $device: 'Soul' } } });
      }
      if (data.op === 11) this.heartbeatAt = Date.now();
      if (data.op === 9) { this.session = ''; this.seq = null; this.ws?.close(); }
      if (data.op === 7) this.ws?.close();
      if (data.op === 0 && (data.t === 'READY' || data.t === 'RESUMED')) { if (data.d?.session_id) this.session = data.d.session_id; this.connected(); }
      if (data.op === 0 && ['C2C_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE'].includes(data.t)) { const incoming = message(data.d, this.provider); if (incoming) this.receive?.(incoming); }
    }
  }
  validateReply(text: string, reply?: IMReplyAddress): void {
    if (this.current !== 'connected') throw new Error('机器人尚未连接');
    if (!reply || !Number.isFinite(reply.expires) || reply.expires! <= Date.now()) throw new Error('平台回复窗口已过期');
    if (Buffer.byteLength(text) > 20000) throw new Error('回复超出平台长度限制');
    if (this.provider === 'wecom' && !reply.requestId) throw new Error('缺少回复地址');
    if (this.provider === 'dingtalk' && new URL(official(reply.url!, 'https:', ['oapi.dingtalk.com'])).pathname !== '/robot/sendBySession') throw new Error('回复地址无效');
    if (this.provider === 'qq' && (!reply.chatId || !['direct', 'group'].includes(reply.type || ''))) throw new Error('回复地址无效');
  }
  async send(messageId: string, text: string, id: string, reply?: IMReplyAddress): Promise<string> {
    this.validateReply(text, reply); reply = reply!;
    if (this.provider === 'wecom') { if (!reply.requestId) throw new Error('缺少回复地址'); await this.request({ cmd: 'aibot_respond_msg', headers: { req_id: reply.requestId }, body: { msgtype: 'markdown', markdown: { content: text } } }, reply.requestId); return 'ack:' + id; }
    if (this.provider === 'dingtalk') {
      const url = official(reply.url!, 'https:', ['oapi.dingtalk.com']); if (new URL(url).pathname !== '/robot/sendBySession') throw new Error('回复地址无效');
      const result = await json(this.transport, url, post({ msgtype: 'text', text: { content: text } }, { 'x-acs-dingtalk-access-token': await this.access() }));
      if (result.errcode !== 0) throw new Error('平台拒绝回复'); return 'ack:' + id;
    }
    if (!reply.chatId || !['direct', 'group'].includes(reply.type || '')) throw new Error('回复地址无效');
    const path = reply.type === 'group' ? 'groups' : 'users';
    const result = await json(this.transport, `https://api.bot.qq.com/v2/${path}/${encodeURIComponent(reply.chatId)}/messages`, post({ content: text, msg_type: 0, msg_id: messageId, msg_seq: reply.sequence || 1 }, { Authorization: 'QQBot ' + await this.access() }));
    if (typeof result.id !== 'string' || !result.id) throw new Error('回复未获得消息回执'); return result.id;
  }
  private clearPending(): void { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('连接已关闭')); } this.pending.clear(); }
  close(): void { this.closed = true; this.generation++; if (this.reconnect) clearTimeout(this.reconnect); if (this.heartbeat) clearInterval(this.heartbeat); this.clearPending(); this.ws?.close(); this.set('idle'); }
}
export const createIMAdapter: IMFactory = (appId, secret, changed, provider = 'feishu') => provider === 'feishu' ? createFeishu(appId, secret, changed) : new Stream(provider, appId, secret, changed, nativeTransport);
export const createStreamAdapter = (provider: Exclude<IMProvider, 'feishu'>, appId: string, secret: string, changed: () => void, transport: IMTransport): IMAdapter => new Stream(provider, appId, secret, changed, transport);
