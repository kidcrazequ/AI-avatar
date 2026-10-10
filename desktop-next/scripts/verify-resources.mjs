import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = process.platform === 'win32' ? path.join(root, 'release/win-unpacked/Soul Next.exe') : path.join(root, `release/mac${process.arch === 'arm64' ? '-arm64' : ''}/Soul Next.app/Contents/MacOS/Soul Next`);
if (!fs.existsSync(executable)) throw new Error('Build the native desktop package before expert verification');
const entry = path.join(root, 'build/resource-test.cjs');
await build({ entryPoints: [path.join(root, 'tests/resources.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: entry, external: ['better-sqlite3'] });
const result = spawnSync(executable, [entry, path.join(root, 'build/resources'), path.join(root, `evidence/resources-${process.platform}-${process.arch}.json`)], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 60_000 });
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
if (result.error || result.status !== 0) throw result.error ?? new Error(`Resource persistence verification exited ${result.status}`);
