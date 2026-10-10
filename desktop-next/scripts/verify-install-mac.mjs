import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('macOS installation must be verified on macOS');
if (process.getuid() === 0) throw new Error('Verify installation as a normal user');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const dmg = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'release', `Soul-Next-${version}-mac-${process.arch}.dmg`);
const evidence = path.join(root, 'evidence', `mac-${process.arch}-${Date.now()}`);
const installRoot = path.join(os.homedir(), 'Applications', `Soul Next Verification ${Date.now()}`);
const profile = path.join(installRoot, '测试用户 数据');
const mount = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-next-dmg-'));
fs.mkdirSync(evidence, { recursive: true });
fs.mkdirSync(installRoot, { recursive: true });
const run = (file, args) => execFileSync(file, args, { encoding: 'utf8' });
let mounted = false;
try {
  const attach = run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg]);
  mounted = true;
  fs.writeFileSync(path.join(evidence, 'dmg-attach.txt'), attach);
  run('ditto', [path.join(mount, 'Soul Next.app'), path.join(installRoot, 'Soul Next.app')]);
} finally {
  if (mounted) run('hdiutil', ['detach', mount]);
  fs.rmSync(mount, { recursive: true, force: true });
}
const executable = path.join(installRoot, 'Soul Next.app', 'Contents/MacOS/Soul Next');
const runs = [];
for (const iteration of [1, 2]) {
  const output = path.join(evidence, `launch-${iteration}.json`);
  const log = fs.openSync(path.join(evidence, `launch-${iteration}.log`), 'w');
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(executable, [`--verify-output=${output}`, `--profile=${profile}`], { stdio: ['ignore', log, log] });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Installed application timed out')); }, 90_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', (code, signal) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Installed app exit: ${code}/${signal}; see ${output}`)); });
    });
  } finally { fs.closeSync(log); }
  const report = JSON.parse(fs.readFileSync(output, 'utf8'));
  if (!report.ok || !report.packaged || report.execPath !== executable || report.status.version !== version || report.status.persistenceRun !== iteration || report.status.arch !== process.arch || !Array.isArray(report.workflowRenderChecks) || report.workflowRenderChecks.length < 12 || (iteration === 2 && !report.workflowRenderChecks.some(check => check.installedWorkflowResume)) || !Array.isArray(report.taskRenderChecks) || report.taskRenderChecks.length < 10 || (iteration === 2 && !report.taskRenderChecks.some(check => check.installedResume))) throw new Error(`Installed app verification mismatch: ${output}`);
  if (iteration === 1) await new Promise(resolve => setTimeout(resolve, 16000));
  runs.push(report);
}
const report = {
  ok: true, builtAndInstalledOn: { platform: process.platform, arch: process.arch, release: os.release() },
  dmg, dmgSha256: crypto.createHash('sha256').update(fs.readFileSync(dmg)).digest('hex'),
  installRoot, executable, profile, sourceSha: runs[0].status.sourceSha, resourceSha256: runs[0].status.resources.sha256,
  launches: runs.map(item => item.status.persistenceRun),
  scope: 'Internal unsigned build: mounted DMG, copied app to user Applications, launched twice; public Gatekeeper trust and auto-update not verified',
};
fs.writeFileSync(path.join(evidence, 'installation.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, evidence }, null, 2));
