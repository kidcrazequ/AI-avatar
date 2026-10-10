import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = process.platform === 'win32' ? path.join(root, 'release/win-unpacked/Soul Next.exe') : path.join(root, `release/mac${process.arch === 'arm64' ? '-arm64' : ''}/Soul Next.app/Contents/MacOS/Soul Next`);
if (!fs.existsSync(executable)) throw new Error('Build the native package before workflow verification');
const entry = path.join(root, 'dist-electron/workflow-test.cjs');
await build({ entryPoints: [path.join(root, 'tests/workflows.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: entry, external: ['better-sqlite3', './retriever.cjs', './model.cjs'] });
fs.mkdirSync(path.join(root, 'evidence'), { recursive: true });
const crashProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-workflow-crash-'));
try {
  for (const mode of ['suite', 'crash-prepare', 'crash-resume']) {
    const output = path.join(root, 'evidence', `workflows-${process.platform}-${process.arch}-${mode === 'suite' ? 'runtime' : 'recovery'}.json`);
    const result = spawnSync(executable, [entry, path.join(root, 'build/resources'), output, mode, ...(mode !== 'suite' ? [crashProfile] : [])], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 60_000 });
    process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
    if (result.error || result.status !== 0) throw result.error ?? new Error(`Workflow verification ${mode} exited ${result.status}`);
  }
} finally { fs.rmSync(crashProfile, { recursive: true, force: true }); }
