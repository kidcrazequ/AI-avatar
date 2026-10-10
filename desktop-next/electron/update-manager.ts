import Database from 'better-sqlite3';
import path from 'node:path';
import type { AppUpdater } from 'electron-updater';
import { CancellationToken } from 'builder-util-runtime';
import type { UpdatePolicy, UpdateSnapshot } from '../shared/updates';

export function validateFeed(value: string, test = false): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(test && url.protocol === 'http:' && url.hostname === '127.0.0.1'))) throw new Error('正式更新源必须使用无凭据的 HTTPS 地址');
  return url.href.endsWith('/') ? url.href : url.href + '/';
}
type Driver = Pick<AppUpdater, 'on' | 'removeAllListeners' | 'checkForUpdates' | 'downloadUpdate' | 'quitAndInstall' | 'autoDownload' | 'autoInstallOnAppQuit' | 'allowDowngrade' | 'allowPrerelease' | 'channel' | 'disableWebInstaller' | 'setFeedURL'>;
export class UpdateManager {
  private db: Database.Database;
  private value: UpdateSnapshot;
  private operation = false;
  private token?: CancellationToken;
  private timer?: NodeJS.Timeout;
  private closed = false;
  constructor(profile: string, version: string, private policy: UpdatePolicy | null, private driver: Driver, private changed: () => void,
    private active: () => boolean, private prepare: () => Promise<string>, private installBlocked = '', test = false) {
    this.db = new Database(path.join(profile, 'soul.sqlite')); this.db.exec('CREATE TABLE IF NOT EXISTS updates_v3(id TEXT PRIMARY KEY,value TEXT NOT NULL)');
    const row = this.db.prepare('SELECT value FROM updates_v3 WHERE id=?').get('automatic') as { value: string } | undefined;
    if (policy) { validateFeed(policy.url, test); if (!['latest', 'candidate'].includes(policy.channel)) throw new Error('更新渠道无效'); }
    this.value = { state: policy ? 'idle' : 'unconfigured', version, nextVersion: '', percent: 0, transferred: 0, total: 0, checkedAt: '', error: '', automatic: row ? row.value === 'true' : true, channel: policy?.channel ?? '', configured: Boolean(policy), installBlocked, backup: '' };
    driver.autoDownload = false; driver.autoInstallOnAppQuit = false; driver.allowDowngrade = false; driver.allowPrerelease = policy?.channel === 'candidate'; driver.disableWebInstaller = true;
    if (policy) { driver.setFeedURL({ provider: 'generic', url: policy.url }); driver.channel = policy.channel; }
    driver.on('update-available', info => this.patch({ state: 'available', nextVersion: info.version }));
    driver.on('update-not-available', () => this.patch({ state: 'idle', nextVersion: '', error: '' }));
    driver.on('download-progress', p => { if (!this.token?.cancelled) this.patch({ state: 'downloading', percent: Math.max(0, Math.min(100, p.percent)), transferred: p.transferred, total: p.total }); });
    driver.on('update-downloaded', () => this.patch({ state: 'ready', percent: 100, error: '' }));
    driver.on('error', e => this.failed(e));
  }
  read(): UpdateSnapshot { return { ...this.value }; }
  private patch(value: Partial<UpdateSnapshot>): void { if (this.closed) return; this.value = { ...this.value, ...value }; this.changed(); }
  private failed(error: unknown): void {
    if (this.closed) return;
    const code = (error as { code?: string })?.code ?? '';
    const message = code.includes('CHECKSUM') ? '更新包校验失败，请重新检查和下载' : code.includes('SIGNATURE') ? '更新包签名校验失败，未安装' : code.includes('CANCEL') ? '下载已取消' : '更新失败，请检查网络、更新服务与签名配置后重试';
    this.patch({ state: this.token?.cancelled ? 'cancelled' : 'error', error: this.token?.cancelled ? '' : message });
  }
  automatic(value: boolean): void { if (typeof value !== 'boolean') throw new Error('自动更新设置无效'); this.db.prepare('INSERT INTO updates_v3 VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run('automatic', String(value)); this.patch({ automatic: value }); }
  start(): void {
    if (!this.policy) return;
    const check = () => { if (this.value.automatic && !this.operation && !['ready', 'installing'].includes(this.value.state)) void this.check().catch(() => {}); };
    this.timer = setInterval(check, 4 * 60 * 60 * 1000); this.timer.unref(); setTimeout(() => { if (!this.closed) check(); }, 15_000).unref();
  }
  async check(): Promise<void> {
    if (!this.policy) throw new Error('更新服务未配置');
    if (this.operation || ['ready', 'installing'].includes(this.value.state)) throw new Error('请先完成当前更新');
    this.operation = true; this.patch({ state: 'checking', error: '', nextVersion: '', percent: 0 });
    try { await this.driver.checkForUpdates(); this.patch({ checkedAt: new Date().toISOString() }); }
    catch (e) { this.failed(e); throw new Error(this.value.error); }
    finally { this.operation = false; }
    if (this.value.state === 'available' && this.value.automatic && !this.installBlocked) await this.download();
  }
  async download(): Promise<void> {
    if (this.operation || this.value.state !== 'available') throw new Error('请先检查可用更新');
    if (this.installBlocked) throw new Error(this.installBlocked);
    this.operation = true; this.token = new CancellationToken(); this.patch({ state: 'downloading', error: '', percent: 0 });
    try { await this.driver.downloadUpdate(this.token); if (this.token.cancelled) this.patch({ state: 'cancelled' }); }
    catch (e) { this.failed(e); if (!this.token.cancelled) throw new Error(this.value.error); }
    finally { this.token = undefined; this.operation = false; }
  }
  cancel(): void { if (this.value.state !== 'downloading') throw new Error('没有正在下载的更新'); this.token?.cancel(); this.patch({ state: 'cancelled', error: '' }); }
  async install(test = false): Promise<void> {
    if (this.operation || this.value.state !== 'ready') throw new Error('更新尚未校验完成');
    if (this.installBlocked) throw new Error(this.installBlocked);
    if (this.active()) throw new Error('请先停止运行中的任务或外部发送，再安装更新');
    this.operation = true; this.patch({ state: 'installing', error: '' });
    try { const backup = await this.prepare(); this.patch({ backup }); this.driver.quitAndInstall(test, !test); }
    catch { this.patch({ state: 'error', error: '升级前备份或准备失败，未安装更新' }); throw new Error(this.value.error); }
    finally { this.operation = false; }
  }
  close(): void { this.closed = true; this.token?.cancel(); if (this.timer) clearInterval(this.timer); this.driver.removeAllListeners(); this.driver.on('error', () => {}); this.db.close(); }
}
