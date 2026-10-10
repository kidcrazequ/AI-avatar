import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { UpdateManager, validateFeed } from '../electron/update-manager';
import { migrateProfile, backupProfile } from '../electron/profile-upgrade';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-update-tests-'));
const checks: string[] = [];
const hash = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
class Driver extends EventEmitter {
  autoDownload=true;autoInstallOnAppQuit=true;allowDowngrade=true;allowPrerelease=false;channel='';disableWebInstaller=false;
  checks=0;downloads=0;installs=0;available=true;failure=false;corrupt=false;
  setFeedURL() {}
  async checkForUpdates(){this.checks++;if(this.failure)throw new Error('offline');this.emit(this.available?'update-available':'update-not-available',{version:'0.20.0-alpha.8'});return null;}
  async downloadUpdate(_token?:{cancelled:boolean}){this.downloads++;this.emit('download-progress',{percent:65,transferred:65,total:100});if(this.corrupt)throw Object.assign(new Error('corrupt'),{code:'ERR_UPDATER_CHECKSUM_MISMATCH'});this.emit('update-downloaded');return ['installer.exe'];}
  quitAndInstall(){this.installs++;}
}
let index=0;
function fixture(configured=true, blocked='') {
 const profile=path.join(root,String(index++));fs.mkdirSync(profile);const driver=new Driver();let busy=false;let backups=0;let fail=false;
 const manager=new UpdateManager(profile,'0.20.0-alpha.7',configured?{url:'https://updates.example.com/win32/x64/',channel:'candidate',production:false}:null,driver as any,()=>{},()=>busy,async()=>{backups++;if(fail)throw new Error('disk full');return '/saved/backup';},blocked);
 return {profile,driver,manager,busy:(v:boolean)=>busy=v,fail:()=>fail=true,backups:()=>backups};
}
async function main() {
try {
 const a=fixture(false);await assert.rejects(a.manager.check(),/未配置/);assert.equal(a.driver.checks,0);assert.equal(a.manager.read().state,'unconfigured');a.manager.close();checks.push('unconfigured-never-requests-or-claims-current');
 assert.throws(()=>validateFeed('http://example.com'));assert.throws(()=>validateFeed('https://x.test/?token=secret'));assert.throws(()=>validateFeed('https://user:secret@x.test'));assert.equal(validateFeed('http://127.0.0.1:3000',true),'http://127.0.0.1:3000/');checks.push('production-feed-rejects-http-and-embedded-secrets');
 const b=fixture();b.manager.automatic(false);await b.manager.check();assert.equal(b.manager.read().state,'available');assert.equal(b.driver.downloads,0);assert.equal(b.driver.autoInstallOnAppQuit,false);assert.equal(b.driver.allowDowngrade,false);await b.manager.download();assert.equal(b.manager.read().state,'ready');assert.equal(b.driver.installs,0);checks.push('verified-download-waits-for-explicit-install-never-installs-on-quit');
 b.busy(true);await assert.rejects(b.manager.install(),/停止/);assert.equal(b.backups(),0);assert.equal(b.driver.installs,0);b.busy(false);await b.manager.install();assert.equal(b.backups(),1);assert.equal(b.driver.installs,1);b.manager.close();checks.push('running-work-and-external-send-block-install-before-backup');
 const c=fixture();c.manager.automatic(false);c.driver.available=false;await c.manager.check();assert.equal(c.manager.read().state,'idle');c.driver.failure=true;await assert.rejects(c.manager.check());assert.equal(c.manager.read().state,'error');assert.ok(c.manager.read().error);c.manager.close();checks.push('offline-failure-is-distinct-from-no-update');
 const d=fixture();d.manager.automatic(false);d.driver.corrupt=true;await d.manager.check();await assert.rejects(d.manager.download(),/校验/);assert.equal(d.manager.read().state,'error');assert.equal(d.driver.installs,0);d.manager.close();checks.push('corrupt-download-never-becomes-installable');
 const e=fixture();e.manager.automatic(false);await e.manager.check();await e.manager.download();e.fail();await assert.rejects(e.manager.install(),/备份/);assert.equal(e.driver.installs,0);e.manager.close();checks.push('failed-backup-prevents-install');
 const f=fixture(true,'需要签名');f.manager.automatic(false);await f.manager.check();await assert.rejects(f.manager.download(),/签名/);assert.equal(f.driver.downloads,0);f.manager.close();checks.push('unsigned-mac-blocks-automatic-install-without-bypassing-signature');
 const g=fixture();g.manager.automatic(false);g.manager.close();const reopen=new UpdateManager(g.profile,'0.20.0-alpha.7',null,new Driver() as any,()=>{},()=>false,async()=>'', '');assert.equal(reopen.read().automatic,false);assert.equal(reopen.read().state,'unconfigured');reopen.close();checks.push('update-preferences-persist-ready-state-does-not-lie-after-restart');
 const h=fixture();h.manager.automatic(false);await h.manager.check();h.driver.downloadUpdate=async token=>{h.driver.emit('download-progress',{percent:5,transferred:5,total:100});h.manager.cancel();h.driver.emit('download-progress',{percent:6,transferred:6,total:100});assert.equal(token?.cancelled,true);throw Object.assign(new Error('cancelled'),{code:'ERR_UPDATER_CANCELLED'})};await h.manager.download();assert.equal(h.manager.read().state,'cancelled');assert.equal(h.driver.installs,0);h.manager.close();checks.push('cancelled-download-cannot-return-to-downloading-or-install');
 const i=fixture();await i.manager.check();assert.equal(i.manager.read().state,'ready');assert.equal(i.driver.downloads,1);assert.equal(i.driver.installs,0);await assert.rejects(i.manager.check(),/当前更新/);i.manager.close();checks.push('automatic-check-downloads-once-but-never-restarts');
 const j=fixture();j.manager.automatic(false);await j.manager.check();await j.manager.download();j.driver.quitAndInstall=()=>{j.driver.emit('error',new Error('installer launch failed'))};await assert.rejects(j.manager.install());assert.equal(j.manager.read().state,'error');assert.equal(j.backups(),1);j.manager.close();checks.push('installer-launch-failure-keeps-backup-and-reports-error');
 const old=path.join(root,'schema-old');fs.mkdirSync(old);const file=path.join(old,'soul.sqlite');const db=new Database(file);db.pragma('journal_mode=WAL');db.exec('CREATE TABLE tasks_v3(id TEXT PRIMARY KEY,value TEXT NOT NULL)');const task=JSON.stringify({id:'existing',status:'waiting',messages:[{role:'user',text:'只处理一次'}],rounds:[{id:'paid-round',state:'done'}],approvals:[{id:'pending-approval',state:'pending'}]});db.prepare('INSERT INTO tasks_v3 VALUES (?,?)').run('existing',task);
 fs.mkdirSync(path.join(old,'avatars/expert/memory'),{recursive:true});fs.writeFileSync(path.join(old,'avatars/expert/memory/MEMORY.md'),'保留原记忆');const memory=hash(path.join(old,'avatars/expert/memory/MEMORY.md'));
 const result=await migrateProfile(old);assert.equal(result.from,1);assert.equal(result.to,2);assert.ok(result.backup);assert.equal(db.prepare('SELECT value FROM tasks_v3').pluck().get(),task);const saved=new Database(path.join(result.backup,'soul.sqlite'),{readonly:true});assert.equal(saved.prepare('SELECT value FROM tasks_v3').pluck().get(),task);saved.close();assert.equal(hash(path.join(result.backup,'avatars/expert/memory/MEMORY.md')),memory);db.close();checks.push('baseline-migration-backs-up-committed-wal-paid-rounds-and-pending-approval');
 const again=await migrateProfile(old);assert.equal(again.backup,'');checks.push('migration-is-idempotent');
 const newer=path.join(root,'newer');fs.mkdirSync(newer);const nd=new Database(path.join(newer,'soul.sqlite'));nd.exec('CREATE TABLE profile_schema_v3(id INTEGER PRIMARY KEY,version INTEGER);INSERT INTO profile_schema_v3 VALUES (1,999)');nd.close();const before=hash(path.join(newer,'soul.sqlite'));await assert.rejects(migrateProfile(newer),/较新版本/);assert.equal(hash(path.join(newer,'soul.sqlite')),before);checks.push('newer-schema-rejected-with-original-database-unchanged');
 const snapshot=await backupProfile(old,'pre-update');const manifest=JSON.parse(fs.readFileSync(path.join(snapshot,'manifest.json'),'utf8'));for(const item of manifest.entries)assert.equal(hash(path.join(snapshot,item.path)),item.sha256);checks.push('pre-install-backup-manifest-validates-database-and-owned-files');
 const output=process.argv[2];fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify({ok:true,platform:process.platform,arch:process.arch,checks,provider:'controlled updater event driver; native SQLite WAL and file backups'},null,2));console.log(JSON.stringify({ok:true,checks}));
} finally {fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
}
void main().catch(error => { console.error(error); process.exit(1); });
