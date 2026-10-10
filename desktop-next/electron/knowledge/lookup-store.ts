import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { resolveUnderRoot } from '../../../packages/core/src/utils/path-security';
import type { SourceManifest } from '../../shared/knowledge';
import type { KnowledgeSource, LookupRequest, LookupResult } from '../../shared/knowledge-lookup';
import type { TaskFile } from '../../shared/contracts';

export const hash = (value: string | Buffer): string => crypto.createHash('sha256').update(value).digest('hex');
export function sourcePath(root: string, relative: string): string {
  const file = resolveUnderRoot(root, relative);
  let current = root;
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('来源目录不接受符号链接');
  for (const part of path.relative(root, file).split(path.sep).filter(Boolean)) { current = path.join(current, part); if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('来源不接受符号链接'); }
  return file;
}
export interface FrozenManifest { source: Omit<KnowledgeSource, 'reference'>; manifest: SourceManifest }
export class KnowledgeLookup {
  readonly root: string;
  private worker?: Worker;
  private serial: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(profile: string, private workerFile = path.join(__dirname, 'lookup-worker.cjs')) { this.root = path.join(profile, 'knowledge', '_frozen'); fs.mkdirSync(this.root, { recursive: true }); }
  freeze(id: string, name: string, source: string, body: string, imported?: { root: string; manifest: SourceManifest }): KnowledgeSource {
    const bodyHash = hash(body);
    const manifest: SourceManifest = imported?.manifest ?? { schema: 1, documentId: hash(id).slice(0, 32), version: bodyHash, relativePath: id, originalName: name, original: 'original.txt', originalSha256: bodyHash, originalBytes: Buffer.byteLength(body), signature: 'soul-text-snapshot-v1', created: '', bodySha256: bodyHash, bodyBytes: Buffer.byteLength(body), status: 'ready', warnings: [], locations: [{ lineStart: 1, lineEnd: body.split('\n').length, kind: 'text', method: 'native' }], assets: [], tables: [] };
    if (manifest.bodySha256 !== bodyHash) throw new Error('来源正文与版本不一致');
    const value: FrozenManifest = { source: { id, name, source, hash: bodyHash, status: manifest.status, warnings: manifest.warnings }, manifest };
    const encoded = JSON.stringify(value), manifestHash = hash(encoded), key = hash(id + '\n' + manifestHash);
    const reference = { key, version: manifest.version, manifestHash }, target = sourcePath(this.root, key);
    if (!fs.existsSync(target)) {
      const staging = sourcePath(this.root, 'pending-' + crypto.randomUUID()); fs.mkdirSync(staging);
      try {
        fs.writeFileSync(path.join(staging, 'body.md'), body);
        for (const artifact of [...manifest.tables, ...manifest.assets, { path: manifest.original, sha256: manifest.originalSha256 }]) {
          const destination = sourcePath(staging, artifact.path); fs.mkdirSync(path.dirname(destination), { recursive: true });
          if (imported) { const bytes = fs.readFileSync(sourcePath(imported.root, artifact.path)); if (hash(bytes) !== artifact.sha256) throw new Error('来源表格、图片或原件已被修改'); fs.writeFileSync(destination, bytes); }
          else fs.writeFileSync(destination, body);
        }
        fs.writeFileSync(path.join(staging, 'source.json'), encoded); fs.renameSync(staging, target);
      } finally { if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true }); }
    }
    return { ...value.source, reference };
  }
  taskSources(files: TaskFile[]): KnowledgeSource[] {
    return files.map(file => {
      if (file.reference) return { id: file.id, name: file.name, source: file.source, hash: file.hash, reference: file.reference, status: 'ready' as const, warnings: [] };
      if (hash(file.content) !== file.hash) throw new Error('旧任务的知识快照哈希不匹配');
      return this.freeze(file.id, file.name, file.source, file.content);
    });
  }
  execute(sources: KnowledgeSource[], request: LookupRequest): Promise<LookupResult> {
    const run = () => new Promise<LookupResult>((resolve, reject) => {
      if (this.closed) { reject(new Error('知识服务已关闭')); return; }
      const worker = this.worker ??= new Worker(this.workerFile.replace(/app\.asar([/\\])/, 'app.asar.unpacked$1'), { workerData: { root: this.root }, resourceLimits: { maxOldGenerationSizeMb: 1024 } });
      const cleanup = () => { clearTimeout(timer); worker.off('message', message); worker.off('error', error); worker.off('exit', exited); };
      const message = (value: { result?: LookupResult; error?: string }) => { cleanup(); if (value.error) reject(new Error(value.error)); else resolve(value.result!); };
      const error = (cause: Error) => { cleanup(); this.worker = undefined; reject(cause); };
      const exited = (code: number) => error(new Error(`知识查找进程退出 (${code})`));
      const timer = setTimeout(() => { cleanup(); this.worker = undefined; void worker.terminate(); reject(new Error('知识查找超时')); }, 60_000);
      worker.once('message', message); worker.once('error', error); worker.once('exit', exited); worker.postMessage({ sources, request });
    });
    const result = this.serial.then(run); this.serial = result.catch(() => undefined); return result;
  }
  close(): void { this.closed = true; void this.worker?.terminate(); }
}
