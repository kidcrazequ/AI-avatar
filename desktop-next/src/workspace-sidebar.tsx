import { useState } from 'react';
import type { LibrarySnapshot, RuntimeStatus } from '../shared/contracts';
import { Avatar, Icon } from './primitives';

export type WorkspaceSection = 'board' | 'im' | 'autonomous' | 'management' | 'resources';
const sections = [
  { label: '工作管理', short: '工作', items: [
    { key: 'board', icon: 'workspace-board', label: '任务看板', route: 'work-management' },
    { key: 'im', icon: 'at', label: '@专家', route: 'at-expert' },
    { key: 'autonomous', icon: 'bulb', label: '自主工作', route: 'autonomous-work' },
  ] },
  { label: '员工资源', short: '资源', items: [
    { key: 'management', icon: 'workspace-users', label: '专家管理', route: 'expert-management' },
    { key: 'resources', icon: 'sparkles', label: '能力与资源', route: 'resources/plugins' },
  ] },
];
const href = (route: string) => `#${route}`;

export function WorkspaceSidebar({ library, status, active, route, collapsed, toggle, create, usage, showUsage }: {
  library?: LibrarySnapshot; status?: RuntimeStatus; active?: WorkspaceSection; route: string[];
  collapsed: boolean; toggle(): void; create(group: boolean): void; usage: boolean; showUsage(): void;
}) {
  const [tab, setTab] = useState<'experts' | 'groups'>(route[0] === 'chat' && route[1] === 'group' ? 'groups' : 'experts');
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const experts = library?.experts.filter(item => item.installed) ?? [];
  const groups = library?.groups ?? [];
  const matches = (value: string) => collapsed || value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const selectTab = (value: typeof tab) => { setTab(value); setQuery(''); };
  return <aside className="workspace-sidebar" aria-label="主导航" data-ued-node="shell.global-nav" data-collapsed={collapsed}>
    <header className="workspace-brand">
      {collapsed ? <button className="workspace-brand-toggle" aria-label="展开侧栏" title="展开侧栏" onClick={toggle}><img src="./assets/soul-avatar.png" alt="" /><span className="workspace-expand-icon"><Icon name="panel" small /></span></button> : <><a href={href('expert-management')}><img src="./assets/soul-avatar.png" alt="" /><strong>Soul</strong></a><button className="icon-button" aria-label="收起侧栏" title="收起侧栏" onClick={toggle}><Icon name="panel" small /></button></>}
    </header>
    <nav className="workspace-navigation" aria-label="工作台导航">{sections.map(section => <div className="workspace-nav-group" key={section.label}>
      <div className="workspace-nav-heading">{collapsed ? section.short : section.label}</div>
      {section.items.map(item => <a key={item.key} href={href(item.route)} className={`workspace-nav-link ${active === item.key ? 'active' : ''}`} aria-label={item.label} title={collapsed ? item.label : undefined} aria-current={active === item.key ? 'page' : undefined}><Icon name={item.icon} small /><span>{item.label}</span></a>)}
    </div>)}</nav>
    <section className="workspace-people" aria-label="专家与群组">
      {collapsed ? <button className="workspace-people-switch icon-button" aria-label={`切换到${tab === 'experts' ? '群组' : '专家'}`} title={`切换到${tab === 'experts' ? '群组' : '专家'}`} onClick={() => selectTab(tab === 'experts' ? 'groups' : 'experts')}><Icon name="swap" small /></button> : <div className="workspace-people-tabs" role="tablist" aria-label="专家与群组">
        <button id="workspace-experts-tab" role="tab" aria-controls="workspace-people-list" aria-selected={tab === 'experts'} className={tab === 'experts' ? 'active' : ''} onClick={() => selectTab('experts')}>专家（{experts.length}）</button>
        <button id="workspace-groups-tab" role="tab" aria-controls="workspace-people-list" aria-selected={tab === 'groups'} className={tab === 'groups' ? 'active' : ''} onClick={() => selectTab('groups')}>群组（{groups.length}）</button>
      </div>}
      <div className="workspace-people-actions"><button className="workspace-create" aria-label={tab === 'experts' ? '新建专家' : '新建群组'} title={collapsed ? (tab === 'experts' ? '新建专家' : '新建群组') : undefined} disabled={!library} onClick={() => create(tab === 'groups')}><Icon name="plus" small /><span>{tab === 'experts' ? '新建专家' : '新建群组'}</span></button>
        {!collapsed && <button className="icon-button" aria-label="搜索专家与群组" aria-expanded={searching} onClick={() => { setSearching(!searching); setQuery(''); }}><Icon name={searching ? 'close' : 'search'} small /></button>}
      </div>
      {!collapsed && searching && <input className="workspace-people-search" aria-label={tab === 'experts' ? '搜索专家' : '搜索群组'} placeholder={tab === 'experts' ? '搜索专家' : '搜索群组'} autoFocus value={query} onChange={event => setQuery(event.target.value)} />}
      <div id="workspace-people-list" className="workspace-people-list" role={collapsed ? undefined : 'tabpanel'} aria-labelledby={collapsed ? undefined : `workspace-${tab}-tab`}>
        {tab === 'experts' ? experts.filter(item => matches(`${item.name} ${item.description}`)).map(item => <a key={item.id} href={href(`chat/expert/${encodeURIComponent(item.id)}`)} className={`workspace-person ${route[0] === 'chat' && route[1] === 'expert' && route[2] === item.id ? 'active' : ''}`} aria-label={`与${item.name}对话`} title={collapsed ? item.name : undefined}><Avatar name={item.name} avatar={item.avatar} /><span className="workspace-person-text"><strong>{item.name}</strong><span>{item.description || item.role}</span></span></a>) : groups.filter(item => matches(item.name)).map(item => <a key={item.id} href={href(`chat/group/${encodeURIComponent(item.id)}`)} className={`workspace-person ${route[0] === 'chat' && route[1] === 'group' && route[2] === item.id ? 'active' : ''}`} aria-label={`与${item.name}群组对话`} title={collapsed ? item.name : undefined}><span className="workspace-group-avatar"><Icon name="users" small /></span><span className="workspace-person-text"><strong>{item.name}</strong><span>{item.members.length} 位专家</span></span></a>)}
        {!collapsed && library && !(tab === 'experts' ? experts.some(item => matches(`${item.name} ${item.description}`)) : groups.some(item => matches(item.name))) && <p className="workspace-people-empty">{query ? '没有匹配结果' : tab === 'experts' ? '暂无已安装专家' : '暂无群组'}</p>}
      </div>
    </section>
    <footer className="workspace-footer"><span className="workspace-profile-avatar"><Icon name="id" small /></span><div className="workspace-profile"><strong>本地工作台</strong><span>{status ? `Soul ${status.version}` : '正在连接…'}</span></div><button className="icon-button" aria-label="用量" title="用量" aria-expanded={usage} onClick={showUsage}><Icon name="gauge" small /></button><a className="icon-button" href={href('app-settings/preferences')} aria-label="设置" title="设置" aria-current={route[0] === 'app-settings' ? 'page' : undefined}><Icon name="settings" small /></a></footer>
  </aside>;
}
