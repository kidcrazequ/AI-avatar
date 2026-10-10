import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExpertLibrary } from '../electron/expert-library';

const resourceRoot = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-expert-验收-'));
const checks: string[] = [];
let library = new ExpertLibrary(resourceRoot, profile);
const check = (name: string, test: () => void) => { test(); checks.push(name); };
try {
  check('Bundled catalogue reads all 10 real packs without inventing installation state', () => {
    const snapshot = library.list();
    assert.equal(snapshot.experts.length, 10);
    assert(snapshot.experts.every(item => !item.installed));
    for (const expert of snapshot.experts) {
      const detail = library.detail(expert.id);
      assert.equal(library.archive(expert.id, 'soul.md').content, fs.readFileSync(path.join(resourceRoot, 'expert-packs', expert.id, 'soul.md'), 'utf8').replace(/^\uFEFF/, ''));
      assert(detail.knowledgeFiles >= 1);
    }
  });
  let cloneId = '';
  check('Creation copies the complete pack and preserves source ownership', () => {
    const snapshot = library.createExpert({ templateId: 'finance-expert', name: '验收财研', description: '本地验收专家', avatar: null });
    const clone = snapshot.experts.find(item => item.name === '验收财研')!;
    cloneId = clone.id;
    assert(clone.installed);
    const root = path.join(profile, 'avatars', cloneId);
    for (const file of ['soul.md', 'AGENTS.md', 'CLAUDE.md', 'skills/skill-index.yaml', 'knowledge/README.md', 'memory/MEMORY.md']) assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), fs.readFileSync(path.join(resourceRoot, 'expert-packs/finance-expert', file), 'utf8'));
    fs.writeFileSync(path.join(root, 'memory/MEMORY.md'), '仅此副本的记忆');
    assert.equal(library.detail(cloneId).memory.text, '仅此副本的记忆');
    assert.notEqual(library.detail('finance-expert').memory.text, '仅此副本的记忆');
    assert.throws(() => library.createExpert({ templateId: 'finance-expert', name: '验收财研', description: '', avatar: null }), /已存在/);
    assert.throws(() => library.createExpert({ templateId: 'finance-expert', name: '', description: '', avatar: null }));
  });
  check('Groups require installed members, a selected Leader and a real working directory', () => {
    assert.throws(() => library.saveGroup({ id: '', name: '无效成员', leader: 'hr-expert', members: [{ expertId: 'hr-expert', model: 'Auto', directory: '' }] }), /已安装/);
    library.installExpert('finance-expert');
    const group = { id: '验收群组', name: '验收群组', leader: cloneId, members: [{ expertId: cloneId, model: 'Auto', directory: profile }, { expertId: 'finance-expert', model: 'claude-sonnet-4-6', directory: '' }] };
    library.saveGroup(group);
    assert.deepEqual(library.list().groups[0], group);
    assert.throws(() => library.saveGroup({ ...group, leader: 'hr-expert' }), /Leader/);
    assert.throws(() => library.saveGroup({ ...group, members: [{ expertId: cloneId, model: 'Auto', directory: path.join(profile, '不存在') }] }), /目录/);
    assert.deepEqual(library.list().groups[0], group);
  });
  check('Restart retains experts, raw memory, names and group configuration', () => {
    library.renameExpert(cloneId, '验收财研重命名');
    library.close(); library = new ExpertLibrary(resourceRoot, profile);
    assert.equal(library.detail(cloneId).name, '验收财研重命名');
    assert.equal(library.detail(cloneId).memory.text, '仅此副本的记忆');
    assert.equal(library.list().groups[0].leader, cloneId);
    assert.equal(library.list().groups[0].members[0].directory, profile);
  });
  check('Soft removal and restoration retain files and original group membership', () => {
    const group = library.list().groups[0];
    library.removeExpert(cloneId);
    assert.throws(() => library.createExpert({ templateId: 'finance-expert', name: '验收财研重命名', description: '', avatar: null }), /已存在/);
    assert(!library.list().experts.some(item => item.id === cloneId));
    assert.equal(library.list().groups[0].leader, 'finance-expert');
    assert.equal(fs.readFileSync(path.join(profile, 'avatars', cloneId, 'memory/MEMORY.md'), 'utf8'), '仅此副本的记忆');
    library.restoreExperts();
    assert.deepEqual(library.list().groups[0], group);
    library.removeGroup(group.id);
    assert.throws(() => library.saveGroup({ ...group, id: '' }), /已存在/);
    assert.equal(library.list().groups.length, 0);
    assert.equal(library.list().removed, 1);
    library.restoreExperts();
    assert.deepEqual(library.list().groups[0], group);
  });
  check('Full-directory import previews an immutable copy and imports all resources', () => {
    const source = path.join(profile, '待导入专家包');
    fs.cpSync(path.join(resourceRoot, 'expert-packs/finance-expert'), source, { recursive: true });
    const meta = JSON.parse(fs.readFileSync(path.join(source, 'expert-pack.json'), 'utf8'));
    fs.writeFileSync(path.join(source, 'expert-pack.json'), JSON.stringify({ ...meta, id: '验收导入', name: '验收导入专家' }));
    const preview = library.previewImport(source);
    assert(preview.files > 5);
    fs.writeFileSync(path.join(source, 'soul.md'), '预览后修改的源文件');
    library.importExpert(preview.token);
    assert.notEqual(library.archive('验收导入', 'soul.md').content, '预览后修改的源文件');
    assert.equal(library.detail('验收导入').knowledgeFiles, library.detail('finance-expert').knowledgeFiles);
    assert(!library.detail('验收导入').installed);
    library.installExpert('验收导入');
    assert(library.detail('验收导入').installed);
    assert.throws(() => library.previewImport(source), /ID 已存在/);
    assert.throws(() => library.importExpert(preview.token), /过期/);
    fs.writeFileSync(path.join(source, 'expert-pack.json'), JSON.stringify({ ...meta, id: 'CON', name: '无效目录' }));
    assert.throws(() => library.previewImport(source), /Windows/);
    assert.equal(fs.readdirSync(path.join(profile, 'import-staging')).length, 0);
    if (process.platform !== 'win32') {
      fs.symlinkSync(path.join(profile, 'soul.sqlite'), path.join(source, '外部链接'));
      assert.throws(() => library.previewImport(source), /符号链接/);
    }
  });
  check('Archive reads are constrained to declared files and skills', () => {
    assert.throws(() => library.archive(cloneId, '../../soul.sqlite'), /只能读取/);
    assert.throws(() => library.detail('../finance-expert'));
    const root = path.join(profile, 'avatars', cloneId);
    fs.writeFileSync(path.join(root, 'skills/skill-index.yaml'), 'local_skills:\n  - name: same-skill\n    path: soul.md\n    source: local\nshared_skills:\n  - name: same-skill\n    path: shared/skills/missing.md\n    source: shared\n');
    assert.equal(library.detail(cloneId).skills.length, 1);
    assert.equal(library.detail(cloneId).skills[0].source, 'local');
    assert.equal(library.archive(cloneId, 'same-skill').content, library.archive(cloneId, 'soul.md').content);
  });
  check('User-authored roles preserve literal text and remain blocked drafts', () => {
    const snapshot = library.createRole({ name: '验收角色', description: '测试角色草案', identity: '用户职责 $1 $&', style: '用户风格 $1 $&', workflow: '用户流程 $1 $&' });
    const role = snapshot.experts.find(item => item.name === '验收角色')!;
    assert(role.draft && !role.installable && !role.installed);
    const soul = library.archive(role.id, 'soul.md').content;
    for (const content of ['用户职责 $1 $&', '用户风格 $1 $&', '用户流程 $1 $&']) assert(soul.includes(content));
    assert.equal(library.detail(role.id).testCases, 5);
    assert(library.archive(role.id, 'AGENTS.md').content.includes('知识库约束'));
    assert.throws(() => library.installExpert(role.id), /草案/);
  });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ ok: true, platform: process.platform, arch: process.arch, electron: process.versions.electron, checks }, null, 2));
  console.log(JSON.stringify({ ok: true, checks: checks.length, output }));
} finally { library.close(); fs.rmSync(profile, { recursive: true, force: true }); }
