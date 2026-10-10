import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import type { AppPreferences, SettingsSnapshot } from '../shared/integrations';
import type { RuntimeStatus } from '../shared/contracts';
import type { TaskModels } from './task-models';
import { required } from './task-repository';
export interface SystemAdapter { setStartup(value: boolean): void; startup(): boolean; wake(start: boolean): boolean; encryption(): boolean; open(file: string): Promise<void> }
export const defaultPreferences = (): AppPreferences => ({ theme: 'light', reply: '中文', startup: false, awake: false, directory: '' });
export class AppSettings {
  private db: Database.Database;
  private awakeActive = false;
  constructor(private profile: string, private models: Pick<TaskModels, 'list'>, private status: RuntimeStatus, private system: SystemAdapter) {
    this.db = new Database(path.join(profile, 'soul.sqlite')); this.db.exec('CREATE TABLE IF NOT EXISTS preferences_v3(id TEXT PRIMARY KEY,value TEXT NOT NULL)');
  }
  preferences(): AppPreferences { const row = this.db.prepare('SELECT value FROM preferences_v3 WHERE id=?').get('app') as { value: string } | undefined; return row ? JSON.parse(row.value) : defaultPreferences(); }
  read(): SettingsSnapshot { return { preferences: this.preferences(), host: os.hostname(), platform: process.platform, arch: process.arch, version: this.status.version, profile: this.profile, models: this.models.list(), awakeActive: this.awakeActive, startupActual: this.system.startup(), status: this.status }; }
  save(input: AppPreferences): void {
    if (!['light', 'dark', 'system'].includes(input.theme) || !['中文', 'English', '跟随任务'].includes(input.reply) || typeof input.startup !== 'boolean' || typeof input.awake !== 'boolean') throw new Error('系统偏好无效');
    required(input.directory, '默认目录', 2000, true);
    if (input.directory && (!path.isAbsolute(input.directory) || !fs.statSync(input.directory).isDirectory() || fs.lstatSync(input.directory).isSymbolicLink())) throw new Error('默认目录须为存在的本机目录');
    if (input.startup !== this.system.startup()) { this.system.setStartup(input.startup); if (input.startup !== this.system.startup()) throw new Error('系统未应用启动项，请检查操作系统设置'); }
    this.db.prepare('INSERT INTO preferences_v3 VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run('app', JSON.stringify(input));
  }
  activity(running: boolean): void { const desired = this.preferences().awake && running; if (desired !== this.awakeActive) this.awakeActive = this.system.wake(desired); }
  async diagnose(): Promise<Array<{ name: string; ok: boolean; detail: string }>> {
    const encrypted = this.system.encryption();
    const entries = [{ name: '本机运行与资源', ok: this.status.checks.every(c => c.ok), detail: `${this.status.resources.files} 份打包资源 · ${process.platform}/${process.arch}` }, { name: '持久存储', ok: (this.db.prepare('PRAGMA quick_check').get() as { quick_check: string }).quick_check === 'ok', detail: 'SQLite quick_check 已执行' }, { name: '系统凭据', ok: encrypted, detail: encrypted ? '系统凭据加密可用；诊断不导出密钥' : '系统凭据加密不可用；禁止保存新密钥' }];
    for (const model of this.models.list()) { try { const res = await fetch(model.baseUrl, { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(5000) }); entries.push({ name: model.label, ok: true, detail: `服务已响应 HTTP ${res.status}；未发起计费模型调用` }); } catch { entries.push({ name: model.label, ok: false, detail: '服务未响应，请检查网络和配置' }); } }
    fs.mkdirSync(path.join(this.profile, 'logs'), { recursive: true }); fs.writeFileSync(path.join(this.profile, 'logs/diagnostics.json'), JSON.stringify({ at: new Date().toISOString(), version: this.status.version, entries }, null, 2)); return entries;
  }
  async openLogs(): Promise<void> { const dir = path.join(this.profile, 'logs'); fs.mkdirSync(dir, { recursive: true }); await this.system.open(dir); }
  close(): void { if (this.awakeActive) this.system.wake(false); this.db.close(); }
}
