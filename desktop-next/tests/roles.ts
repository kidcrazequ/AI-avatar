import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExpertLibrary } from '../electron/expert-library';
import { RoleGeneration } from '../electron/role-generation';
import { roleConnector } from '../electron/role-definition';
import type { RoleInput } from '../shared/contracts';
import type { ModelCall, ModelCredentials } from '../electron/task-models';

const resources = path.resolve(process.argv[2]), output = path.resolve(process.argv[3]);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-role-contract-'));
const checks: string[] = [];
let library = new ExpertLibrary(resources, profile);
const config: RoleInput = { name: '角色配置验收', description: '把项目资料整理为可复核的交接清单', identity: '保留用户职责 $1 $&', style: '先给结论，再列来源 $1 $&', redlines: '没有证据不下结论', workflow: '### 交接\n1. 核对资料\n2. 记录来源\n3. 交付复核', reviewed: true };
const credentials: ModelCredentials = { id: 'test', label: '受控验证提供器', model: 'test', baseUrl: 'http://127.0.0.1', protocol: 'openai', configured: true, apiKey: '' };
async function main() {
try {
  const catalog = library.list().templates;
  for (const id of JSON.parse(fs.readFileSync(path.join(resources, 'templates/general-role-ids.json'), 'utf8'))) {
    const role = catalog.find(item => item.id === id)!;
    assert(role && role.installable && !role.installed);
    const detail = library.detail(id); assert.equal(detail.testCases, 5); assert(detail.skills.every(skill => skill.available));
    assert(library.archive(id, 'soul.md').content.includes('没有配置的连接器不视为可用'));
    for (const file of fs.readdirSync(path.join(resources, 'expert-packs', id, 'tests/cases'))) {
      const text = fs.readFileSync(path.join(resources, 'expert-packs', id, 'tests/cases', file), 'utf8');
      assert(!text.includes('这里写发送') && !text.includes('评分维度1'));
    }
  }
  checks.push('All 11 reference roles supply complete source files, available skills and meaningful cases, without pretending installation or professional evaluation');
  const before = library.list().templates.length;
  assert.throws(() => library.createRole({ ...config, workflow: '### \n1. ' }), /流程/);
  assert.equal(library.list().templates.length, before);
  const skill = library.roleSkills()[0]; assert(skill);
  const upload = '---\nname: qa-role-skill\ndescription: 当用户整理交接清单时使用。\n---\n# 交接清单\n核对输入并记录来源。';
  const connector = roleConnector({ name: '验收只读连接', catalog: 'custom', transport: 'http', url: 'http://127.0.0.1:9/mcp', args: [] });
  const created = library.createRole({ ...config, skills: [skill, { name: 'qa-role-skill', path: 'skills/qa-role-skill.md', source: 'local', content: upload }], connectors: [connector] });
  const role = created.templates.find(item => item.name === config.name)!;
  assert(!created.experts.some(item => item.id === role.id && item.installed));
  const reopened = library.readRole(role.id);
  assert.equal(reopened.identity, config.identity); assert.equal(reopened.style, config.style); assert.equal(reopened.redlines, config.redlines);
  assert.equal(library.detail(role.id).skills.length, 2); assert(library.detail(role.id).skills.every(item => item.available));
  assert.deepEqual(reopened.connectors, [connector]);
  const soul = library.archive(role.id, 'soul.md').content;
  assert(soul.includes(config.identity) && soul.includes(config.style)); assert(soul.includes('数据溯源红线'));
  assert(soul.includes('## 5. Workflow — 我怎么工作') && soul.includes(config.workflow));
  assert(soul.includes('工作流自检清单') && soul.includes('诚实红线'));
  assert.equal(library.detail(role.id).about[1].items.length, 1);
  assert(library.detail(role.id).about[2].items[0].text.includes('交付复核'));
  checks.push('Saving a reviewed template preserves literal user text, skill bodies, connector references and Soul guardrails without creating an expert instance');
  const snapshot = library.createExpert({ templateId: role.id, name: '角色实例验收', description: '', avatar: null });
  const instance = snapshot.experts.find(item => item.name === '角色实例验收')!;
  assert.equal(library.detail(instance.id).skills.length, 2);
  const revision = reopened.revision;
  library.createRole({ ...reopened, identity: '更新后的职责', reviewed: true });
  assert.equal(library.readRole(role.id).identity, '更新后的职责');
  assert(library.archive(instance.id, 'soul.md').content.includes(config.identity));
  assert.throws(() => library.createRole({ ...reopened, revision, reviewed: true }), /其他窗口/);
  library.close(); library = new ExpertLibrary(resources, profile);
  assert.equal(library.readRole(role.id).identity, '更新后的职责'); assert(library.detail(instance.id).installed);
  checks.push('Template edits are optimistic and restart-persistent; existing instances retain their own copied persona and resources');
  assert.throws(() => roleConnector({ name: 'bad', transport: 'http', url: 'https://example.org?token=secret' }), /凭据/);
  assert.throws(() => roleConnector({ name: 'bad', transport: 'stdio', command: '/bin/echo', args: ['--api-key', 'secret'] }), /凭据/);
  assert.throws(() => library.createRole({ ...config, name: '无效技能', skills: [{ name: 'bad', path: '../bad.md', source: 'shared' }] }), /公共技能/);
  checks.push('Invalid workflows, escaping skill references and credential-bearing connector templates fail before persistence');
  let callCount = 0;
  const call: ModelCall = async (_model, messages) => { callCount++; assert.equal(messages.length, 2); assert(messages[0].content.includes('不执行任何工具')); return { text: JSON.stringify({ identity: config.identity, style: config.style, redlines: config.redlines, workflow: config.workflow }), calls: [] }; };
  const generation = new RoleGeneration({ resolve: () => credentials }, call);
  const draft = await generation.generate({ requestId: 'good', model: 'test', name: config.name, description: config.description });
  assert.equal(draft.identity, config.identity); assert.equal(draft.reviewed, false); assert.equal(callCount, 1);
  assert.equal(library.list().templates.length, before + 1);
  generation.close();
  const malformed = new RoleGeneration({ resolve: () => credentials }, async () => ({ text: '不是 JSON', calls: [] }));
  await assert.rejects(malformed.generate({ requestId: 'bad', model: 'test', name: config.name, description: config.description }), /有效配置/); malformed.close();
  checks.push('Generation performs one model call without tools or task history, returns an unreviewed draft and rejects malformed output without saving');
  const cancelled = new RoleGeneration({ resolve: () => credentials }, async () => new Promise(() => undefined));
  const pending = cancelled.generate({ requestId: 'cancel', model: 'test', name: config.name, description: config.description });
  cancelled.cancel('cancel'); await assert.rejects(pending, /取消/); cancelled.close();
  const missing = new RoleGeneration({ resolve: () => { throw new Error('尚未配置可用模型'); } }, call);
  await assert.rejects(missing.generate({ requestId: 'missing', model: 'Auto', name: config.name, description: config.description }), /尚未配置/); missing.close();
  checks.push('Cancellation terminates even a noncooperative provider; missing model configuration fails honestly and keeps user content');
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify({ ok: true, checks, realModel: false, platform: process.platform, arch: process.arch, electron: process.versions.electron }, null, 2));
  console.log(JSON.stringify({ ok: true, checks: checks.length, output }));
} finally { library.close(); fs.rmSync(profile, { recursive: true, force: true }); }

}
void main().catch(error => { console.error(error); process.exitCode = 1; });
