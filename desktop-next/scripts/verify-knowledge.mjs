import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = process.platform === 'win32' ? path.join(root, 'release/win-unpacked/Soul Next.exe') : path.join(root, `release/mac${process.arch === 'arm64' ? '-arm64' : ''}/Soul Next.app/Contents/MacOS/Soul Next`);
const resources = process.platform === 'win32' ? path.join(root, 'release/win-unpacked/resources') : path.resolve(path.dirname(executable), '../Resources');
const worker = path.join(resources, 'app.asar.unpacked/dist-electron/knowledge-worker.cjs');
if (!fs.existsSync(worker)) throw new Error('Build the native package including knowledge extraction first');
const entry = path.join(root, 'build/knowledge-test.cjs');
await build({ entryPoints: [path.join(root, 'tests/knowledge-imports.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: entry, external: ['better-sqlite3', '@napi-rs/canvas'] });
const output = path.join(root, `evidence/knowledge-${process.platform}-${process.arch}.json`);
const result = spawnSync(executable, [entry, path.join(resources, 'soul-resources'), output, worker, ...process.argv.slice(2)], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 30 * 60_000 });
process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
if (result.error || result.status !== 0) throw result.error ?? new Error(`Knowledge source verification exited ${result.status}`);
