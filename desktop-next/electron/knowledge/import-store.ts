import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { crc32, inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';
import AdmZip from 'adm-zip';
import { assertSafeSegment, resolveUnderRoot } from '../../../packages/core/src/utils/path-security';
import { extractionSignature, knowledgeExtensions, knowledgeLimits, type KnowledgeImportBatch, type SourceManifest } from '../../shared/knowledge';
import type { ResourceDocument, ResourceFile } from '../../shared/contracts';
import type { ExtractionInput } from './extract';

const digest = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const documentId = (relative: string) => digest(relative.normalize('NFC').toLowerCase()).slice(0, 32);
interface DocumentRow { id: string; collection_id: string; relative: string; version: string; archived: number; removed_scope: string }
interface StoredBatch extends KnowledgeImportBatch { force?: boolean }
type Access = (id: string, scope: string, write?: boolean) => { root: string; source: string };

function safe(root: string, relative: string): string {
  const file = resolveUnderRoot(root, relative);
  let current = root;
  if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) throw new Error('导入目录不接受符号链接');
  for (const part of path.relative(root, file).split(path.sep)) { current = path.join(current, part); if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('导入产物不接受符号链接'); }
  return file;
}
function relativeName(value: string): string {
  const clean = value.replaceAll('\\', '/').normalize('NFC');
  if (!clean || clean.startsWith('/') || /^[A-Za-z]:/.test(clean) || clean.length > 1800) throw new Error('导入相对路径无效');
  for (const segment of clean.split('/')) {
    assertSafeSegment(segment, '资料名称');
    if (/[<>:"|?*\x00-\x1f]/.test(segment) || /[. ]$/.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)) throw new Error('资料路径不能在 Windows 中使用');
  }
  return clean;
}

export class KnowledgeImports {
  private intakeRoot: string;
  private closed = false;
  private scheduled = false;
  private preparing = 0;
  private active?: { batch: string; worker: ChildProcess; reject(cause: Error): void };
  private listener: () => void = () => {};
  constructor(private db: Database.Database, profile: string, private access: Access, private languages: string, private workerFile = path.join(__dirname, 'knowledge-worker.cjs'), private signature = extractionSignature) {
    this.intakeRoot = path.join(profile, 'knowledge/_imports'); fs.mkdirSync(this.intakeRoot, { recursive: true });
    this.db.exec(`CREATE TABLE IF NOT EXISTS knowledge_imports_v1(id TEXT PRIMARY KEY,collection_id TEXT NOT NULL,scope TEXT NOT NULL,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS knowledge_documents_v1(id TEXT NOT NULL,collection_id TEXT NOT NULL,relative TEXT NOT NULL,version TEXT NOT NULL,archived INTEGER NOT NULL DEFAULT 0,removed_scope TEXT NOT NULL DEFAULT '',PRIMARY KEY(collection_id,id));
      CREATE TABLE IF NOT EXISTS knowledge_versions_v1(collection_id TEXT NOT NULL,document_id TEXT NOT NULL,version TEXT NOT NULL,manifest TEXT NOT NULL,PRIMARY KEY(collection_id,document_id,version));`);
    // The application owns the profile through Electron's single-instance lock.
    // A new owner resumes only unfinished file checkpoints, never committed versions.
    for (const batch of this.all()) {
      let changed = false;
      for (const item of batch.items) if (item.state === 'extracting') { item.state = 'queued'; item.error = ''; changed = true; }
      if (changed || batch.state === 'running') { batch.state = 'queued'; this.persist(batch); }
    }
    this.schedule();
  }
  onChanged(listener: () => void): void { this.listener = listener; }
  isBusy(): boolean { return Boolean(this.preparing || this.active || this.all().some(b => b.state === 'queued' || b.state === 'running')); }
  close(): void {
    this.closed = true;
    if (this.active) {
      const batch = this.batch(this.active.batch);
      for (const item of batch.items) if (item.state === 'extracting') item.state = 'queued';
      batch.state = 'queued'; this.persist(batch);
      this.active.reject(new Error('应用退出，导入将在重启后恢复')); this.active.worker.kill(); this.active = undefined;
    }
  }
  private all(): StoredBatch[] { return (this.db.prepare('SELECT value FROM knowledge_imports_v1 ORDER BY rowid').all() as Array<{ value: string }>).map(row => JSON.parse(row.value)); }
  count(collectionId: string): number { return (this.db.prepare('SELECT count(*) AS n FROM knowledge_documents_v1 WHERE collection_id=? AND archived=0').get(collectionId) as { n: number }).n; }
  private batch(id: string): StoredBatch {
    const row = this.db.prepare('SELECT value FROM knowledge_imports_v1 WHERE id=?').get(id) as { value: string } | undefined;
    if (!row) throw new Error('导入批次不存在'); return JSON.parse(row.value);
  }
  private persist(batch: StoredBatch): void { batch.updated = now(); this.db.prepare('INSERT INTO knowledge_imports_v1 VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(batch.id, batch.collectionId, batch.scope, JSON.stringify(batch)); this.listener(); }
  list(collectionId: string, scope: string): KnowledgeImportBatch[] { this.access(collectionId, scope); return this.all().filter(b => b.collectionId === collectionId && b.scope === scope).slice(-100).reverse(); }
  async start(collectionId: string, scope: string, sources: string[], kind: 'files' | 'directory' | 'zip'): Promise<KnowledgeImportBatch> {
    if (this.closed) throw new Error('应用正在关闭');
    this.access(collectionId, scope, true);
    if (!Array.isArray(sources) || !sources.length || sources.length > knowledgeLimits.members || !['files', 'directory', 'zip'].includes(kind)) throw new Error('导入来源无效');
    const id = crypto.randomUUID(), folder = safe(this.intakeRoot, id); fs.mkdirSync(folder);
    const inputs: Array<{ relative: string; file?: string; entry?: AdmZip.IZipEntry; bytes: number }> = [];
    const skipped: KnowledgeImportBatch['skipped'] = [];
    const seen = new Set<string>(); let total = 0;
    const add = (relative: string, bytes: number, source: { file?: string; entry?: AdmZip.IZipEntry }) => {
      relative = relativeName(relative);
      const key = relative.toLowerCase(); if (seen.has(key)) throw new Error('同一批次含重复路径（含大小写差异）'); seen.add(key);
      if (!knowledgeExtensions.includes(path.posix.extname(relative).slice(1).toLowerCase())) throw new Error(`不支持的资料格式：${relative}`);
      if (bytes > knowledgeLimits.fileBytes || (total += bytes) > knowledgeLimits.batchBytes || inputs.length >= knowledgeLimits.members) throw new Error('导入大小或成员数超过上限');
      inputs.push({ relative, bytes, ...source });
    };
    const checkFile = (file: string) => { if (!path.isAbsolute(file) || fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile()) throw new Error('请选择普通资料文件'); return fs.statSync(file).size; };
    this.preparing++;
    try {
      if (kind === 'directory') {
        if (sources.length !== 1 || !path.isAbsolute(sources[0])) throw new Error('请选择一个资料文件夹');
        const root = sources[0];
        const walk = (directory: string, prefix = '', depth = 0) => {
          if (depth > 20 || fs.lstatSync(directory).isSymbolicLink()) throw new Error('资料文件夹过深或含符号链接');
          for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (entry.isSymbolicLink()) throw new Error('资料文件夹含符号链接');
            if (entry.name.startsWith('.')) continue;
            const file = path.join(directory, entry.name), relative = prefix + entry.name;
            if (entry.isDirectory()) walk(file, relative + '/', depth + 1);
            else if (entry.isFile() && knowledgeExtensions.includes(path.extname(entry.name).slice(1).toLowerCase())) add(relative, fs.statSync(file).size, { file });
            else if (entry.isFile()) skipped.push({ path: relative, reason: '当前批次不支持此格式' });
          }
        };
        walk(root);
      } else if (kind === 'zip') {
        if (sources.length !== 1 || path.extname(sources[0]).toLowerCase() !== '.zip' || checkFile(sources[0]) > knowledgeLimits.fileBytes) throw new Error('请选择大小上限内的 ZIP');
        const zip = new AdmZip(sources[0]), entries = zip.getEntries();
        if (entries.length > knowledgeLimits.members) throw new Error('ZIP 成员数超过上限');
        let unpacked = 0;
        for (const entry of entries) {
          if ((entry.header.attr >>> 16 & 0xf000) === 0xa000) throw new Error('ZIP 不接受符号链接');
          const relative = relativeName(entry.entryName.replace(/\/$/, ''));
          unpacked += entry.header.size;
          if (unpacked > knowledgeLimits.batchBytes || entry.header.size > knowledgeLimits.fileBytes) throw new Error('ZIP 解压大小超过上限');
          if (!entry.isDirectory && knowledgeExtensions.includes(path.extname(relative).slice(1).toLowerCase())) add(relative, entry.header.size, { entry });
          else if (!entry.isDirectory) skipped.push({ path: relative, reason: '当前批次不支持此格式' });
        }
      } else for (const file of sources) add(path.basename(file), checkFile(file), { file });
      if (!inputs.length) throw new Error('没有支持的知识资料');
      const batch: StoredBatch = { id, collectionId, scope, at: now(), updated: now(), state: 'queued', items: [], skipped };
      for (const [i, source] of inputs.entries()) {
        let bytes: Buffer;
        if (source.entry) {
          const entry = source.entry;
          if (entry.header.flags & 1 || ![0, 8].includes(entry.header.method)) throw new Error('ZIP 加密或压缩方式不受支持');
          const compressed = entry.getCompressedData();
          bytes = entry.header.method === 0 ? compressed : await promisify(inflateRaw)(compressed, { maxOutputLength: knowledgeLimits.fileBytes });
          if (crc32(bytes) !== entry.header.crc) throw new Error('ZIP 成员校验失败');
        } else bytes = await fs.promises.readFile(source.file!);
        if (bytes.length !== source.bytes || bytes.length > knowledgeLimits.fileBytes) throw new Error('资料在快照时发生变化，请重新选择');
        const itemId = String(i), extension = path.posix.extname(source.relative).toLowerCase();
        await fs.promises.writeFile(safe(folder, itemId + extension), bytes, { flag: 'wx', mode: 0o600 });
        batch.items.push({ id: itemId, relativePath: source.relative, sha256: digest(bytes), bytes: bytes.length, state: 'queued', documentId: documentId(source.relative), version: '', error: '', warnings: [] });
      }
      if (this.closed) throw new Error('应用正在关闭');
      this.access(collectionId, scope, true); this.persist(batch); this.schedule(); return batch;
    } catch (cause) { fs.rmSync(folder, { recursive: true, force: true }); throw cause; }
    finally { this.preparing--; }
  }
  cancel(id: string, scope: string): void {
    const batch = this.batch(id); if (batch.scope !== scope) throw new Error('导入批次范围不匹配');
    batch.state = 'cancelled';
    for (const item of batch.items) if (item.state === 'queued' || item.state === 'extracting') { item.state = 'cancelled'; item.error = ''; }
    this.persist(batch);
    if (this.active?.batch === id) { this.active.reject(new Error('导入已取消')); this.active.worker.kill(); }
  }
  retry(id: string, scope: string): void {
    const batch = this.batch(id); if (batch.scope !== scope) throw new Error('导入批次范围不匹配');
    this.access(batch.collectionId, scope, true);
    if (batch.state === 'running' || batch.state === 'queued') throw new Error('导入尚在处理');
    let count = 0;
    for (const item of batch.items) if (['failed', 'cancelled', 'partial'].includes(item.state)) { item.state = 'queued'; item.error = ''; item.warnings = []; count++; }
    if (!count) throw new Error('没有需要重试的资料');
    batch.force = true; batch.state = 'queued'; this.persist(batch); this.schedule();
  }
  private schedule(): void {
    if (this.closed || this.scheduled) return; this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; if (!this.closed && !this.active) void this.pump(); });
  }
  private async pump(): Promise<void> {
    const batch = this.all().find(b => b.state === 'queued' || b.state === 'running'); if (!batch || this.closed) return;
    batch.state = 'running'; this.persist(batch);
    const item = batch.items.find(i => i.state === 'queued');
    if (!item) { batch.state = batch.skipped.length || batch.items.some(i => ['failed', 'partial', 'cancelled'].includes(i.state)) ? 'partial' : 'completed'; this.persist(batch); this.schedule(); return; }
    let staging = '';
    try {
      const location = this.access(batch.collectionId, batch.scope, true);
      const previous = this.db.prepare('SELECT * FROM knowledge_documents_v1 WHERE collection_id=? AND id=?').get(batch.collectionId, item.documentId) as DocumentRow | undefined;
      const reuse = !batch.force && previous && !previous.archived ? this.manifest(batch.collectionId, item.documentId, previous.version, batch.scope) : null;
      if (reuse && reuse.originalSha256 === item.sha256 && reuse.signature === this.signature) {
        item.state = 'reused'; item.version = reuse.version; item.warnings = reuse.warnings; this.persist(batch); this.schedule(); return;
      }
      item.state = 'extracting'; item.version = digest(item.sha256 + this.signature).slice(0, 24) + '-' + crypto.randomUUID().slice(0, 8); this.persist(batch);
      const intake = safe(this.intakeRoot, `${batch.id}/${item.id}${path.posix.extname(item.relativePath).toLowerCase()}`);
      if (digest(fs.readFileSync(intake)) !== item.sha256) throw new Error('原件快照哈希不匹配');
      staging = safe(this.intakeRoot, `${batch.id}/staging-${item.id}`); fs.rmSync(staging, { recursive: true, force: true });
      const workerFile = this.workerFile.replace(/app\.asar([/\\])/, 'app.asar.unpacked$1');
      const result = await new Promise<SourceManifest>((resolve, reject) => {
        // Native PDF/image libraries can terminate the whole process from a thread.
        // A separate packaged Electron process confines failure to this file.
        const worker = fork(workerFile, [], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, execArgv: ['--max-old-space-size=1024'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        this.active = { batch: batch.id, worker, reject };
        let result: { error?: string; manifest?: SourceManifest } | undefined;
        const timer = setTimeout(() => { reject(new Error('资料提取超时，旧版本保留')); worker.kill(); }, knowledgeLimits.parseMs);
        worker.once('message', message => { result = message as typeof result; });
        worker.stderr?.on('data', () => {});
        worker.once('error', reject);
        worker.once('exit', (code, signal) => {
          clearTimeout(timer);
          if (code !== 0 || !result) reject(new Error(`提取进程异常退出 (${signal ?? code})，旧版本保留`));
          else if (result.error) reject(new Error(result.error));
          else if (result.manifest) resolve(result.manifest);
          else reject(new Error('提取进程未返回有效来源清单'));
        });
        worker.send({ file: intake, relativePath: item.relativePath, output: staging, documentId: item.documentId, version: item.version, languages: this.languages, signature: this.signature } satisfies ExtractionInput, error => { if (error) reject(error); });
      });
      if (this.closed || this.batch(batch.id).state === 'cancelled') return;
      this.access(batch.collectionId, batch.scope, true);
      if (result.originalSha256 !== item.sha256 || result.documentId !== item.documentId || result.version !== item.version || result.signature !== this.signature || digest(fs.readFileSync(path.join(staging, 'body.md'))) !== result.bodySha256) throw new Error('提取来源校验失败，未发布');
      const current = this.db.prepare('SELECT version,archived FROM knowledge_documents_v1 WHERE collection_id=? AND id=?').get(batch.collectionId, item.documentId) as DocumentRow | undefined;
      if (current?.version !== previous?.version || current?.archived !== previous?.archived) throw new Error('资料在提取期间已变更，未覆盖当前版本');
      const versionRoot = safe(location.root, `_sources/${item.documentId}/versions/${item.version}`); fs.mkdirSync(path.dirname(versionRoot), { recursive: true }); fs.renameSync(staging, versionRoot); staging = '';
      this.db.transaction(() => {
        this.db.prepare('INSERT INTO knowledge_versions_v1 VALUES (?,?,?,?)').run(batch.collectionId, item.documentId, item.version, JSON.stringify(result));
        this.db.prepare('INSERT INTO knowledge_documents_v1(id,collection_id,relative,version) VALUES (?,?,?,?) ON CONFLICT(collection_id,id) DO UPDATE SET relative=excluded.relative,version=excluded.version,archived=0').run(item.documentId, batch.collectionId, item.relativePath, item.version);
        item.state = result.status; item.warnings = result.warnings; this.persist(batch);
      })();
    } catch (cause) {
      if (!this.closed && this.batch(batch.id).state !== 'cancelled') { item.state = 'failed'; item.error = cause instanceof Error ? cause.message : String(cause); this.persist(batch); }
    } finally {
      const worker = this.active?.worker; this.active = undefined;
      if (worker && worker.exitCode === null && worker.signalCode === null) { const exited = new Promise<void>(resolve => worker.once('exit', () => resolve())); worker.kill(); await exited; }
      if (staging && !this.closed) fs.rmSync(staging, { recursive: true, force: true });
      if (!this.closed) this.schedule();
    }
  }
  private row(collectionId: string, id: string): DocumentRow {
    const row = this.db.prepare('SELECT * FROM knowledge_documents_v1 WHERE collection_id=? AND id=?').get(collectionId, id) as DocumentRow | undefined;
    if (!row || row.archived) throw new Error('导入资料不存在或已移除'); return row;
  }
  private artifactRoot(collectionId: string, id: string, version: string, scope: string): string {
    const location = this.access(collectionId, scope);
    if (!/^[a-f0-9]{32}$/.test(id) || !/^[a-f0-9]{24}-[a-f0-9]{8}$/.test(version)) throw new Error('资料版本标识无效');
    return safe(location.root, `_sources/${id}/versions/${version}`);
  }
  manifest(collectionId: string, id: string, version: string, scope: string): SourceManifest {
    const root = this.artifactRoot(collectionId, id, version, scope);
    const row = this.db.prepare('SELECT manifest FROM knowledge_versions_v1 WHERE collection_id=? AND document_id=? AND version=?').get(collectionId, id, version) as { manifest: string } | undefined;
    if (!row || !fs.existsSync(path.join(root, 'manifest.json')) || fs.readFileSync(path.join(root, 'manifest.json'), 'utf8') !== JSON.stringify(JSON.parse(row.manifest), null, 2)) throw new Error('资料版本缺失或被修改');
    return JSON.parse(row.manifest);
  }
  documents(collectionId: string, scope: string): ResourceDocument[] {
    this.access(collectionId, scope);
    return (this.db.prepare('SELECT * FROM knowledge_documents_v1 WHERE collection_id=? AND archived=0 ORDER BY rowid').all(collectionId) as DocumentRow[]).map(row => {
      const manifest = this.manifest(collectionId, row.id, row.version, scope);
      return { id: `imports/${row.id}.md`, name: manifest.originalName, path: row.relative, bytes: manifest.bodyBytes, placeholder: false, imported: true, sourceVersion: row.version, sourceStatus: manifest.status };
    });
  }
  read(collectionId: string, file: string, scope: string): ResourceFile {
    const id = this.fileId(file), row = this.row(collectionId, id), manifest = this.manifest(collectionId, id, row.version, scope);
    const content = fs.readFileSync(safe(this.artifactRoot(collectionId, id, row.version, scope), 'body.md'), 'utf8');
    if (digest(content) !== manifest.bodySha256) throw new Error('提取正文哈希不匹配');
    const source = `${this.access(collectionId, scope).source}/${row.relative} @ ${row.version}`;
    return { path: source, source, content, revision: manifest.bodySha256 };
  }
  fileId(file: string): string { const match = /^imports\/([a-f0-9]{32})\.md$/.exec(file); if (!match) throw new Error('导入资料标识无效'); return match[1]; }
  versions(collectionId: string, id: string, scope: string): SourceManifest[] { this.access(collectionId, scope); this.row(collectionId, id); return (this.db.prepare('SELECT version FROM knowledge_versions_v1 WHERE collection_id=? AND document_id=? ORDER BY rowid DESC').all(collectionId, id) as Array<{ version: string }>).map(v => this.manifest(collectionId, id, v.version, scope)); }
  restore(collectionId: string, id: string, version: string, expected: string, scope: string): void {
    this.access(collectionId, scope, true); const row = this.row(collectionId, id);
    if (row.version !== expected) throw new Error('资料已变更，请重新打开');
    const manifest = this.manifest(collectionId, id, version, scope), root = this.artifactRoot(collectionId, id, version, scope);
    if (digest(fs.readFileSync(safe(root, 'body.md'))) !== manifest.bodySha256 || digest(fs.readFileSync(safe(root, manifest.original))) !== manifest.originalSha256) throw new Error('历史产物校验失败');
    for (const artifact of [...manifest.tables, ...manifest.assets]) if (digest(fs.readFileSync(safe(root, artifact.path))) !== artifact.sha256) throw new Error('历史表格或图片校验失败');
    this.db.prepare('UPDATE knowledge_documents_v1 SET version=? WHERE collection_id=? AND id=? AND version=?').run(version, collectionId, id, expected); this.listener();
  }
  original(collectionId: string, id: string, version: string, scope: string): string {
    this.row(collectionId, id); const manifest = this.manifest(collectionId, id, version, scope), file = safe(this.artifactRoot(collectionId, id, version, scope), manifest.original);
    if (digest(fs.readFileSync(file)) !== manifest.originalSha256) throw new Error('原件哈希不匹配'); return file;
  }
  capture(collectionId: string, file: string, version: string, scope: string): { root: string; manifest: SourceManifest } {
    const id = this.fileId(file); this.row(collectionId, id);
    const manifest = this.manifest(collectionId, id, version, scope);
    return { root: this.artifactRoot(collectionId, id, version, scope), manifest };
  }
  remove(collectionId: string, file: string, revision: string, scope: string): void {
    this.access(collectionId, scope, true); if (this.read(collectionId, file, scope).revision !== revision) throw new Error('资料已变更，请重新打开');
    this.db.prepare('UPDATE knowledge_documents_v1 SET archived=1,removed_scope=? WHERE collection_id=? AND id=?').run(scope, collectionId, this.fileId(file)); this.listener();
  }
  restoreRemoved(scope: string): void {
    for (const row of this.db.prepare('SELECT * FROM knowledge_documents_v1 WHERE archived=1 AND removed_scope=?').all(scope) as DocumentRow[]) { this.access(row.collection_id, scope, true); this.db.prepare('UPDATE knowledge_documents_v1 SET archived=0 WHERE collection_id=? AND id=?').run(row.collection_id, row.id); } this.listener();
  }
}
