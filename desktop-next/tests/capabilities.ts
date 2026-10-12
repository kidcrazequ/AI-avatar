import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExpertLibrary } from '../electron/expert-library';
import { ResourceStore } from '../electron/resources';

const root = path.resolve(process.argv[2]), output = path.resolve(process.argv[3]);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-capability-'));
let library = new ExpertLibrary(root, profile), resources = new ResourceStore(root, profile, library);
const checks: string[] = [];
const check = (title: string, run: () => void) => { run(); checks.push(title); console.log(title); };
const configure = (key: string, state: { installed: boolean; enabled: boolean; expertIds: string[] }) => resources.capabilities.configure(key, resources.capabilities.detail(key).item.revision, state);
const on = (ids: string[]) => ({ installed: true, enabled: true, expertIds: ids });
const off = { installed: false, enabled: false, expertIds: [] };
const body = (name: string, description = '验收声明式技能') => `---\nname: ${name}\ndescription: ${description}\n---\n# 原始技能\n不得编造数据。`;
const index = (id: string) => fs.readFileSync(path.join(library.resourceLocation(id).root, 'skills/skill-index.yaml'), 'utf8');
try {
  check('catalog-is-source-backed-and-viewing-never-installs-experts', () => {
    const catalog = resources.capabilities.read();
    assert.equal(catalog.errors.length, 0);
    assert.equal(catalog.items.filter(item => item.kind === 'plugin').length, 10);
    assert.equal(new Set(catalog.items.filter(item => item.kind === 'plugin').flatMap(item => item.skills.map(skill => skill.name))).size, 22);
    assert.equal(new Set(catalog.items.filter(item => item.kind === 'plugin').map(item => item.skills.map(skill => skill.key).sort().join('|'))).size, 10);
    assert.equal(catalog.items.filter(item => item.kind === 'skill').length, resources.catalogSkills().length);
    for (const item of catalog.items.filter(item => item.kind === 'plugin')) {
      const detail = resources.capabilities.detail(item.key);
      for (const [i, document] of detail.documents.entries()) assert.equal(document.content, resources.readSkill('', item.skills[i].key).content);
    }
    assert(!library.detail('finance-expert').installed);
    library.installExpert('finance-expert'); library.installExpert('hr-expert');
  });
  const bundle = 'plugin:soul-visualization', single = 'skill:shared:shared/skills/draw-chart.md';
  check('install-without-association-does-not-grant-skills', () => {
    const before = index('finance-expert'); configure(bundle, on([]));
    assert(resources.capabilities.detail(bundle).item.installed); assert.equal(index('finance-expert'), before);
  });
  check('association-is-idempotent-and-unrelated-experts-stay-isolated', () => {
    const before = index('hr-expert'); configure(bundle, on(['finance-expert']));
    assert.equal(resources.capabilities.read('finance-expert').items.length, 1);
    assert.equal(resources.capabilities.read('hr-expert').items.length, 0); assert.equal(index('hr-expert'), before);
    const revision = resources.capabilities.detail(bundle).item.revision;
    resources.capabilities.configure(bundle, '', on(['finance-expert']));
    assert.equal(resources.capabilities.detail(bundle).item.revision, revision);
  });
  check('overlapping-packages-retain-active-skills-and-preserve-original-bindings', () => {
    const key = 'shared:shared/skills/draw-chart.md';
    configure(single, on(['finance-expert'])); configure(bundle, off);
    assert(resources.skillItems('finance-expert').some(skill => skill.key === key && skill.configured));
    configure(single, off);
    // The finance pack already configured draw-chart before either resource installation.
    assert(resources.skillItems('finance-expert').some(skill => skill.key === key && skill.configured));
    const fresh = resources.capabilities.import(body('only-from-resource'), 'skill');
    configure(fresh, on(['finance-expert'])); assert(library.detail('finance-expert').skills.some(skill => skill.name === 'only-from-resource'));
    configure(fresh, off); assert(!library.detail('finance-expert').skills.some(skill => skill.name === 'only-from-resource'));
  });
  check('local-override-restores-the-original-shared-binding-after-uninstall', () => {
    const uploaded = resources.capabilities.import(body('draw-chart', '用户确认的专属覆写'), 'skill');
    configure(uploaded, on(['finance-expert']));
    assert.equal(library.detail('finance-expert').skills.find(skill => skill.name === 'draw-chart')?.source, 'local');
    assert.throws(() => resources.configureSkill('finance-expert', 'shared:shared/skills/draw-chart.md', true), /同名/);
    configure(uploaded, off);
    assert.equal(library.detail('finance-expert').skills.find(skill => skill.name === 'draw-chart')?.source, 'shared');
  });
  check('a-conflict-in-one-expert-rolls-back-the-whole-multi-expert-install', () => {
    resources.uploadSkill('hr-expert', body('claude-wireframe', '已有用户覆写'));
    const financeBefore = index('finance-expert'), hrBefore = index('hr-expert');
    const versionCount = (resources as any).db.prepare('SELECT count(*) as n FROM resource_versions').get().n;
    assert.throws(() => configure('plugin:soul-design', on(['finance-expert', 'hr-expert'])), /同名/);
    assert.equal(index('finance-expert'), financeBefore); assert.equal(index('hr-expert'), hrBefore);
    assert.equal(resources.capabilities.detail('plugin:soul-design').item.installed, false);
    assert.equal((resources as any).db.prepare('SELECT count(*) as n FROM resource_versions').get().n, versionCount);
  });
  check('disable-enable-keeps-association-and-cannot-replace-edited-local-files', () => {
    const uploaded = resources.capabilities.import(body('retain-my-edit'), 'skill');
    configure(uploaded, on(['finance-expert']));
    const key = resources.capabilities.detail(uploaded).item.skills[0].key;
    const file = path.join(library.resourceLocation('finance-expert').root, key.slice(6));
    const edited = body('retain-my-edit') + '\n用户修改'; fs.writeFileSync(file, edited);
    configure(uploaded, { ...on(['finance-expert']), enabled: false });
    assert.equal(resources.capabilities.detail(uploaded).item.expertIds[0], 'finance-expert');
    assert.equal(fs.readFileSync(file, 'utf8'), edited);
    assert.throws(() => configure(uploaded, on(['finance-expert'])), /本地修改/);
    assert.equal(resources.capabilities.detail(uploaded).item.enabled, false);
    configure(uploaded, off); assert.equal(fs.readFileSync(file, 'utf8'), edited);
  });
  check('stale-configurations-are-rejected-before-changing-any-expert', () => {
    const old = resources.capabilities.detail(bundle).item.revision;
    configure(bundle, on([])); const before = index('finance-expert');
    assert.throws(() => resources.capabilities.configure(bundle, old, on(['finance-expert'])), /已变更/);
    assert.equal(index('finance-expert'), before);
  });
  check('import-validates-portable-names-size-and-declarative-only-package-format', () => {
    assert.throws(() => resources.capabilities.import(body('../escape'), 'skill'));
    assert.throws(() => resources.capabilities.import(body('CON'), 'skill'));
    assert.throws(() => resources.capabilities.import(body('multiline', 'first\nsecond'), 'skill'));
    assert.throws(() => resources.capabilities.import(body('huge') + '中'.repeat(30000), 'skill'), /64 KB/);
    const value = { schema: 'soul-plugin-v1', name: '本地资源包', description: '只包含 Markdown', readme: '# 说明', skills: [body('package-skill')] };
    assert.throws(() => resources.capabilities.import(JSON.stringify({ ...value, command: '/bin/sh' }), 'plugin'), /仅包含/);
    assert.throws(() => resources.capabilities.import(JSON.stringify({ ...value, skills: [body('duplicate'), body('duplicate')] }), 'plugin'), /重复/);
    const key = resources.capabilities.import(JSON.stringify(value), 'plugin');
    assert.equal(resources.capabilities.import(JSON.stringify(value), 'plugin'), key);
    configure(key, on(['finance-expert'])); assert(library.detail('finance-expert').skills.some(skill => skill.name === 'package-skill'));
  });
  check('invalid-and-uninstalled-expert-targets-do-not-change-the-registry', () => {
    assert.throws(() => configure(bundle, on(['unknown'])));
    assert.throws(() => configure(bundle, on(['design-master'])), /先安装/);
    assert.throws(() => configure(bundle, { ...off, expertIds: ['finance-expert'] }), /无效/);
    assert.throws(() => configure(bundle, on(['finance-expert', 'finance-expert'])), /无效/);
  });
  check('same-name-active-resources-cannot-silently-replace-each-other', () => {
    const a = resources.capabilities.import(body('same-name', '第一份'), 'skill'), b = resources.capabilities.import(body('same-name', '第二份'), 'skill');
    configure(a, on(['finance-expert'])); const before = index('finance-expert');
    assert.throws(() => configure(b, on(['finance-expert'])), /多个资源/);
    assert.equal(index('finance-expert'), before); assert(!resources.capabilities.detail(b).item.installed);
  });
  check('new-market-bundles-grant-real-skills-and-uninstall-preserves-shared-ownership', () => {
    library.installExpert('frontend-engineer');
    const before = library.detail('frontend-engineer').skills, unrelated = index('finance-expert');
    configure('plugin:soul-research', on(['frontend-engineer']));
    configure('plugin:soul-requirements', on(['frontend-engineer']));
    for (const name of ['agent-reach', 'decision-trace', 'chart-from-knowledge', 'draw-chart', 'grill-me', 'grill-against-knowledge']) {
      assert(library.detail('frontend-engineer').skills.some(skill => skill.name === name));
    }
    configure('plugin:soul-research', off);
    assert(library.detail('frontend-engineer').skills.some(skill => skill.name === 'decision-trace'));
    assert(!library.detail('frontend-engineer').skills.some(skill => skill.name === 'agent-reach'));
    configure('plugin:soul-requirements', off);
    assert.deepEqual(library.detail('frontend-engineer').skills, before);
    assert.equal(index('finance-expert'), unrelated);
  });
  check('restart-retains-installed-enabled-association-state-and-original-skill-content', () => {
    const expected = resources.capabilities.read(); resources.close(); library.close();
    library = new ExpertLibrary(root, profile); resources = new ResourceStore(root, profile, library);
    assert.deepEqual(resources.capabilities.read(), expected);
    assert(library.detail('finance-expert').skills.some(skill => skill.name === 'package-skill'));
  });
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify({ ok: true, checks }, null, 2));
} finally { resources.close(); library.close(); fs.rmSync(profile, { recursive: true, force: true }); }
