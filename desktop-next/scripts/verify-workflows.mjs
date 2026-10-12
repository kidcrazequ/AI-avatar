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
const suiteProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-workflow-'));
const cleanup = profile => {
  let readOnlyGitFiles = 0;
  const writableGit = directory => {
    if (!fs.existsSync(directory)) return;
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name), info = fs.lstatSync(file);
      if (info.isDirectory()) writableGit(file);
      else if (info.isFile() && !(info.mode & 0o200)) { fs.chmodSync(file, 0o600); readOnlyGitFiles++; }
    }
  };
  // Git objects can be read-only on Windows; change only this disposable fixture.
  if (process.platform === 'win32') writableGit(path.join(profile, 'Git验收', '.git'));
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  if (fs.existsSync(profile)) throw new Error('Workflow fixture remains after native process exit');
  return { readOnlyGitFiles, removed: true };
};
try {
  for (const mode of ['suite', 'crash-prepare', 'crash-resume']) {
    const output = path.join(root, 'evidence', `workflows-${process.platform}-${process.arch}-${mode === 'suite' ? 'runtime' : 'recovery'}.json`);
    const started = Date.now();
    const result = spawnSync(executable, [entry, path.join(root, 'build/resources'), output, mode, mode === 'suite' ? suiteProfile : crashProfile], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: process.platform === 'win32' ? 180_000 : 60_000 });
    console.log(JSON.stringify({ workflowMode: mode, elapsedMs: Date.now() - started, status: result.status, error: result.error?.code }));
    process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
    if (result.error || result.status !== 0) throw result.error ?? new Error(`Workflow verification ${mode} exited ${result.status}`);
    if (mode === 'suite') {
      const cleanupResult = cleanup(suiteProfile), report = JSON.parse(fs.readFileSync(output, 'utf8'));
      report.checks.push('native-process-exit-git-fixture-permissions-and-removal'); report.cleanup = cleanupResult;
      fs.writeFileSync(output, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ workflowFixtureCleanup: cleanupResult }));
    }
  }
} finally { cleanup(suiteProfile); cleanup(crashProfile); }
