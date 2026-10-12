import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExpertLibrary } from '../electron/expert-library';
import { ResourceStore } from '../electron/resources';
import { expertOverview } from '../src/expert-overview';
import type { TaskView } from '../shared/contracts';

const root = path.resolve(process.argv[2]), output = path.resolve(process.argv[3]);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-profile-验收-'));
let library = new ExpertLibrary(root, profile), resources = new ResourceStore(root, profile, library);
const checks: string[] = [];
const check = (title: string, action: () => void) => { action(); checks.push(title); console.log(title); };
const sourceRoot = path.join(root, 'expert-packs/frontend-engineer');
const files = ['soul.md', 'AGENTS.md', 'skills/skill-index.yaml', 'avatar.png'];
const source = files.map(file => fs.readFileSync(path.join(sourceRoot, file)));
let expertId = '';
try {
  check('Profile edits belong to an installed instance; template source files remain exact', () => {
    const raw = resources.readProfileFile('frontend-engineer', 'soul.md');
    assert.throws(() => resources.saveProfileFile('frontend-engineer', 'soul.md', raw.content, raw.revision), /先安装/);
    const snapshot = library.createExpert({ templateId: 'frontend-engineer', name: '档案验收', description: '独立实例', avatar: null });
    expertId = snapshot.experts.find(item => item.name === '档案验收')!.id;
    for (const file of files.slice(0, 3)) {
      const original = resources.readProfileFile(expertId, file);
      const suffix = file.endsWith('.yaml') ? '\n# 原生档案保存验收\n' : '\n## 档案验收\n仅保留已确认资料。\n';
      resources.saveProfileFile(expertId, file, original.content + suffix, original.revision);
      assert.equal(resources.readProfileFile(expertId, file).content, original.content + suffix);
      assert.throws(() => resources.saveProfileFile(expertId, file, original.content, original.revision), /文件已变更/);
    }
    files.forEach((file, index) => assert.deepEqual(fs.readFileSync(path.join(sourceRoot, file)), source[index]));
  });
  check('Raw role editors reject paths and broken structure while preserving the saved revision', () => {
    assert.throws(() => resources.readProfileFile(expertId, '../../soul.sqlite'), /不支持/);
    const soul = resources.readProfileFile(expertId, 'soul.md');
    assert.throws(() => resources.saveProfileFile(expertId, 'soul.md', 'invalid', soul.revision), /标题/);
    const agents = resources.readProfileFile(expertId, 'AGENTS.md');
    assert.throws(() => resources.saveProfileFile(expertId, 'AGENTS.md', 'invalid', agents.revision), /标题/);
    const index = resources.readProfileFile(expertId, 'skills/skill-index.yaml');
    assert.throws(() => resources.saveProfileFile(expertId, 'skills/skill-index.yaml', '- bad', index.revision), /YAML 对象/);
    assert.throws(() => resources.saveProfileFile(expertId, 'skills/skill-index.yaml', 'custom:\n - name: escape\n   source: local\n   path: ../../soul.sqlite', index.revision));
    assert.equal(resources.readProfileFile(expertId, 'skills/skill-index.yaml').revision, index.revision);
  });
  check('Summary and avatar are saved together; a rejected avatar cannot alter identity', () => {
    const before = library.detail(expertId);
    assert.throws(() => library.saveSettings(expertId, '不应保存', '不应保存', 'Auto', 'not-an-avatar'), /头像/);
    assert.equal(library.detail(expertId).name, before.name);
    assert.equal(library.detail(expertId).avatar, before.avatar);
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9l8AAAAASUVORK5CYII=';
    library.saveSettings(expertId, '已保存档案', '已确认简介', before.defaultModel, png);
    assert.equal(library.detail(expertId).avatar, png);
    assert.equal(library.detail(expertId).description, '已确认简介');
  });
  check('Overview counts only owned or participated tasks and distinguishes IM from chat and workflow', () => {
    const now = new Date('2026-10-11T12:00:00+08:00');
    const task = (id: string, status: string, owner: string, members: string[], workflow = false) => ({ id, status, expertId: owner, members: members.map(expertId => ({ expertId })), created: '2026-10-11T11:00:00+08:00', workflow: workflow ? { id: 'flow' } : undefined }) as TaskView;
    const tasks = [task('chat', 'completed', 'self', ['self', 'self']), task('group', 'running', 'other', ['self']), task('auto', 'waiting', 'self', [], true), task('im', 'interrupted', 'self', []), task('other', 'completed', 'other', ['other'])];
    const result = expertOverview({ id: 'self', installedAt: '2026-10-10T23:59:00+08:00' }, tasks, new Set(['im']), now);
    assert.equal(result.joinedDays, 1);
    assert.equal(result.records.length, 4);
    assert.deepEqual([result.running, result.completed, result.waiting], [1, 1, 2]);
    assert.deepEqual([result.kinds.chat.length, result.kinds.auto.length, result.kinds.im.length], [2, 1, 1]);
    assert.equal(result.days.find(day => day.date === '2026-10-11')!.count, 4);
    assert(result.days.filter(day => day.future).every(day => day.count === 0));
    assert.equal(expertOverview({ id: 'empty', installedAt: null }, tasks, new Set(), now).joinedDays, null);
  });
  check('Restart retains summary, avatar and every role file without changing source packs', () => {
    const before = library.detail(expertId);
    const contents = files.slice(0, 3).map(file => resources.readProfileFile(expertId, file).content);
    resources.close(); library.close(); library = new ExpertLibrary(root, profile); resources = new ResourceStore(root, profile, library);
    assert.equal(library.detail(expertId).name, before.name);
    assert.equal(library.detail(expertId).avatar, before.avatar);
    assert.equal(library.detail(expertId).description, before.description);
    files.slice(0, 3).forEach((file, index) => assert.equal(resources.readProfileFile(expertId, file).content, contents[index]));
    files.forEach((file, index) => assert.deepEqual(fs.readFileSync(path.join(sourceRoot, file)), source[index]));
  });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ ok: true, checks, realModel: false, scope: 'expert profile persistence and deterministic overview statistics' }, null, 2));
} finally { resources.close(); library.close(); fs.rmSync(profile, { recursive: true, force: true }); }
