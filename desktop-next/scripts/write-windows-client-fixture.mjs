import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows fixtures must come from a native Windows x64 build');
const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const from = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+-alpha\.\d+$/.test(from)) throw new Error('Internal alpha fixture required');
const to = from.replace(/\d+$/, n => String(Number(n) + 1));
const fingerprint = relative => crypto.createHash('sha256').update(fs.readFileSync(path.join(base, relative))).digest('hex');
const initial = `release/Soul-Next-${from}-win-x64.exe`;
const upgrade = `release-upgrade/Soul-Next-${to}-win-x64.exe`;
const fixture = {
  schema: 1, platform: 'win32', arch: 'x64', from, to,
  sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: base, encoding: 'utf8' }).trim(),
  initial: { file: initial, sha256: fingerprint(initial) },
  upgrade: { file: upgrade, sha256: fingerprint(upgrade) },
  installed: {
    executableSha256: fingerprint('release-upgrade/win-unpacked/Soul Next.exe'),
    archiveSha256: fingerprint('release-upgrade/win-unpacked/resources/app.asar'),
  },
};
fs.writeFileSync(path.join(base, 'windows-client-fixture.json'), JSON.stringify(fixture, null, 2));
console.log(JSON.stringify({ from, to, sourceSha: fixture.sourceSha }));
