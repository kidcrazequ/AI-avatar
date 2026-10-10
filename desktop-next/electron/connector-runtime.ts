import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ConnectorConfig, ConnectorInput, ConnectorView } from '../shared/integrations';
import type { SecretCodec } from './task-models';
import { digest, required } from './task-repository';
const uid = () => crypto.randomUUID();
export const endpoint = (value: string) => { const url = new URL(required(value, '服务地址', 2000)); if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('地址须为 HTTPS 或本机 HTTP，不能包含凭据'); for (const key of url.searchParams.keys()) if (/token|secret|key|password/i.test(key)) throw new Error('凭据请填写在独立密钥栏'); return url.href; };
interface Live { view: ConnectorView; client?: Client; tools: Map<string, unknown>; fingerprint: string; controller: AbortController }
export class ConnectorRuntime {
  private db: Database.Database;
  private live = new Map<string, Live>();
  private closing = false;
  constructor(profile: string, private codec: SecretCodec, private expert: (id: string) => unknown, private changed: () => void) {
    this.db = new Database(path.join(profile, 'soul.sqlite'));
    this.db.exec('CREATE TABLE IF NOT EXISTS connectors_v3(id TEXT PRIMARY KEY,value TEXT NOT NULL,secret BLOB NOT NULL)');
  }
  configs(): ConnectorConfig[] { return (this.db.prepare('SELECT value FROM connectors_v3').all() as Array<{ value: string }>).map(row => JSON.parse(row.value)); }
  read(scope: string): ConnectorView[] { return this.configs().filter(c => !scope || c.expertId === scope).map(c => this.live.get(c.id)?.view ?? { ...c, state: 'idle', tools: [], error: '' }); }
  private config(id: string) { const config = this.configs().find(c => c.id === id); if (!config) throw new Error('连接器不存在'); return config; }
  private secret(id: string): string { return this.codec.decrypt((this.db.prepare('SELECT secret FROM connectors_v3 WHERE id=?').get(id) as { secret: Buffer }).secret); }
  async save(input: ConnectorInput): Promise<void> {
    this.expert(input.expertId);
    const id = input.id || uid(), name = required(input.name, '连接名称', 80).trim();
    if (!['http', 'sse', 'stdio', 'github'].includes(input.transport) || !['read', 'ask', 'off'].includes(input.mode)) throw new Error('连接协议或策略无效');
    const url = input.transport === 'github' ? 'https://api.github.com' : ['http', 'sse'].includes(input.transport) ? endpoint(input.url) : '';
    const command = input.transport === 'stdio' ? required(input.command, '命令', 2000).trim() : '';
    if (command && !path.isAbsolute(command)) throw new Error('本机 MCP 命令须为绝对路径');
    if (!Array.isArray(input.args) || input.args.length > 32) throw new Error('命令参数无效');
    const args = input.args.map(arg => required(arg, '命令参数', 2000, true));
    const old = this.db.prepare('SELECT secret FROM connectors_v3 WHERE id=?').get(id) as { secret: Buffer } | undefined;
    required(input.secret, '连接密钥', 4000, true);
    const secret = input.secret || !old ? this.codec.encrypt(input.secret) : old.secret;
    const config: ConnectorConfig = { id, name, expertId: input.expertId, catalog: required(input.catalog, '连接器类别', 80), transport: input.transport, url, command, args, mode: input.mode };
    await this.disconnect(id);
    this.db.prepare('INSERT INTO connectors_v3 VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,secret=excluded.secret').run(id, JSON.stringify(config), secret);
    this.changed();
  }
  async disconnect(id: string): Promise<void> { const live = this.live.get(id); this.live.delete(id); live?.controller.abort(); await live?.client?.close().catch(() => undefined); }
  async remove(id: string): Promise<void> { await this.disconnect(id); this.db.prepare('DELETE FROM connectors_v3 WHERE id=?').run(id); this.changed(); }
  async connect(id: string): Promise<void> {
    if (this.closing) return;
    const config = this.config(id); if (config.mode === 'off') throw new Error('请先启用连接器策略');
    await this.disconnect(id);
    const controller = new AbortController(), live: Live = { view: { ...config, state: 'connecting', error: '', tools: [] }, tools: new Map(), fingerprint: digest(JSON.stringify(config)), controller };
    this.live.set(id, live); this.changed();
    try {
      const token = this.secret(id);
      if (config.transport === 'github') {
        const result = await this.github(config, token, token ? '/user' : '/repos/kidcrazequ/AI-avatar', controller.signal);
        if (!result) throw new Error('GitHub 响应为空');
        live.view.tools = ['github_get_tree', 'github_read_file'].map(name => ({ name, description: '读取已授权 GitHub 仓库资料，保留来源路径。', readonly: true }));
      } else {
        const requestInit: RequestInit = { headers: token ? { Authorization: `Bearer ${token}` } : {}, redirect: 'error' as const };
        const transport = config.transport === 'stdio' ? new StdioClientTransport({ command: config.command, args: config.args, env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '', TEMP: process.env.TEMP ?? '' }, stderr: 'ignore' }) : config.transport === 'sse' ? new SSEClientTransport(new URL(config.url), { requestInit }) : new StreamableHTTPClientTransport(new URL(config.url), { requestInit });
        const client = new Client({ name: 'Soul-Next', version: '0.20.0' }); live.client = client;
        client.onclose = () => { if (this.live.get(id) === live && !controller.signal.aborted) { live.view.state = 'error'; live.view.error = '服务连接已断开，请重新连接'; this.changed(); } };
        await client.connect(transport, { timeout: 10_000, signal: controller.signal });
        let cursor: string | undefined, pages = 0;
        do { const result = await client.listTools(cursor ? { cursor } : {}, { timeout: 10_000, signal: controller.signal }); for (const tool of result.tools) { if (!/^[A-Za-z0-9_\-]{1,128}$/.test(tool.name)) continue; live.tools.set(tool.name, tool); live.view.tools.push({ name: tool.name, description: tool.description?.slice(0, 1000) ?? '', readonly: tool.annotations?.readOnlyHint === true }); } cursor = result.nextCursor; if (++pages > 20 || live.tools.size > 500) throw new Error('工具列表超过上限'); } while (cursor);
      }
      controller.signal.throwIfAborted(); if (this.live.get(id) !== live || this.closing) return;
      live.view.state = 'connected'; this.changed();
    } catch { if (this.live.get(id) === live && !this.closing) { live.view.state = 'error'; live.view.error = '连接失败，请检查地址、凭据、服务权限或本机运行环境'; await live.client?.close().catch(() => undefined); this.changed(); } }
  }
  tools(scope: string) { return this.read(scope).filter(c => c.state === 'connected' && c.mode !== 'off').flatMap(c => c.tools.map(t => ({ connectorId: c.id, connector: c.name, ...t, inputSchema: c.transport === 'github' ? { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, ref: { type: 'string' }, path: { type: 'string' } }, required: t.name === 'github_read_file' ? ['owner','repo','path'] : ['owner','repo'] } : (this.live.get(c.id)?.tools.get(t.name) as { inputSchema?: unknown })?.inputSchema }))); }
  binding(scope: string, id: string, name: string): string {
    const live = this.live.get(id); if (!live || live.view.expertId !== scope || live.view.state !== 'connected' || !live.view.tools.some(t => t.name === name)) throw new Error('当前专家未连接该工具');
    if (live.view.mode === 'read' && !live.view.tools.find(t => t.name === name)?.readonly) throw new Error('连接器仅允许声明为只读的工具');
    return digest(live.fingerprint + JSON.stringify(live.view.tools.find(t => t.name === name)));
  }
  async call(scope: string, id: string, name: string, args: Record<string, unknown>, binding: string, signal: AbortSignal): Promise<string> {
    if (binding !== this.binding(scope, id, name)) throw new Error('连接器或工具已改变，请重新审批');
    const live = this.live.get(id)!;
    if (live.view.transport === 'github') {
      const owner = required(args.owner, '仓库拥有者', 100), repo = required(args.repo, '仓库名称', 100), ref = typeof args.ref === 'string' ? args.ref : 'HEAD';
      if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) throw new Error('仓库名称无效');
      const base = `/repos/${owner}/${repo}`;
      const url = name === 'github_get_tree' ? `${base}/git/trees/${encodeURIComponent(ref)}?recursive=1` : `${base}/contents/${required(args.path, '资料路径', 1000).split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`;
      const data = await this.github(live.view, this.secret(id), url, signal);
      return JSON.stringify({ source: 'https://github.com/' + owner + '/' + repo, data }).slice(0, 100000);
    }
    const result = await live.client!.callTool({ name, arguments: args }, undefined, { timeout: 30_000, signal });
    return JSON.stringify(result).slice(0, 100000);
  }
  private async github(config: ConnectorConfig, token: string, route: string, signal: AbortSignal): Promise<unknown> {
    const res = await fetch(config.url + route, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Soul-Next', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]), redirect: 'error' });
    if (!res.ok) throw new Error('GitHub 请求失败'); return res.json();
  }
  async close(): Promise<void> { this.closing = true; await Promise.all([...this.live.keys()].map(id => this.disconnect(id))); this.db.close(); }
}
