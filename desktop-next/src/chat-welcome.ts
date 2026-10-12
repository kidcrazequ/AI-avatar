import type { ExpertDetail, ExpertGroup, ExpertRecord, SkillItem } from '../shared/contracts';

const genericTitles = new Set(['工作流程', '标准工作流程', '资料说明', '收口问题', '取证与核对', '输出']);
const starterExamples: Record<string, string[]> = {
  'finance-expert': ['核对财务报表的勾稽关系与数据来源', '整理预算与实际差异，列出待确认口径', '根据已有资料分析现金流与财务风险'],
  '小堵-工商储专家': ['核对工商业储能项目的用电数据与配置方案', '测算储能项目收益，列明假设与数据来源', '梳理项目适用政策与待确认的接入条件'],
};
const domainExamples: Record<string, string[]> = {
  '财务分析': starterExamples['finance-expert'],
  '工商业储能（C&I ESS）': starterExamples['小堵-工商储专家'],
};
const clean = (value: string) => value.replace(/\s+/g, ' ').trim();
const workflowPrompt = (title: string) => /^(构建|修复|优化|重构|设计|开发|分析|审核|审查|整理|准备|编写|制定|排查|处理|检查|生成|核对|评估|规划|部署|维护|配置|建立|实现|交付|测试|汇总|梳理)/.test(title)
  ? `帮我${title}` : `协助我完成「${title}」`;
const usefulTitle = (value: string) => {
  const title = clean(value);
  return title && title.length <= 36 && !genericTitles.has(title) && !/^(熟悉|处理过|工作风格|请查看|阶段[一二三四五六七八九十\d]+[：:])/.test(title) ? title : '';
};

export function chatWelcome(expert?: ExpertRecord, detail?: ExpertDetail, skills: SkillItem[] = [], group?: ExpertGroup, members: ExpertRecord[] = []) {
  if (group) {
    const names = group.members.map(member => members.find(item => item.id === member.expertId)?.name).filter((name): name is string => Boolean(name));
    const participants = names.length ? names.slice(0, 3).join('、') + (names.length > 3 ? `等${names.length}位专家` : '') : '群组成员';
    return {
      introduction: `${group.name} · ${group.members.length} 位专家协作，Leader 汇总成果。`,
      suggestions: [`请${participants}协作分析一个问题并分工`, `请${participants}交叉核对方案中的风险与待确认事项`, `请${participants}汇总各自结论，形成交付草案`],
    };
  }
  const fullDescription = clean(expert?.description ?? '');
  const description = fullDescription.length > 120 ? fullDescription.slice(0, 120) + '…' : fullDescription;
  const role = clean(expert?.role ?? '');
  const introduction = `我是${expert?.name ?? 'Soul'}。${description && description !== expert?.name ? description : role && role !== expert?.name ? `专注${role}相关工作。` : '告诉我你的目标和已有资料，我们一起梳理下一步。'}`;
  // Read the active instance's definition rather than guessing its profession from its display name.
  const current = detail?.id === expert?.id ? detail : undefined;
  const workflows = current?.about.find(section => section.title === '工作模式')?.items.map(item => usefulTitle(item.title)).filter(Boolean) ?? [];
  const duties = current?.about.find(section => section.title === '擅长')?.items.map(item => usefulTitle(item.title)).filter(Boolean) ?? [];
  const availableSkills = skills.filter(skill => skill.configured && skill.available && skill.source === 'local').map(skill => usefulTitle(skill.title || skill.name)).filter(Boolean);
  const examples = expert?.source !== 'custom' ? starterExamples[expert?.templateId ?? ''] ?? domainExamples[expert?.domain ?? ''] ?? [] : [];
  const suggestions = [...new Set([
    ...workflows.map(workflowPrompt),
    ...(!workflows.length ? examples : []),
    ...duties.map(title => `协助我完成「${title}」相关工作`),
    ...availableSkills.map(title => `使用「${title}」处理一项工作`),
    ...examples,
    ...(expert?.knowledgeFiles ? ['根据我的问题检索知识库，给出来源与资料缺口'] : []),
    `围绕${role && role !== expert?.name ? role : expert?.name ?? '当前专家'}的职责，梳理任务目标与所需资料`,
    '根据我提供的资料，列出待确认事项和下一步',
    '整理这次任务的交付要求与复核清单',
  ])].slice(0, 3);
  return { introduction, suggestions };
}
