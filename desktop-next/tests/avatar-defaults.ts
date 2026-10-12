import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExpertLibrary } from '../electron/expert-library';
import { legacyRoleAvatars } from '../shared/legacy-role-avatars';

const resources = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-avatar-art-'));
const fixtures = path.resolve(process.argv[4]);
const illustratedFixtures = path.resolve(process.argv[5]);
const characterFixtures = path.resolve(process.argv[6]);
const photographicFixtures = path.resolve(process.argv[7]);
const lineFixtures = path.resolve(process.argv[8] ?? 'tests/fixtures/line-role-avatars');
const bustFixtures = path.resolve(process.argv[9] ?? 'tests/fixtures/line-bust-role-avatars');
let library = new ExpertLibrary(resources, profile);
const checks: string[] = [];
const source = (data: Buffer) => `data:image/png;base64,${data.toString('base64')}`;
try {
  for (const id of Object.keys(legacyRoleAvatars)) {
    for (const [generation, folder] of [['reference', fixtures], ['illustrated', illustratedFixtures], ['character', characterFixtures], ['photographic', photographicFixtures], ['line', lineFixtures], ['bust', bustFixtures]]) {
      if (generation === 'line' && !fs.existsSync(path.join(folder, `${id}.png`))) continue;
      const old = fs.readFileSync(path.join(folder, `${id}.png`));
      const current = fs.readFileSync(path.join(resources, 'expert-packs', id, 'avatar.png'));
      assert.notDeepEqual(current, old, `${id} must have original new artwork`);
      const name = `头像验证-${generation[0]}-${id.slice(0, 12)}`;
      const clone = library.createExpert({ templateId: id, name, description: '独立角色的资料不因外观更新而修改', avatar: source(old) }).experts.find(item => item.templateId === id && item.name === name && item.installed)!;
      const root = path.join(profile, 'avatars', clone.id);
      const config = fs.readFileSync(path.join(root, 'avatar.config.json'));
      const soul = fs.readFileSync(path.join(root, 'soul.md'));
      fs.writeFileSync(path.join(root, 'memory/MEMORY.md'), '此专家的独立记忆');
      assert.equal(library.detail(clone.id).avatar, source(current));
      assert.equal(library.readRole(clone.id).avatar, source(current), 'Profile editor and catalogue must agree');
      assert.deepEqual(fs.readFileSync(path.join(root, 'avatar.png')), old, 'A read must never rewrite an installed expert');
      assert.deepEqual(fs.readFileSync(path.join(root, 'avatar.config.json')), config);
      assert.deepEqual(fs.readFileSync(path.join(root, 'soul.md')), soul);
      assert.equal(library.detail(clone.id).memory.text, '此专家的独立记忆');
      // An uploaded image is owned by the user even if its role has new default artwork.
      const custom = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
      library.saveSettings(clone.id, clone.name, clone.description, 'Auto', source(custom));
      assert.equal(library.detail(clone.id).avatar, source(custom));
      assert.equal(library.readRole(clone.id).avatar, source(custom));
      checks.push(`${id}/${generation}: former default upgraded for display; custom avatar and independent data retained`);
    }
  }
  const legacy = fs.readFileSync(path.join(fixtures, 'frontend-engineer.png'));
  const imported = path.join(profile, 'import-source');
  fs.cpSync(path.join(resources, 'expert-packs/frontend-engineer'), imported, { recursive: true });
  const metadata = JSON.parse(fs.readFileSync(path.join(imported, 'expert-pack.json'), 'utf8'));
  fs.writeFileSync(path.join(imported, 'expert-pack.json'), JSON.stringify({ ...metadata, id: 'imported-avatar', name: '导入头像验证' }));
  fs.writeFileSync(path.join(imported, 'avatar.png'), legacy);
  library.importExpert(library.previewImport(imported).token);
  const importedExpert = library.createExpert({ templateId: 'imported-avatar', name: '导入专家验证', description: '', avatar: null }).experts.find(item => item.templateId === 'imported-avatar' && item.installed)!;
  assert.equal(importedExpert.avatar, source(legacy), 'Imported artwork must not inherit a bundled upgrade by matching bytes alone');
  checks.push('Imported packs keep their own artwork even when it matches a former default');
  library.close(); library = new ExpertLibrary(resources, profile);
  assert.equal(library.detail(importedExpert.id).avatar, source(legacy));
  for (const expert of library.list().experts.filter(item => item.installed && Object.hasOwn(legacyRoleAvatars, item.templateId))) {
    assert.equal(expert.avatar, source(fs.readFileSync(path.join(profile, 'avatars', expert.id, 'avatar.png'))));
    assert.equal(library.detail(expert.id).memory.text, '此专家的独立记忆');
  }
  checks.push('Restart retains explicit custom and imported avatar ownership');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ checks }, null, 2));
  console.log(`${checks.length} avatar ownership checks passed`);
} finally { library.close(); fs.rmSync(profile, { recursive: true, force: true }); }
