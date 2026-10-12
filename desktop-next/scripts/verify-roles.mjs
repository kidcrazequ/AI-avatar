import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const native = process.platform === 'win32' ? 'release/win-unpacked/Soul Next.exe' : `release/mac${process.arch === 'arm64' ? '-arm64' : ''}/Soul Next.app/Contents/MacOS/Soul Next`;
const preview = 'release/mac-arm64/Soul Next UI Preview.app/Contents/MacOS/Soul Next UI Preview';
const executable = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, fs.existsSync(path.join(root, native)) ? native : preview);
if (!fs.existsSync(executable)) throw new Error('Build a native desktop package before role verification');
const entry = path.join(root, 'build/role-contract-test.cjs');
await build({ entryPoints: [path.join(root, 'tests/roles.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: entry, external: ['better-sqlite3', './model.cjs'] });
const output = process.argv[3] ? path.resolve(process.argv[3]) : path.resolve(root, '../evidence/qoderwake-cn-step3/roles-contract.json');
const result = spawnSync(executable, [entry, path.join(root, 'build/resources'), output], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 60_000 });
process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
if (result.error || result.status !== 0) throw result.error ?? new Error(`Role verification exited ${result.status}`);
