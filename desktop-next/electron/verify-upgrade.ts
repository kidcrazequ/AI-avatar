import { app, type BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import type { ExpertLibrary } from './expert-library';
import type { ResourceStore } from './resources';
import type { TaskRecord } from '../shared/contracts';
import type { UpdateManager } from './update-manager';
import { backupProfile } from './profile-upgrade';

function fingerprint(profile: string) {
  const db = new Database(path.join(profile, 'soul.sqlite'), { readonly: true });
  try {
    const tables = ['experts','expert_groups','resource_projects','resource_collections','resource_versions','permissions_v3','preferences_v3','task_models_v3','tasks_v3','task_commands_v3','workflows_v3','workflow_runs_v3','im_channels_v3','im_sessions_v3','im_events_v3','knowledge_imports_v1','knowledge_documents_v1','knowledge_versions_v1','knowledge_learning_v1'];
    const result: Record<string, string> = {};
    for (const table of tables) result[table] = crypto.createHash('sha256').update(JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())).digest('hex');
    return result;
  } finally { db.close(); }
}
function knowledgeFiles(profile: string): Record<string, string> {
  const root = path.join(profile, 'knowledge'), result: Record<string, string> = {};
  const visit = (folder: string) => { for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
    const file = path.join(folder, entry.name); if (entry.isDirectory()) visit(file);
    else if (entry.isFile()) result[path.relative(root, file).split(path.sep).join('/')] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } }; visit(root); return result;
}
function taskRecord(profile: string, id: string): TaskRecord {
  const db = new Database(path.join(profile, 'soul.sqlite'), { readonly: true });
  try { return JSON.parse((db.prepare('SELECT value FROM tasks_v3 WHERE id=?').get(id) as { value: string }).value); }
  finally { db.close(); }
}
export async function verifyUpgrade(window: BrowserWindow, updates: UpdateManager, library: ExpertLibrary, resources: ResourceStore, profile: string, output: string, mode: string, migration: unknown) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const report: Record<string, unknown> = { ok: true, version: app.getVersion(), packaged: app.isPackaged, platform: process.platform, arch: process.arch, execPath: process.execPath, migration, mode };
  if (!app.isPackaged) throw new Error('Upgrade acceptance requires an installed packaged app');
  if (mode === 'prepare') {
    library.installExpert('finance-expert'); library.renameExpert('finance-expert', '升级验收财研');
    const memory = path.join(library.resourceLocation('finance-expert').root, 'memory/MEMORY.md');
    fs.writeFileSync(memory, '升级前保存的真实专家记忆\n');
    const fixture = await window.webContents.executeJavaScript(`(async()=>{
      const api=window.soulDesktop;const settings=await api.settings.read();await api.settings.save({...settings.preferences,reply:'English',directory:${JSON.stringify(profile)}});
      const resource=api.resources; await resource.saveCollection('', '升级知识验收'); const collection=(await resource.read('')).collections.find(c=>c.title==='升级知识验收');
      const bindings=(await resource.read('finance-expert')).bindings;await resource.bind('finance-expert',[...bindings,collection.id]);
      const importVersion=async()=>{const batch=await resource.knowledge.chooseImport(collection.id,'finance-expert','files');for(let n=0;n<1000;n++){const value=(await resource.knowledge.batches(collection.id,'finance-expert')).find(b=>b.id===batch.id);if(!['queued','running'].includes(value.state)){if(value.items[0].state!=='ready')throw new Error('Upgrade source import failed');return (await resource.documents(collection.id,'finance-expert')).find(d=>d.name==='升级版来源.csv')}await new Promise(r=>setTimeout(r,20))}throw new Error('Upgrade source timeout')};
      const original=await importVersion();const prepared=await resource.knowledge.learning.preview({collectionId:collection.id,documentId:original.id,scope:'finance-expert',model:'Auto',lineStart:1,lineEnd:4});
      const job=await resource.knowledge.learning.start(prepared.token,'finance-expert');let learned;for(let n=0;n<250;n++){learned=await resource.knowledge.learning.read(job.id,'finance-expert');if(learned.state==='completed')break;await new Promise(r=>setTimeout(r,20))}if(learned?.state!=='completed')throw new Error('Upgrade learning fixture failed');
      const taskId=await api.tasks.send({requestId:crypto.randomUUID(),taskId:'',expertId:'finance-expert',groupId:'',model:'Auto',directory:${JSON.stringify(profile)},projectId:'',text:'升级验收：保留待审批任务，不执行写入',attachments:[]});
      for(let n=0;n<250;n++){const task=(await api.tasks.read()).tasks.find(t=>t.id===taskId);if(task?.status==='waiting'){const current=await importVersion();if(current.sourceVersion===original.sourceVersion)throw new Error('Upgrade needs two distinct source versions');return {knowledge:{collection:collection.id,original:original.sourceVersion,current:current.sourceVersion,document:original.id,learning:learned},id:task.id,approval:task.approvals[0].id,round:task.rounds[0].id,roundCount:task.rounds.length,messages:task.messages.length,destination:task.approvals[0].destination}};await new Promise(resolve=>setTimeout(resolve,20))}throw new Error('Approval fixture timeout')})()`);
    if (fs.existsSync(fixture.destination)) throw new Error('Unapproved artifact was written');
    const source = taskRecord(profile, fixture.id).members[0].knowledge.find(file => file.id === `${fixture.knowledge.collection}/${fixture.knowledge.document}`)!;
    if (!source?.reference || source.reference.version !== fixture.knowledge.original) throw new Error('Task did not freeze its original source version');
    report.task = fixture; report.pinnedSource = source;
    report.knowledgeFiles = knowledgeFiles(profile);
    updates.automatic(false);
    report.fingerprint = fingerprint(profile);
    report.memorySha256 = crypto.createHash('sha256').update(fs.readFileSync(memory)).digest('hex');
    fs.writeFileSync(path.join(profile, 'upgrade-baseline.json'), JSON.stringify(report));
  } else {
    const before = JSON.parse(fs.readFileSync(path.join(profile, 'upgrade-baseline.json'), 'utf8'));
    const now = fingerprint(profile);
    if (JSON.stringify(before.fingerprint) !== JSON.stringify(now)) throw new Error('Saved business data changed during upgrade');
    if (JSON.stringify(before.knowledgeFiles) !== JSON.stringify(knowledgeFiles(profile))) throw new Error('Knowledge source files changed during upgrade');
    const source = taskRecord(profile, before.task.id).members[0].knowledge.find(file => file.id === before.pinnedSource.id)!;
    if (JSON.stringify(source) !== JSON.stringify(before.pinnedSource)) throw new Error('Pinned task reference changed during upgrade');
    const range = await resources.lookup.execute(resources.lookup.taskSources([source]), { operation: 'read', id: source.id });
    if (!('content' in range) || !range.content.includes('UPGRADEKNOWLEDGE62709-1') || range.content.includes('UPGRADEKNOWLEDGE62709-2') || range.version !== before.task.knowledge.original) throw new Error('Upgraded task reads a newer source version');
    const learning = await window.webContents.executeJavaScript(`window.soulDesktop.resources.knowledge.learning.read(${JSON.stringify(before.task.knowledge.learning.id)}, 'finance-expert')`);
    if (JSON.stringify(learning) !== JSON.stringify(before.task.knowledge.learning)) throw new Error('Learning provenance or usage changed during upgrade');
    report.preservedKnowledgeFiles = Object.keys(before.knowledgeFiles).length; report.preservedPinnedSource = range.version; report.preservedLearning = {id:learning.id,version:learning.reference.version,usage:learning.parts[0].usage,state:learning.state};
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
