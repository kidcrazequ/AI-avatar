import { useEffect, useState } from 'react';
import type { ExpertRecord } from '../shared/contracts';
import { Avatar, Icon } from './primitives';
const groups = [
  { title: '', items: [['概览', 'home']] },
  { title: '工作', items: [['任务看板', 'board'], ['自主工作', 'autonomous']] },
  { title: '记忆与学习', items: [['记忆', 'memory'], ['自进化 Skill', 'evolution'], ['录制学习', 'recording']] },
  { title: '能力与资源', items: [['插件', 'plugins'], ['Skill', 'skills'], ['连接器', 'connectors'], ['工作流', 'flow'], ['知识库', 'knowledge'], ['项目', 'projects']] },
  { title: '权限与管理', items: [['权限', 'permissions'], ['专家档案', 'settings']] },
];
export const expertRoute = (id: string, page = 'home', detail = '') => `expert/${encodeURIComponent(id)}${page === 'home' ? '' : '/' + page}${detail ? '/' + encodeURIComponent(detail) : ''}`;
export function ExpertSidebar({ id, page, notice, expert }: { id: string; page: string; notice(message: string): void; expert?: ExpertRecord }) {
  const [identity, setIdentity] = useState(expert);
  useEffect(() => {
    if (expert) { setIdentity(expert); return; }
    let current = true; setIdentity(undefined);
    void window.soulDesktop.readExpert(id).then(value => { if (current) setIdentity(value); }).catch(error => { if (current) notice(String(error)); });
    return () => { current = false; };
  }, [id, expert, notice]);
  return <aside className="expert-sidebar" aria-label="专家详情导航" data-ued-node="shell.expert-nav">
    <button className="back" onClick={() => { location.hash = 'expert-management'; }}><Icon name="back" small />返回</button>
    <div className="expert-nav-identity" aria-label={identity?.name ?? '正在读取专家'}>{identity && <><Avatar name={identity.name} avatar={identity.avatar} /><span><strong>{identity.name}</strong><small>{identity.role}</small></span></>}</div>
    <nav>{groups.map(group => <div className="expert-nav-group" key={group.title}>{group.title && <div className="expert-nav-group-label">{group.title}</div>}<div className="expert-nav-group-items">{group.items.map(([label, target]) => <button key={target} className={`side-tab ${page === target ? 'active' : ''}`} aria-current={page === target ? 'page' : undefined} onClick={() => { location.hash = expertRoute(id, target); }}>{label}{target === 'recording' && <span className="expert-nav-beta">Beta</span>}</button>)}</div></div>)}</nav>
  </aside>;
}

export function ExpertPendingPage({ expert, page, notice }: { expert: ExpertRecord; page: string; notice(message: string): void }) {
  const title = groups.flatMap(group => group.items).find(item => item[1] === page)?.[0] ?? '专家页面';
  return <><ExpertSidebar id={expert.id} {...{ expert, page, notice }} /><main className="resource-main"><div className="resource-page"><header className="resource-header"><div><h1>{title}</h1></div></header><p className="resource-note">此功能尚未接入，当前没有可执行的配置。</p></div></main></>;
}
