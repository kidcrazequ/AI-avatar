import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chatWelcome } from '../src/chat-welcome';
import type { ExpertDetail, ExpertGroup, ExpertRecord, SkillItem } from '../shared/contracts';

const checks: string[] = [];
const check = (name: string, run: () => void) => { run(); checks.push(name); };
const expert = (templateId: string, name = '测试专家', source: ExpertRecord['source'] = 'bundled') => ({ id: templateId, templateId, name, role: name, description: '', source, knowledgeFiles: 0 }) as ExpertRecord;
const detail = (record: ExpertRecord, workflows: string[], duties: string[] = []) => ({ ...record, about: [
  { title: '工作模式', source: 'soul.md', items: workflows.map(title => ({ title, text: '' })) },
  { title: '擅长', source: 'soul.md', items: duties.map(title => ({ title, text: '' })) },
] }) as ExpertDetail;

check('The 11 real role definitions produce distinct starters without model generation', () => {
  const root = path.resolve(process.argv[2]);
  const ids = JSON.parse(fs.readFileSync(path.join(root, 'templates/general-role-ids.json'), 'utf8')) as string[];
  const starters = ids.map(id => {
    const role = JSON.parse(fs.readFileSync(path.join(root, 'expert-packs', id, 'role-input.json'), 'utf8'));
    const record = { ...expert(id, role.name), description: role.description };
    const workflows = [...role.workflow.matchAll(/^###?\s+(.+)$/gm)].map(match => match[1]);
    const duties = role.identity.split('\n').map((row: string) => row.split('：')[0]);
    const result = chatWelcome(record, detail(record, workflows, duties));
    assert.equal(result.suggestions.length, 3);
    assert.equal(new Set(result.suggestions).size, 3);
    assert(result.suggestions.some(value => workflows.some(title => value.includes(title)) || duties.some((title: string) => value.includes(title))));
    return result.suggestions.join('|');
  });
  assert.equal(new Set(starters).size, ids.length);
});
check('Financial and storage experts keep professional starters after renaming', () => {
  const finance = expert('finance-expert', '导入验收财务', 'imported');
  const welcome = chatWelcome(finance);
  assert.equal(welcome.introduction.split(finance.name).length - 1, 1);
  assert(welcome.suggestions.some(value => value.includes('报表')));
  assert(chatWelcome({ ...finance, templateId: 'finance-import-ui-step2', domain: '财务分析' }).suggestions.some(value => value.includes('报表')));
  assert(chatWelcome(expert('小堵-工商储专家')).suggestions.some(value => value.includes('储能')));
  const storage = expert('小堵-工商储专家');
  assert(chatWelcome(storage, detail(storage, ['阶段一：需求理解与初步分析', '阶段二：深入研究与方案制定'], ['资深方案工程师'])).suggestions.every(value => /储能|政策/.test(value)));
  assert.notDeepEqual(welcome.suggestions, chatWelcome(expert('custom-finance-name', '财务专家', 'custom')).suggestions);
});
check('An edited instance definition overrides template examples; stale details cannot cross experts', () => {
  const current = expert('finance-expert', '自定义职责');
  const edited = detail(current, ['审核设备采购', '整理交接记录', '准备验收资料']);
  assert.deepEqual(chatWelcome(current, edited).suggestions, ['帮我审核设备采购', '帮我整理交接记录', '帮我准备验收资料']);
  assert(chatWelcome(current, { ...edited, id: 'another' }).suggestions.every(value => !value.includes('设备采购')));
});
check('Custom experts use actual duties and only available configured local skills', () => {
  const current = expert('custom', '我的分身', 'custom');
  assert.equal(chatWelcome(current, detail(current, ['项目交接'])).suggestions[0], '协助我完成「项目交接」');
  const skill = (title: string, configured: boolean, available: boolean, source: SkillItem['source'] = 'local') => ({ title, name: title, configured, available, source }) as SkillItem;
  const welcome = chatWelcome(current, detail(current, [], ['会议交接']), [skill('交接清单', true, true), skill('未授权技能', false, true), skill('缺失技能', true, false), skill('通用共享技能', true, true, 'shared')]);
  assert(welcome.suggestions[0].includes('会议交接'));
  assert(welcome.suggestions[1].includes('交接清单'));
  assert(welcome.suggestions.every(value => !/未授权|缺失|通用共享/.test(value)));
  assert(chatWelcome(current).suggestions.every(value => !value.includes('知识库')));
});
check('Group starters describe its actual participants rather than the leader alone', () => {
  const members = [expert('frontend', '前端'), expert('finance', '财务')];
  const group = { name: '协作组', members: members.map(member => ({ expertId: member.id })) } as ExpertGroup;
  const welcome = chatWelcome(members[0], undefined, [], group, members);
  assert(welcome.suggestions.every(value => value.includes('前端、财务')));
  assert(welcome.suggestions.some(value => value.includes('分工')));
});
check('Long descriptions fit the welcome area; duplicate role names stay suppressed', () => {
  const current = expert('custom', '个人专家', 'custom');
  assert.equal(chatWelcome({ ...current, description: current.name }).introduction.split(current.name).length - 1, 1);
  assert(chatWelcome({ ...current, description: '长描述'.repeat(300) }).introduction.length < 150);
});
const result = { passed: checks.length, checks };
if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
