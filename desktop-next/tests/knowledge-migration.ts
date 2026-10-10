import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import * as XLSX from 'xlsx';
import { ExpertLibrary } from '../electron/expert-library';
import { ResourceStore } from '../electron/resources';
import { KnowledgeLearning } from '../electron/knowledge/learning-store';
import { backupProfile, migrateProfile } from '../electron/profile-upgrade';
import { UpdateManager } from '../electron/update-manager';
import type { KnowledgeImportKind } from '../shared/knowledge';

const [root, output, worker] = process.argv.slice(2);
const digest = (bytes: string | Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
const pause = () => new Promise(resolve => setTimeout(resolve, 30));
const model = { id: 'controlled', label: '迁移验收', model: 'controlled', baseUrl: 'http://127.0.0.1/v1', protocol: 'openai' as const, configured: true, apiKey: '' };
async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-migration-'));
  const library = new ExpertLibrary(root, profile); library.installExpert('finance-expert');
  const resources = new ResourceStore(root, profile, library, worker); resources.saveCollection('', '旧版资料兼容验收');
  const collection = resources.read('').collections.find(item => !item.builtin)!.id; resources.bind('finance-expert', [collection]);
  const checks: string[] = [];
  let learning: KnowledgeLearning | undefined, updater: UpdateManager | undefined;
  const check = async (name: string, action: () => Promise<void>) => { await action(); checks.push(name); console.log(name); };
  const run = async (source: string, kind: KnowledgeImportKind = 'legacy') => { const batch = await resources.knowledge.start(collection, '', [source], kind); for (let n = 0; n < 1500; n++) { const value = resources.knowledge.list(collection, '').find(item => item.id === batch.id)!; if (!['queued', 'running'].includes(value.state)) return value; await pause(); } throw new Error('Compatibility import did not complete'); };
  const exportJSON = (fileName: string, marker: string) => JSON.stringify({ fileName, importedAt: '2026-01-01T00:00:00Z', sheets: [{ name: '旧表', rowCount: 1, columns: [{ name: '编号', dtype: 'string' }, { name: '值', dtype: 'number' }], rows: [{ 编号: marker, 值: 42 }] }] });
  try {
    const legacy = path.join(profile, 'legacy-input'); fs.mkdirSync(path.join(legacy, '_raw'), { recursive: true }); fs.mkdirSync(path.join(legacy, '_excel'));
    fs.writeFileSync(path.join(legacy, '保留.md'), '# 旧版 Markdown\n原始知识事实 LEGACY62709');
    const rows = [['编号', '值'], ...Array.from({ length: 6001 }, (_, i) => [`原工作簿行${i + 1}`, i + 1])]; const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), '完整网格');
    const original = path.join(legacy, '_raw', '完整表.xlsx'); fs.writeFileSync(original, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
    const cached = path.join(legacy, '_excel', '完整表.JSON'); fs.writeFileSync(cached, exportJSON('完整表.xlsx', '只有旧导出首行'));
    const fallback = path.join(legacy, '_excel', '缺原件.json'); fs.writeFileSync(fallback, exportJSON('缺原件.xlsx', '0012345678901234567890'));
    const originalHashes = [original, cached, fallback, path.join(legacy, '保留.md')].map(file => [file, digest(fs.readFileSync(file))]);
    await check('Legacy Markdown and originals stay intact; original workbook takes precedence over lossy export and keeps rows beyond 5000', async () => {
      const batch = await run(legacy); assert.equal(batch.items.filter(item => item.state === 'ready').length, 2); assert.equal(batch.items.filter(item => item.state === 'partial').length, 1); assert.equal(batch.items.filter(item => item.state === 'skipped').length, 1); assert(!batch.items.some(item => item.state === 'failed'));
      for (const [file, hash] of originalHashes) assert.equal(digest(fs.readFileSync(file)), hash);
      const docs = resources.documents(collection, ''); assert.equal(docs.length, 3);
      const document = docs.find(item => item.name === '完整表.xlsx')!;
      const result = await resources.queryKnowledge('finance-expert', collection, { operation: 'table', id: `${collection}/${document.id}`, sheet: '完整网格', rowStart: 6002, rowEnd: 6002 });
      assert('rows' in result); assert.equal(result.rows[0].cells[0].value, '原工作簿行6001');
      assert((await resources.queryKnowledge('finance-expert', collection, { operation: 'search', query: 'LEGACY62709' }) as any).chunks.length);
    });
    await check('Export-only fallback preserves values and evidence while refusing fabricated physical cells; failed originals retain usable fallback', async () => {
      const document = resources.documents(collection, '').find(item => item.name === '缺原件.json')!;
      assert.equal(document.sourceStatus, 'partial'); const content = resources.readDocument(collection, document.id, ''); assert(content.content.includes('0012345678901234567890')); assert(content.content.includes('导出行 1'));
      const description = await resources.queryKnowledge('finance-expert', collection, { operation: 'describe', id: `${collection}/${document.id}` }); assert('tables' in description && description.tables.length === 0);
      const broken = path.join(profile, 'broken-input'); fs.mkdirSync(path.join(broken, '_raw'), { recursive: true }); fs.mkdirSync(path.join(broken, '_excel')); fs.writeFileSync(path.join(broken, '_raw', '坏原件.xlsx'), Buffer.from([0x50,0x4b,0x03,0x04,0xff,0xff,0xff,0xff])); fs.writeFileSync(path.join(broken, '_excel', '坏原件.json'), exportJSON('坏原件.xlsx', '可恢复导出值')); fs.writeFileSync(path.join(broken, '_excel', '配置.json'), JSON.stringify({ apiKey: 'not-a-knowledge-export' }));
      const batch = await run(broken); assert(batch.items.some(item => item.relativePath.endsWith('坏原件.json') && item.state === 'partial')); assert(batch.items.some(item => item.relativePath.endsWith('配置.json') && item.state === 'failed'));
      assert(!resources.documents(collection, '').some(item => item.name === '配置.json'));
    });
    await check('Import retry reuses source versions, produces no model call and permits reversible removal of migrated copies', async () => {
      const before = resources.documents(collection, '').map(item => [item.id, item.sourceVersion]); const batch = await run(legacy); assert(batch.items.filter(item => item.state === 'reused').length >= 3);
      assert.deepEqual(resources.documents(collection, '').map(item => [item.id, item.sourceVersion]), before);
      const document = resources.documents(collection, '').find(item => item.name === '保留.md')!, file = resources.readDocument(collection, document.id, ''); resources.removeDocument(collection, document.id, file.revision, ''); assert(!resources.documents(collection, '').some(item => item.id === document.id)); resources.restoreTrash(''); assert(resources.documents(collection, '').some(item => item.id === document.id));
      for (const [file, hash] of originalHashes) assert.equal(digest(fs.readFileSync(file)), hash);
    });
    await check('Active imports and independent learning block installation; backup and rollback keep manifests, immutable source versions and billing state', async () => {
      let calls = 0, backups = 0, installs = 0;
      learning = new KnowledgeLearning(profile, resources, { resolve: () => model }, async (_config, _messages, signal) => { calls++; return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })); }, () => {});
      const driver = new EventEmitter() as any; driver.setFeedURL = () => {}; driver.checkForUpdates = async () => driver.emit('update-available', { version: '0.20.0-alpha.8' }); driver.downloadUpdate = async () => driver.emit('update-downloaded'); driver.quitAndInstall = () => { installs++; };
      updater = new UpdateManager(profile, '0.20.0-alpha.7', { url: 'https://example.test/', channel: 'candidate', production: false }, driver, () => {}, () => resources.knowledge.isBusy() || learning!.isBusy(), async () => { backups++; return backupProfile(profile, 'knowledge-update'); }); updater.automatic(false); await updater.check(); await updater.download();
      const pendingFile = path.join(profile, '在途原件.txt'); fs.writeFileSync(pendingFile, '必须等待提取进程结束后才可安装更新');
      const pending = await resources.knowledge.start(collection, '', [pendingFile], 'files'); await assert.rejects(updater.install(), /停止/); assert.equal(backups, 0); for (let n = 0; n < 500 && resources.knowledge.isBusy(); n++) await pause(); assert(!resources.knowledge.isBusy()); assert(pending.id);
      const document = resources.documents(collection, '').find(item => item.name === '缺原件.json')!; const prepared = learning.preview({ collectionId: collection, documentId: document.id, scope: 'finance-expert', model: 'Auto', lineStart: 1, lineEnd: 2 }); const job = learning.start(prepared.token, 'finance-expert'); await assert.rejects(updater.install(), /停止/); assert.equal(backups, 0); assert.equal(installs, 0); assert.equal(calls, 1); learning.close();
      await updater.install(); assert.equal(backups, 1); assert.equal(installs, 1); const snapshot = updater.read().backup; updater.close(); updater = undefined;
      const manifest = JSON.parse(fs.readFileSync(path.join(snapshot, 'manifest.json'), 'utf8')); for (const entry of manifest.entries) assert.equal(digest(fs.readFileSync(path.join(snapshot, entry.path))), entry.sha256); assert(manifest.entries.some((entry: any) => entry.path.includes('_frozen'))); assert(manifest.entries.some((entry: any) => entry.path.includes('manifest.json')));
      const restored = path.join(profile, 'restored'); fs.cpSync(snapshot, restored, { recursive: true }); const migration = await migrateProfile(restored); assert(migration.to >= 2);
      const restoredLibrary = new ExpertLibrary(root, restored), restoredResources = new ResourceStore(root, restored, restoredLibrary, worker); const restoredLearning = new KnowledgeLearning(restored, restoredResources, { resolve: () => model }, async () => { throw new Error('Rollback must not call model'); }, () => {});
      try { const restoredJob = restoredLearning.read(job.id, 'finance-expert'); assert.equal(restoredJob.reference.version, job.reference.version); assert.equal(restoredJob.parts[0].state, 'unknown'); assert.equal(restoredJob.state, 'interrupted'); assert.equal(calls, 1); assert.deepEqual(restoredResources.documents(collection, '').map(item => [item.id, item.sourceVersion]), resources.documents(collection, '').map(item => [item.id, item.sourceVersion])); }
      finally { restoredLearning.close(); restoredResources.close(); restoredLibrary.close(); }
    });
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify({ ok: true, platform: process.platform, arch: process.arch, checks, scope: 'Native SQLite, immutable files, real process extraction; controlled updater/model without external calls' }, null, 2));
  } finally { updater?.close(); learning?.close(); resources.close(); library.close(); fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
