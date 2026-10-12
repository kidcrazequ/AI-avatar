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
const productName = process.argv[3] ?? 'Soul Next';
if (!['Soul Next', 'Soul Next UI Preview'].includes(productName)) throw new Error('Unknown local application name');
const evidence = path.join(root, 'evidence', `mac-${process.arch}-${Date.now()}`);
const installRoot = productName === 'Soul Next' ? '/Applications' : path.join(evidence, 'installed');
const installedApp = path.join(installRoot, `${productName}.app`);
const profile = path.join(evidence, '测试用户 数据');
const registration = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
fs.mkdirSync(evidence, { recursive: true });
fs.mkdirSync(installRoot, { recursive: true });
const run = (file, args) => execFileSync(file, args, { encoding: 'utf8' });
const install = iteration => {
  if (run('ps', ['-axo', 'command=']).split('\n').some(command => command.trim().startsWith(path.join(installedApp, `Contents/MacOS/${productName}`)))) throw new Error('Quit the installed Soul Next before replacing its application bundle');
  const mount = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-next-dmg-'));
  const staging = fs.mkdtempSync(path.join(installRoot, '.soul-next-install-'));
  const stagedApp = path.join(staging, `${productName}.app`), previous = path.join(staging, 'previous');
  let mounted = false;
  try {
    const attach = run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg]);
    mounted = true;
    fs.writeFileSync(path.join(evidence, `dmg-attach-${iteration}.txt`), attach);
    const source = path.join(mount, `${productName}.app`);
    const identity = bundle => run('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(bundle, 'Contents/Info.plist')]).trim();
    if (fs.existsSync(installedApp) && identity(installedApp) !== identity(source)) throw new Error('Refusing to replace an application with a different identity');
    run('ditto', [source, stagedApp]);
    if (fs.existsSync(installedApp)) {
      try { run(registration, ['-u', installedApp]); }
      catch (error) { if (!String(error.stderr).includes('-10814')) throw error; }
      fs.renameSync(installedApp, previous);
    }
    try { fs.renameSync(stagedApp, installedApp); }
    catch (error) { if (fs.existsSync(previous)) fs.renameSync(previous, installedApp); throw error; }
    if (productName === 'Soul Next') run(registration, ['-f', installedApp]);
  } finally {
    if (mounted) run('hdiutil', ['detach', mount]);
    fs.rmSync(mount, { recursive: true, force: true });
    fs.rmSync(staging, { recursive: true, force: true });
  }
};
const executable = path.join(installedApp, `Contents/MacOS/${productName}`);
const runs = [];
for (const iteration of [1, 2]) {
  install(iteration);
  const output = path.join(evidence, `launch-${iteration}.json`);
  const log = fs.openSync(path.join(evidence, `launch-${iteration}.log`), 'w');
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(executable, [`--verify-output=${output}`, `--profile=${profile}`], { stdio: ['ignore', log, log] });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Installed application timed out')); }, 180_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', (code, signal) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Installed app exit: ${code}/${signal}; see ${output}`)); });
    });
  } finally { fs.closeSync(log); }
  const report = JSON.parse(fs.readFileSync(output, 'utf8'));
  if (!report.ok || !report.packaged || report.execPath !== executable || report.status.version !== version || report.status.persistenceRun !== iteration || report.status.arch !== process.arch || report.verificationSchema !== 'qoderwake-cn-2026-10-10' || !Array.isArray(report.replicaRenderChecks) || report.replicaRenderChecks.length < 64 || !report.replicaPersistence?.pendingApprovalRetained || !report.replicaPersistence?.completedTaskUnchanged || !report.replicaPersistence?.settingsRetained || !report.replicaPersistence?.assistantAndFeedbackRetained) throw new Error(`Installed app verification mismatch: ${output}`);
  runs.push(report);
}
const report = {
  ok: true, builtAndInstalledOn: { platform: process.platform, arch: process.arch, release: os.release() },
  dmg, dmgSha256: crypto.createHash('sha256').update(fs.readFileSync(dmg)).digest('hex'),
  installRoot, executable, profile, sourceSha: runs[0].status.sourceSha, resourceSha256: runs[0].status.resources.sha256,
  launches: runs.map(item => item.status.persistenceRun), replacements: 2,
  scope: 'Internal unsigned build: mounted DMG twice, replaced the same app bundle, retained profile across two installed launches; public Gatekeeper trust and auto-update not verified',
};
fs.writeFileSync(path.join(evidence, 'installation.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, evidence }, null, 2));
