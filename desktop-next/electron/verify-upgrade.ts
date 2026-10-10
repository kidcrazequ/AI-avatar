import { app, type BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import type { ExpertLibrary } from './expert-library';
import type { UpdateManager } from './update-manager';
import { backupProfile } from './profile-upgrade';

function fingerprint(profile: string) {
  const db = new Database(path.join(profile, 'soul.sqlite'), { readonly: true });
  try {
    const tables = ['experts','expert_groups','resource_projects','resource_collections','resource_versions','permissions_v3','preferences_v3','task_models_v3','tasks_v3','task_commands_v3','workflows_v3','workflow_runs_v3','im_channels_v3','im_sessions_v3','im_events_v3'];
    const result: Record<string, string> = {};
    for (const table of tables) result[table] = crypto.createHash('sha256').update(JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())).digest('hex');
    return result;
  } finally { db.close(); }
}
export async function verifyUpgrade(window: BrowserWindow, updates: UpdateManager, library: ExpertLibrary, profile: string, output: string, mode: string, migration: unknown) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const report: Record<string, unknown> = { ok: true, version: app.getVersion(), packaged: app.isPackaged, platform: process.platform, arch: process.arch, execPath: process.execPath, migration, mode };
  if (!app.isPackaged) throw new Error('Upgrade acceptance requires an installed packaged app');
  if (mode === 'prepare') {
    library.installExpert('finance-expert'); library.renameExpert('finance-expert', '升级验收财研');
    const memory = path.join(library.resourceLocation('finance-expert').root, 'memory/MEMORY.md');
    fs.writeFileSync(memory, '升级前保存的真实专家记忆\n');
    const fixture = await window.webContents.executeJavaScript(`(async()=>{
      const api=window.soulDesktop;const settings=await api.settings.read();await api.settings.save({...settings.preferences,reply:'English',directory:${JSON.stringify(profile)}});
      const taskId=await api.tasks.send({requestId:crypto.randomUUID(),taskId:'',expertId:'finance-expert',groupId:'',model:'Auto',directory:${JSON.stringify(profile)},projectId:'',text:'升级验收：保留待审批任务，不执行写入',attachments:[]});
      for(let n=0;n<250;n++){const task=(await api.tasks.read()).tasks.find(t=>t.id===taskId);if(task?.status==='waiting')return {id:task.id,approval:task.approvals[0].id,round:task.rounds[0].id,roundCount:task.rounds.length,messages:task.messages.length,destination:task.approvals[0].destination};await new Promise(resolve=>setTimeout(resolve,20))}throw new Error('Approval fixture timeout')})()`);
    if (fs.existsSync(fixture.destination)) throw new Error('Unapproved artifact was written');
    report.task = fixture;
    updates.automatic(false);
    report.fingerprint = fingerprint(profile);
    report.memorySha256 = crypto.createHash('sha256').update(fs.readFileSync(memory)).digest('hex');
    fs.writeFileSync(path.join(profile, 'upgrade-baseline.json'), JSON.stringify(report));
  } else {
    const before = JSON.parse(fs.readFileSync(path.join(profile, 'upgrade-baseline.json'), 'utf8'));
    const now = fingerprint(profile);
    if (JSON.stringify(before.fingerprint) !== JSON.stringify(now)) throw new Error('Saved business data changed during upgrade');
    const memory = path.join(library.resourceLocation('finance-expert').root, 'memory/MEMORY.md');
    if (before.memorySha256 !== crypto.createHash('sha256').update(fs.readFileSync(memory)).digest('hex') || library.detail('finance-expert').name !== '升级验收财研' || updates.read().automatic !== false) throw new Error('Expert memory, name or update preferences lost during upgrade');
    report.preservedBusinessTables = Object.keys(now).length; report.preservedExpertMemory = true; report.preservedAutomatic = true;
    if (mode === 'offline' || mode === 'corrupt') {
      try { await updates.check(); if (mode === 'corrupt') await updates.download(); }
      catch { /* This scenario intentionally exercises a rejected network response. */ }
      if (updates.read().state !== 'error') throw new Error('Failed update was reported as available or current');
      if (mode === 'corrupt' && !updates.read().error.includes('校验')) throw new Error('Corrupt installer did not reach checksum verification');
      report.rejected = updates.read();
    }
    if (mode === 'backup') report.backup = await backupProfile(profile, 'manual-upgrade');
    if (mode === 'install' || mode === 'check') {
      await updates.check();
      if (updates.read().state !== 'available') throw new Error('Actual updater did not discover target version');
      report.discovered = updates.read();
      if (mode === 'install') {
        await updates.download();
        if (updates.read().state !== 'ready') throw new Error('Actual updater did not verify downloaded installer');
        report.download = updates.read();
        fs.writeFileSync(output, JSON.stringify(report, null, 2));
        await updates.install(true);
        fs.writeFileSync(output, JSON.stringify({ ...report, installed: updates.read() }, null, 2));
        return;
      }
    }
  }
  for (const [width,height] of [[1440,900],[1280,800]]) {
    window.setContentSize(width,height);
    await window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{let n=0;const poll=()=>{if(innerWidth===${width}&&innerHeight===${height}&&document.querySelector('[data-runtime-ready="true"]'))return resolve(true);if(++n>250)return reject(new Error('Upgrade renderer timeout'));setTimeout(poll,20)};poll()})`);
    fs.writeFileSync(path.join(path.dirname(output), `upgrade-${mode}-${width}.png`), (await window.webContents.capturePage()).toPNG());
  }
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  app.quit();
}
