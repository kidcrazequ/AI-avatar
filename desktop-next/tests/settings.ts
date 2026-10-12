import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { AppSettings } from '../electron/app-settings';

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-settings-')), output = process.argv[2];
  const legacy = { theme: 'dark', reply: '中文', startup: false, awake: false, directory: '' };
  const db = new Database(path.join(profile, 'soul.sqlite')); db.exec('CREATE TABLE preferences_v3(id TEXT PRIMARY KEY,value TEXT NOT NULL)'); db.prepare('INSERT INTO preferences_v3 VALUES (?,?)').run('app', JSON.stringify(legacy)); db.close();
  let startup = false, startupWrites = 0, count = 2, wake = false, refuseStartup = false;
  const adapter = { startup: () => startup, setStartup(value: boolean) { startupWrites++; if (!refuseStartup) startup = value; }, wake(value: boolean) { wake = value; return value; }, encryption: () => true, open: async () => {} };
  const status = { version: 'fixture', experts: [], resources: { files: 1142, bytes: 0, sha256: '' }, checks: [], platform: process.platform, arch: process.arch, sourceSha: '', persistenceRun: 1 };
  let settings = new AppSettings(profile, { list: () => [] }, status, adapter, () => count);
  const checks: string[] = [], check = async (name: string, apply: () => void | Promise<void>) => { await apply(); checks.push(name); };
  try {
    await check('older-preferences-remain-readable-without-device-name-migration', () => assert.deepEqual(settings.preferences(), legacy));
    await check('device-alias-is-local-display-only-and-does-not-change-system-startup-or-host', () => { settings.save({ ...settings.preferences(), deviceName: ' 合成验收设备 ' }); assert.equal(settings.preferences().deviceName, '合成验收设备'); assert.equal(settings.read().host, os.hostname()); assert.equal(startupWrites, 0); });
    await check('device-count-uses-current-installed-instances-instead-of-bundled-role-count', () => { assert.equal(settings.read().installedExperts, 2); count = 7; assert.equal(settings.read().installedExperts, 7); assert.equal(settings.read().status.experts.length, 0); });
    await check('invalid-device-alias-cannot-partially-save-other-preferences', () => { const before = settings.preferences(); assert.throws(() => settings.save({ ...before, theme: 'light', deviceName: 'a'.repeat(81) })); assert.deepEqual(settings.preferences(), before); });
    await check('system-rejected-startup-setting-does-not-report-success-or-persist-request', () => { const before = settings.preferences(); refuseStartup = true; assert.throws(() => settings.save({ ...before, startup: true }), /未应用/); assert.deepEqual(settings.preferences(), before); refuseStartup = false; });
    await check('wake-lock-follows-active-tasks-and-is-released-on-close', () => { settings.save({ ...settings.preferences(), awake: true }); settings.activity(false); assert.equal(wake, false); settings.activity(true); assert.equal(wake, true); settings.close(); assert.equal(wake, false); settings = new AppSettings(profile, { list: () => [] }, status, adapter, () => count); assert.equal(settings.preferences().deviceName, '合成验收设备'); assert.equal(settings.read().awakeActive, false); });
    await check('local-diagnostic-is-source-backed-and-does-not-require-a-model-call', async () => { const result = await settings.diagnose(); assert.equal(result.length, 3); assert(result.every(item => item.ok)); assert(fs.existsSync(path.join(profile, 'logs/diagnostics.json'))); });
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify({ ok: true, checks, platform: process.platform, arch: process.arch }, null, 2)); console.log(JSON.stringify({ ok: true, checks }));
  } finally { settings.close(); fs.rmSync(profile, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
