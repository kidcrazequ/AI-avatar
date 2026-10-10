import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import type { Check, Expert, RuntimeStatus } from '../shared/contracts';

interface ResourceManifest {
  sourceSha: string;
  lockSha256: string;
  files: Array<{ path: string; bytes: number; sha256: string }>;
  experts: Expert[];
}

export function probeRuntime(resourceRoot: string, profile: string, version: string): RuntimeStatus {
  const checks: Check[] = [];
  const check = (name: string, fn: () => unknown) => {
    try { checks.push({ name, ok: true, detail: fn() }); }
    catch (error) { checks.push({ name, ok: false, detail: error instanceof Error ? error.stack : String(error) }); }
  };
  const manifestBytes = fs.readFileSync(path.join(resourceRoot, 'manifest.json'));
  const manifest: ResourceManifest = JSON.parse(manifestBytes.toString());
  let persistenceRun = 0;
  check('expert-resource-integrity', () => {
    if (manifest.experts.length !== 10) throw new Error(`Expected 10 expert packs, got ${manifest.experts.length}`);
    for (const entry of manifest.files) {
      const target = path.resolve(resourceRoot, entry.path);
      if (!target.startsWith(resourceRoot + path.sep)) throw new Error(`Invalid resource path: ${entry.path}`);
      const bytes = fs.readFileSync(target);
      if (bytes.length !== entry.bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
        throw new Error(`Resource mismatch: ${entry.path}`);
      }
    }
    return { files: manifest.files.length, experts: manifest.experts.length, lockSha256: manifest.lockSha256 };
  });
  check('sqlite-persistence', () => {
    const file = path.join(profile, 'validation.sqlite');
    const db = new Database(file);
    try {
      db.exec('CREATE TABLE IF NOT EXISTS installation_probe (id INTEGER PRIMARY KEY, launches INTEGER NOT NULL, label TEXT NOT NULL)');
      db.transaction(() => {
        db.prepare("INSERT INTO installation_probe VALUES (1, 1, '专家资源验证') ON CONFLICT(id) DO UPDATE SET launches = launches + 1").run();
      })();
      const row = db.prepare('SELECT launches, label FROM installation_probe WHERE id = 1').get() as { launches: number; label: string };
      if (row.label !== '专家资源验证' || row.launches < 1) throw new Error('SQLite read/write mismatch');
      persistenceRun = row.launches;
      const integrity = db.pragma('integrity_check', { simple: true });
      if (integrity !== 'ok') throw new Error(`SQLite integrity failed: ${String(integrity)}`);
      return { file, launches: row.launches, label: row.label, integrity };
    } finally { db.close(); }
  });
  check('nodejieba-native-and-dictionaries', () => {
    const moduleDir = path.dirname(require.resolve('nodejieba/package.json')).replace(/([/\\])app\.asar([/\\])/, '$1app.asar.unpacked$2');
    const files = ['jieba.dict.utf8', 'hmm_model.utf8', 'user.dict.utf8', 'idf.utf8', 'stop_words.utf8'];
    for (const name of files) if (!fs.statSync(path.join(moduleDir, 'dict', name)).isFile()) throw new Error(`Missing dictionary: ${name}`);
    const native = require(path.join(moduleDir, 'build/Release/nodejieba.node')) as { load(options: Record<string, string>): void; cut(text: string): string[] };
    // Core already guards Windows ANSI fopen. Loading a Unicode dictionary path can terminate the entire process.
    const unicodeInstall = process.platform === 'win32' && /[^\x00-\x7F]/.test(moduleDir);
    if (unicodeInstall) return { moduleDir, dictionaries: files.length, nativeLoaded: true, tokenizer: 'core-2gram-unicode-path-fallback' };
    native.load({ dict: path.join(moduleDir, 'dict', files[0]), hmmDict: path.join(moduleDir, 'dict', files[1]), userDict: path.join(moduleDir, 'dict', files[2]), idfDict: path.join(moduleDir, 'dict', files[3]), stopWordDict: path.join(moduleDir, 'dict', files[4]) });
    const words = native.cut('南京市长江大桥');
    if (!words.includes('南京市') || !words.includes('长江大桥')) throw new Error(`Chinese tokenization failed: ${words.join('/')}`);
    return { moduleDir, dictionaries: files.length, nativeLoaded: true, tokenizer: 'nodejieba', words };
  });
  check('ripgrep-executable', () => {
    const { rgPath } = require('@vscode/ripgrep') as { rgPath: string };
    const executable = rgPath.replace(/([/\\])app\.asar([/\\])/, '$1app.asar.unpacked$2');
    const versionText = execFileSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true }).split('\n')[0];
    const fixture = path.join(resourceRoot, 'expert-packs/finance-expert/knowledge/示例-报表科目占位.md');
    const match = execFileSync(executable, ['--fixed-strings', '应收账款', fixture], { encoding: 'utf8', windowsHide: true });
    if (!match.includes('1122-demo')) throw new Error('Packaged Chinese resource search failed');
    return { executable, versionText, matched: '应收账款 / 1122-demo' };
  });
  check('core-knowledge-retrieval', () => {
    const { KnowledgeRetriever } = require('./retriever.cjs') as { KnowledgeRetriever: new (root: string) => { searchChunks(query: string, count: number): Array<{ file: string; content: string; score: number }> } };
    const retriever = new KnowledgeRetriever(path.join(resourceRoot, 'expert-packs/finance-expert/knowledge'));
    const hits = retriever.searchChunks('资产负债表 应收账款', 5);
    const hit = hits.find(item => item.file === '示例-报表科目占位.md' && item.content.includes('1122-demo'));
    if (!hit || hit.score <= 0) throw new Error('Existing core failed to retrieve packaged source with citation');
    return { file: hit.file, score: hit.score, sourceType: 'repository-fictional-test-example' };
  });
  return {
    version, platform: process.platform, arch: process.arch, sourceSha: manifest.sourceSha,
    experts: manifest.experts, checks, persistenceRun,
    resources: { files: manifest.files.length, bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0), sha256: crypto.createHash('sha256').update(manifestBytes).digest('hex') },
  };
}
