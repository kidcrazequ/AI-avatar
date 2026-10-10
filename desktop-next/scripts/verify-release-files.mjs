import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parse } from 'yaml';
const folder = process.argv[2] ?? 'release';
const expectedVersion = process.argv[3] ?? JSON.parse(fs.readFileSync('package.json')).version;
const metadata = fs.readdirSync(folder).filter(file => /^(latest|candidate)(-mac)?\.yml$/.test(file));
if (!metadata.length) throw new Error('No updater metadata produced');
const artifacts = [];
for (const file of metadata) {
  const info = parse(fs.readFileSync(path.join(folder, file), 'utf8'));
  if (info.version !== expectedVersion || !Array.isArray(info.files) || !info.files.length) throw new Error('Updater metadata version differs from the selected build');
  for (const item of info.files) {
    const name = decodeURIComponent(item.url);
    if (path.basename(name) !== name || !name.includes(`-${process.arch}.`)) throw new Error('Metadata must name a local artifact for the native architecture');
    const bytes = fs.readFileSync(path.join(folder, name));
    if (crypto.createHash('sha512').update(bytes).digest('base64') !== item.sha512 || (item.size !== undefined && item.size !== bytes.length)) throw new Error(`Artifact checksum mismatch: ${name}`);
    artifacts.push({ name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  }
  if (process.platform === 'darwin' && !info.files.some(item => item.url.endsWith('.zip'))) throw new Error('Mac updater requires ZIP');
}
fs.writeFileSync(path.join(folder, 'release-checksums.json'), JSON.stringify({ platform: process.platform, arch: process.arch, metadata, artifacts }, null, 2));
console.log(JSON.stringify({ metadata, artifacts }));
