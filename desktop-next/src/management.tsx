import { useState } from 'react';
import type { ExpertGroup, ExpertRecord } from '../shared/contracts';
import { Avatar, Icon, Menu } from './primitives';
import { CreateDialog, GroupDialog, RemoveDialog, RenameDialog, type DialogActions } from './expert-dialogs';

export function Management(actions: DialogActions & { openExpert(id: string): void }) {
  const { library, saved, notice, openExpert } = actions;
  const [tab, setTab] = useState<'experts' | 'groups'>('experts');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('全部专家');
  const [environment, setEnvironment] = useState('全部环境');
  const [modal, setModal] = useState<'create' | 'group' | 'rename' | 'remove' | null>(null);
  const [selected, setSelected] = useState<ExpertRecord | ExpertGroup | null>(null);
  const [menu, setMenu] = useState<{ anchor: HTMLElement; type: 'status' | 'environment' | 'expert' | 'group'; item?: ExpertRecord | ExpertGroup } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<void>) => { if (busy) return; setBusy(true); try { await action(); } catch (error) { notice(String(error)); } finally { setBusy(false); } };
  const pending = () => notice('任务功能暂未开放');
  const query = search.toLocaleLowerCase().trim();
  const experts = library.experts.filter(item => (!query || `${item.name} ${item.role} ${item.domain} ${item.description}`.toLocaleLowerCase().includes(query)) && (status === '全部专家' || status === '已安装' && item.installed || status === '未安装' && !item.installed && !item.draft || status === '角色草案' && item.draft));
  const groups = library.groups.filter(item => !query || item.name.toLocaleLowerCase().includes(query));
  const more = (anchor: HTMLElement, type: 'expert' | 'group', item: ExpertRecord | ExpertGroup) => setMenu({ anchor, type, item });
  return <main data-ued-node="management.page"><div className="management"><header className="management-header"><div><h1>我的专家</h1><p>管理你的 Soul 专家，快速发起对话任务和自动任务。</p></div><div className="header-actions"><button className="btn primary" onClick={() => { setSelected(null); setModal(tab === 'experts' ? 'create' : 'group'); }}><Icon name="plus" small />{tab === 'experts' ? '新建专家' : '新建群组'}</button></div></header>
    <div className="segmented management-tabs" role="tablist" aria-label="管理分类">{(['experts', 'groups'] as const).map(value => <button key={value} role="tab" aria-selected={tab === value} className={tab === value ? 'active' : ''} onClick={() => { setTab(value); setSearch(''); }}>{value === 'experts' ? '我的专家' : '我的群组'}</button>)}</div>
    <div role="region" aria-label={tab === 'experts' ? '我的专家' : '我的群组'}>{tab === 'experts' && <div className="filter-row" data-ued-node="management.filters">
      {tab === 'experts' && <><button className="filter-trigger" aria-haspopup="menu" onClick={event => setMenu({ anchor: event.currentTarget, type: 'status' })}>状态<span className="filter-value">{status}</span><Icon name="down" small /></button><button className="filter-trigger" aria-haspopup="menu" onClick={event => setMenu({ anchor: event.currentTarget, type: 'environment' })}>环境<span className="filter-value">{environment}</span><Icon name="down" small /></button></>}
      <label className="search"><Icon name="search" small /><input aria-label={tab === 'experts' ? '搜索专家' : '搜索群组'} placeholder={tab === 'experts' ? '搜索专家或者专业领域...' : '搜索群组...'} value={search} onChange={event => setSearch(event.target.value)} />{search && <button className="clear" aria-label="清空搜索" onClick={() => setSearch('')}><Icon name="close" small /></button>}</label>
    </div>}
    {tab === 'experts' && experts.length > 0 && <div className="card-grid" data-ued-node="management.expert-list">{experts.map(expert => <article className="expert-card" key={expert.id} data-expert-id={expert.id}>
      <div className="card-identity" role="button" tabIndex={0} aria-label={`打开 ${expert.name} 的主页`} onClick={() => openExpert(expert.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openExpert(expert.id); } }}><Avatar name={expert.name} avatar={expert.avatar} /><div className="card-main"><div className="card-title"><strong title={expert.name}>{expert.name}</strong><span className="role" title={expert.role}>{expert.role}</span></div><div className="card-meta"><span>本机</span><span className="status" title={expert.sourceLabel}><i className={`status-dot ${expert.installed ? 'installed' : ''}`} />{expert.draft ? '角色草案' : expert.installed ? '已安装' : '未安装'}</span></div><p className="card-desc" title={expert.description}>{expert.description}</p></div></div>
      <div className="card-footer"><button className="card-action" onClick={() => { location.hash = `chat/expert/${encodeURIComponent(expert.id)}`; }}><Icon name="chat" small />创建对话任务</button><button className="card-action" onClick={pending}><Icon name="clock" small />创建自动任务</button><button className="icon-button card-more" aria-label={`${expert.name}的更多操作`} onClick={event => more(event.currentTarget, 'expert', expert)}><Icon name="more" small /></button></div>
    </article>)}</div>}
    {tab === 'groups' && groups.length > 0 && <div className="card-grid" data-ued-node="management.group-list">{groups.map(group => <article key={group.id} className="expert-card group-card"><div className="card-identity" role="button" tabIndex={0} aria-label={`编辑${group.name}`} onClick={() => { setSelected(group); setModal('group'); }} onKeyDown={event => { if (event.key === 'Enter') { setSelected(group); setModal('group'); } }}><div className="avatar"><Icon name="users" /></div><div className="card-main"><div className="card-title"><strong title={group.name}>{group.name}</strong><span className="role">{group.members.length} 位专家</span></div><div className="card-meta">Leader：{library.experts.find(item => item.id === group.leader)?.name}</div><div className="group-avatars">{group.members.map(member => { const expert = library.experts.find(item => item.id === member.expertId)!; return <Avatar key={member.expertId} name={expert.name} avatar={expert.avatar} />; })}</div></div></div><div className="card-footer"><button className="card-action" onClick={() => { location.hash = `chat/group/${encodeURIComponent(group.id)}`; }}><Icon name="chat" small />创建对话任务</button><button className="card-action" onClick={() => { setSelected(group); setModal('group'); }}><Icon name="edit" small />编辑群组</button><button className="icon-button card-more" aria-label={`${group.name}的更多操作`} onClick={event => more(event.currentTarget, 'group', group)}><Icon name="more" small /></button></div></article>)}</div>}
    {(tab === 'experts' ? !experts.length : !groups.length) && <div className="empty" data-ued-node="management.no-results"><Icon name={tab === 'groups' ? 'users' : 'search'} /><h3>{tab === 'groups' && !query ? '还没有群组' : '没有找到匹配结果'}</h3><p>{tab === 'groups' && !query ? '选择多位已安装专家，共同协作。' : '试试姓名、专业领域，或者重置搜索。'}</p><button className="btn" onClick={() => tab === 'groups' && !query ? setModal('group') : (setSearch(''), setStatus('全部专家'))}>{tab === 'groups' && !query ? '新建群组' : '重置搜索'}</button></div>}
    {library.removed > 0 && <button className="btn text recovery" disabled={busy} onClick={() => run(async () => { saved(await window.soulDesktop.restoreExperts()); notice('已移除内容已恢复'); })}>恢复已移除内容（{library.removed}）</button>}
    </div></div>
    {menu && <Menu anchor={menu.anchor} onClose={() => setMenu(null)}>
      {menu.type === 'status' && ['全部专家', '已安装', '未安装', '角色草案'].map(value => <button role="menuitem" key={value} onClick={() => setStatus(value)}>{value}</button>)}
      {menu.type === 'environment' && ['全部环境', '本机'].map(value => <button role="menuitem" key={value} onClick={() => setEnvironment(value)}>{value}</button>)}
      {menu.type === 'expert' && (() => { const expert = menu.item as ExpertRecord; return <>
        {!expert.installed && expert.installable && <button role="menuitem" disabled={busy} onClick={() => run(async () => { saved(await window.soulDesktop.installExpert(expert.id)); notice(`${expert.name}已安装`); })}><Icon name="download" small />安装专家</button>}
        <button role="menuitem" onClick={() => openExpert(expert.id)}><Icon name="home" small />查看主页</button><button role="menuitem" disabled={expert.draft} onClick={() => { setSelected(expert); setModal('rename'); }}><Icon name="edit" small />编辑名称</button><hr /><button role="menuitem" className="danger" onClick={() => { setSelected(expert); setModal('remove'); }}><Icon name="trash" small />移除专家</button>
      </>; })()}
      {menu.type === 'group' && <><button role="menuitem" onClick={() => { setSelected(menu.item!); setModal('group'); }}><Icon name="edit" small />编辑群组</button><button role="menuitem" className="danger" onClick={() => { setSelected(menu.item!); setModal('remove'); }}><Icon name="trash" small />移除群组</button></>}
    </Menu>}
    {modal === 'create' && <CreateDialog {...actions} onClose={() => setModal(null)} />}
    {modal === 'group' && <GroupDialog {...actions} group={selected && 'members' in selected ? selected : undefined} onClose={() => setModal(null)} />}
    {modal === 'rename' && selected && 'role' in selected && <RenameDialog {...actions} expert={selected} onClose={() => setModal(null)} />}
    {modal === 'remove' && selected && <RemoveDialog name={selected.name} onClose={() => setModal(null)} remove={async () => { saved(await ('members' in selected ? window.soulDesktop.removeGroup(selected.id) : window.soulDesktop.removeExpert(selected.id))); notice('已移除，资料仍然保留'); }} />}
  </main>;
}
