import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import type { PermissionConfig, Policy } from '../shared/integrations';
import type { TaskMember, WireCall } from '../shared/contracts';
import { required } from './task-repository';
import { parseTool, safeTaskPath } from './task-tools';
export const builtinNames = ['search_knowledge', 'read_knowledge', 'describe_table', 'query_table', 'read_skill', 'read_project_file', 'write_artifact', 'list_connector_tools', 'call_connector_tool'];
export const defaultPermissions = (): PermissionConfig => ({ tools: true, files: true, builtin: true, model: false, paths: [], models: [], policies: Object.fromEntries(builtinNames.map(name => [name, ['write_artifact', 'call_connector_tool'].includes(name) ? 'ask' : 'allow'])) });
export class Permissions {
  private db: Database.Database;
  constructor(profile: string, private expert: (id: string) => unknown) { this.db = new Database(path.join(profile, 'soul.sqlite')); this.db.exec('CREATE TABLE IF NOT EXISTS permissions_v3(id TEXT PRIMARY KEY,value TEXT NOT NULL)'); }
  read(id: string): PermissionConfig { this.expert(id); const row = this.db.prepare('SELECT value FROM permissions_v3 WHERE id=?').get(id) as { value: string } | undefined; return row ? JSON.parse(row.value) : defaultPermissions(); }
  save(id: string, value: PermissionConfig): void {
    this.expert(id);
    for (const key of ['tools', 'files', 'builtin', 'model'] as const) if (typeof value[key] !== 'boolean') throw new Error('权限开关无效');
    if (!Array.isArray(value.paths) || value.paths.length > 100 || !Array.isArray(value.models) || value.models.length > 100) throw new Error('权限清单无效');
    const paths = value.paths.map(item => { required(item, '敏感路径', 2000); if (!path.isAbsolute(item)) throw new Error('敏感路径须为本机绝对路径'); if (!fs.existsSync(item)) throw new Error('敏感路径不存在'); return fs.realpathSync(item); });
    const policies: Record<string, Policy> = {};
    for (const [key, policy] of Object.entries(value.policies)) { if (!builtinNames.includes(key) || !['allow', 'ask', 'deny'].includes(policy)) throw new Error('工具策略无效'); policies[key] = policy; }
    const config = { ...value, paths: [...new Set(paths)], policies, models: value.models.map(item => required(item, '模型 ID', 100)) };
    this.db.prepare('INSERT INTO permissions_v3 VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(id, JSON.stringify(config));
  }
  checkModel(id: string, model: string): void { const p = this.read(id); if (p.model && !p.models.includes(model)) throw new Error('模型安全策略禁止当前模型，请在专家权限中批准该模型'); }
  decision(member: TaskMember, call: WireCall, taskId?: string): Policy {
    const p = this.read(member.expertId);
    if (!builtinNames.includes(call.function.name)) return 'deny';
    if (p.tools && (call.function.arguments.length > 120000 || Object.keys(parseTool(call)).length > 20)) return 'deny';
    if (p.files && ['read_project_file', 'write_artifact'].includes(call.function.name)) {
      const input = parseTool(call), relative = required(input.file, '文件路径', 300);
      const file = safeTaskPath(member.directory, call.function.name === 'write_artifact' ? `Soul-Outputs/${required(taskId, '任务 ID', 100)}/${relative}` : relative);
      const parent = fs.existsSync(file) ? fs.realpathSync(file) : fs.realpathSync(member.directory) + path.sep + path.relative(member.directory, file);
      if (p.paths.some(root => { const rel = path.relative(root, parent); return !rel || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); })) return 'deny';
    }
    const mode = p.builtin ? p.policies[call.function.name] ?? defaultPermissions().policies[call.function.name] : 'allow';
    if (mode === 'deny') return mode;
    // Approved policy never bypasses the existing artifact approval boundary.
    if (call.function.name === 'write_artifact' || call.function.name === 'call_connector_tool') return 'ask';
    return mode;
  }
  close(): void { this.db.close(); }
}
