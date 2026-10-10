import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import type { ModelEntry, ModelInput, TaskRound, WireMessage } from '../shared/contracts';
import { required } from './task-repository';
import { learningOutputLimit } from '../shared/knowledge-learning';

export interface SecretCodec { encrypt(value: string): Buffer; decrypt(value: Buffer): string }
export interface ModelCredentials extends ModelEntry { apiKey: string }
export interface ModelReply { text: string; reasoning?: string; calls: TaskRound['calls']; usage?: TaskRound['usage']; finishReason?: string }
export type ModelCall = (config: ModelCredentials, messages: WireMessage[], signal: AbortSignal, chunk: (value: string) => void) => Promise<ModelReply>;
export class TaskModels {
  private db: Database.Database;
  constructor(profile: string, private codec: SecretCodec) {
    this.db = new Database(path.join(profile, 'soul.sqlite'));
    this.db.exec('CREATE TABLE IF NOT EXISTS task_models_v3(id TEXT PRIMARY KEY,metadata TEXT NOT NULL,secret BLOB NOT NULL)');
  }
  list(): ModelEntry[] { return (this.db.prepare('SELECT metadata FROM task_models_v3 ORDER BY rowid').all() as Array<{ metadata: string }>).map(row => JSON.parse(row.metadata)); }
  resolve(id: string): ModelCredentials {
    const entry = id === 'Auto' ? this.list()[0] : this.list().find(item => item.id === id || item.model === id);
    if (!entry) throw new Error(`尚未配置可用模型：${id}。请打开输入器的模型设置。`);
    const row = this.db.prepare('SELECT secret FROM task_models_v3 WHERE id=?').get(entry.id) as { secret: Buffer };
    return { ...entry, apiKey: this.codec.decrypt(row.secret) };
  }
  save(input: ModelInput): ModelEntry[] {
    const id = input.id ? required(input.id, '模型 ID', 100) : crypto.randomUUID();
    const label = required(input.label, '显示名称', 120).trim();
    const model = required(input.model, '模型名称', 120).trim();
    if (!['openai', 'anthropic'].includes(input.protocol)) throw new Error('模型协议无效');
    const url = new URL(required(input.baseUrl, '服务地址', 2000));
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new Error('服务地址须为 HTTPS 或本机 HTTP，不能包含凭据');
    const apiKey = required(input.apiKey, '密钥', 4000, true);
    const previous = this.db.prepare('SELECT secret FROM task_models_v3 WHERE id=?').get(id) as { secret: Buffer } | undefined;
    if (!apiKey && !previous && url.protocol !== 'http:') throw new Error('请填写 API 密钥');
    const secret = apiKey || !previous ? this.codec.encrypt(apiKey) : previous.secret;
    const entry: ModelEntry = { id, label, model, baseUrl: url.href.replace(/\/$/, ''), protocol: input.protocol, configured: true };
    this.db.prepare('INSERT INTO task_models_v3 VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,secret=excluded.secret').run(id, JSON.stringify(entry), secret);
    return this.list();
  }
  importLegacy(file: string): ModelEntry[] {
    if (!path.isAbsolute(file) || !fs.statSync(file).isFile()) throw new Error('请选择旧版 Soul 数据库文件');
    const source = new Database(file, { readonly: true, fileMustExist: true });
    try {
      const get = (key: string) => (source.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined)?.value ?? '';
      const model = get('chat_model');
      if (!model) throw new Error('所选数据库没有旧版对话模型配置');
      const claude = /(^|[\/:])claude[-_]/i.test(model);
      return this.save({ id: 'legacy-chat', label: `Soul · ${model}`, model, protocol: claude ? 'anthropic' : 'openai', baseUrl: get(claude ? 'anthropic_base_url' : 'chat_base_url'), apiKey: get(claude ? 'anthropic_api_key' : 'chat_api_key') });
    } finally { source.close(); }
  }
  close(): void { this.db.close(); }
}

// Reuse the tested Soul providers. Only the main process receives credentials.
export const callSoulModel: ModelCall = async (config, messages, signal, chunk) => {
  const providers = require('./model.cjs') as { OpenAICompatProvider: new (config: ModelCredentials) => any; ClaudeProvider: new (config: ModelCredentials) => any };
  const provider = config.protocol === 'anthropic' ? new providers.ClaudeProvider(config) : new providers.OpenAICompatProvider(config);
  const { taskTools } = await import('./task-tools');
  return new Promise<ModelReply>((resolve, reject) => {
    void provider.chat(messages, (value: string, kind?: string) => { if (kind !== 'reasoning') chunk(value); },
      (text: string, calls: ModelReply['calls'] = [], reasoning?: string, usage?: ModelReply['usage']) => { if (signal.aborted) reject(new Error('任务已取消')); else resolve({ text, calls, reasoning, usage }); },
      reject, { tools: taskTools, signal, maxTokens: 4096 }).catch(reject);
  });
};

// One request only: a network failure can still be billable, so derived learning
// must not inherit SDK retries or the task engine's tools and repair rounds.
export const callKnowledgeModel: ModelCall = async (config, messages, signal) => {
  const anthropic = config.protocol === 'anthropic';
  const base = config.baseUrl.replace(/\/$/, '');
  const response = await fetch(anthropic ? base.replace(/\/v1$/, '') + '/v1/messages' : base + '/chat/completions', {
    method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)]),
    headers: anthropic ? { 'content-type': 'application/json', 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' } : { 'content-type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify(anthropic ? { model: config.model, max_tokens: learningOutputLimit, system: messages.filter(m => m.role === 'system').map(m => m.content).join('\n'), messages: messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content })) } : { model: config.model, max_tokens: learningOutputLimit, stream: false, messages }),
  });
  if (!response.ok) throw new Error(`整理模型请求失败 (${response.status})`);
  const value = await response.json() as any;
  const text = anthropic ? (value.content ?? []).filter((item: any) => item.type === 'text').map((item: any) => item.text).join('') : value.choices?.[0]?.message?.content;
  const calls = anthropic ? (value.content ?? []).filter((item: any) => item.type === 'tool_use') : value.choices?.[0]?.message?.tool_calls ?? [];
  if (typeof text !== 'string' || text.length > 200_000 || calls.length) throw new Error('整理模型响应无效');
  const usage = value.usage;
  return { text, calls: [], finishReason: anthropic ? value.stop_reason : value.choices?.[0]?.finish_reason, usage: usage ? { inputTokens: usage.input_tokens ?? usage.prompt_tokens ?? 0, outputTokens: usage.output_tokens ?? usage.completion_tokens ?? 0 } : undefined };
};
