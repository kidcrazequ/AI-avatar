import * as lark from '@larksuiteoapi/node-sdk';
export interface IMReplyAddress { url?: string; expires?: number; requestId?: string; chatId?: string; type?: 'group' | 'direct'; sequence?: number }
export interface IncomingIM { chatId: string; senderId: string; messageId: string; type: 'group' | 'direct'; text: string; reply?: IMReplyAddress }
export interface IMAdapter { start(receive: (message: IncomingIM) => void): Promise<void>; state(): string; validateReply?(text: string, reply?: IMReplyAddress): void; send(messageId: string, text: string, uuid: string, reply?: IMReplyAddress): Promise<string>; close(): void }
export type IMFactory = (appId: string, secret: string, changed: () => void, provider?: import('../shared/integrations').IMProvider) => IMAdapter;
export const createFeishu: IMFactory = (appId, appSecret, changed) => {
  // SDK request errors can contain credentials; the app reports bounded status, never raw SDK logs.
  const logger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };
  const client = new lark.Client({ appId, appSecret, domain: lark.Domain.Feishu, logger });
  let ws: lark.WSClient | undefined, closed = false;
  return {
    async start(receive) {
      ws = new lark.WSClient({ appId, appSecret, domain: lark.Domain.Feishu, logger, handshakeTimeoutMs: 10_000, wsConfig: { pingTimeout: 45 }, onReady: changed, onError: changed, onReconnecting: changed, onReconnected: changed });
      const response = await client.request({ method: 'GET', url: '/open-apis/bot/v3/info', timeout: 10_000 }) as { code?: number; bot?: { open_id?: string } };
      if (closed) return;
      if (response.code !== 0 || !response.bot?.open_id) throw new Error('机器人权限校验失败');
      const botId = response.bot.open_id;
      await ws.start({ eventDispatcher: new lark.EventDispatcher({}).register({ 'im.message.receive_v1': async data => {
        if (closed || data.sender?.sender_type !== 'user' || data.message?.message_type !== 'text') return;
        if (data.message.chat_type === 'group' && !data.message.mentions?.some(mention => mention.id?.open_id === botId)) return;
        const content = JSON.parse(data.message.content || '{}');
        if (typeof content.text !== 'string') return;
        const text = content.text.replace(/@_user_\d+\s*/g, '').trim();
        if (!text || text.length > 10000 || !data.sender.sender_id?.open_id) return;
        receive({ messageId: data.message.message_id, chatId: data.message.chat_id, senderId: data.sender.sender_id.open_id, type: data.message.chat_type === 'group' ? 'group' : 'direct', text });
      } }) });
      if (closed) ws.close({ force: true });
    },
    state: () => closed ? 'idle' : ws?.getConnectionStatus().state ?? 'idle',
    async send(messageId, text, uuid) {
      const result = await client.im.message.reply({ path: { message_id: messageId }, data: { content: JSON.stringify({ text }), msg_type: 'text', uuid } });
      if (result.code !== 0 || !result.data?.message_id) throw new Error('飞书发送未获得成功回执');
      return result.data.message_id;
    },
    close() { closed = true; ws?.close({ force: true }); },
  };
};
