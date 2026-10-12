import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { ExpertGroup, ExpertRecord, TaskView } from '../shared/contracts';
import { Avatar, Icon, Menu } from './primitives';
import { GroupDialog, RemoveDialog, RenameDialog, type DialogActions } from './expert-dialogs';
import './recruitment.css';

type ManagementTab = 'experts' | 'groups';
function lastRun(tasks: TaskView[]) {
  return tasks.filter(task => task.rounds.length > 0).map(task => task.updated).sort().at(-1) ?? '';
}
function relativeTime(at: string) {
  if (!at) return '暂无';
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(at)) / 60000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}小时前`;
  return `${Math.floor(minutes / 1440)}天前`;
}
function runningState(tasks: TaskView[]) {
  return tasks.some(task => task.status === 'running') ? '执行中' : tasks.some(task => task.status === 'waiting') ? '待审批' : '空闲';
}
export function Management(actions: DialogActions & { openExpert(id: string): void; initialTab?: ManagementTab }) {
  const { library, saved, notice, openExpert, initialTab = 'experts' } = actions;
  const [tab, setTab] = useState<ManagementTab>(initialTab);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('全部');
  const [role, setRole] = useState('全部角色');
  const [environment, setEnvironment] = useState('全部环境');
  const [sort, setSort] = useState('默认排序');
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [taskError, setTaskError] = useState('');
  const [modal, setModal] = useState<'group' | 'rename' | 'remove' | null>(null);
  const [selected, setSelected] = useState<ExpertRecord | ExpertGroup | null>(null);
  const [menu, setMenu] = useState<{ anchor: HTMLElement; type: 'status' | 'role' | 'environment' | 'sort' | 'expert' | 'group'; item?: ExpertRecord | ExpertGroup } | null>(null);
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const refreshTasks = useCallback(() => {
    void window.soulDesktop.tasks.read().then(snapshot => { if (active.current) { setTasks(snapshot.tasks); setLoaded(true); setTaskError(''); } }).catch(error => { if (active.current) { setTaskError(String(error)); setLoaded(false); } });
  }, []);
  useEffect(() => { active.current = true; refreshTasks(); const unsubscribe = window.soulDesktop.tasks.onChanged(refreshTasks); return () => { active.current = false; unsubscribe(); }; }, [refreshTasks]);
  const run = async (action: () => Promise<void>) => { if (busy) return; setBusy(true); try { await action(); } catch (error) { notice(String(error)); } finally { setBusy(false); } };
  const related = (id: string, group = false) => tasks.filter(task => group ? task.groupId === id : task.expertId === id || task.members.some(member => member.expertId === id));
  const query = search.toLocaleLowerCase().trim();
  const matches = (value: string) => !query || value.toLocaleLowerCase().includes(query);
  const installed = library.experts.filter(item => item.installed);
  const roles = [...new Set(installed.map(item => item.role))].filter(Boolean);
  const experts = installed.filter(item => matches(`${item.name} ${item.role} ${item.domain} ${item.description}`) && (role === '全部角色' || role === item.role) && (status === '全部' || loaded && status === runningState(related(item.id))));
  const groups = library.groups.filter(item => matches(item.name));
  const compare = (a: ExpertRecord | ExpertGroup, b: ExpertRecord | ExpertGroup) => sort === '名称' ? a.name.localeCompare(b.name, 'zh-CN') : sort === '任务数' ? related(b.id, 'members' in b).length - related(a.id, 'members' in a).length : sort === '最近运行' ? lastRun(related(b.id, 'members' in b)).localeCompare(lastRun(related(a.id, 'members' in a))) : 0;
  experts.sort(compare); groups.sort(compare);
  const newItem = () => { if (tab === 'groups') { setSelected(null); setModal('group'); } else location.hash = 'recruitment-market'; };
  const more = (anchor: HTMLElement, type: 'expert' | 'group', item: ExpertRecord | ExpertGroup) => setMenu({ anchor, type, item });
  const filter = (type: 'status' | 'role' | 'environment' | 'sort', label: string, value: string) => <button className="filter-trigger" role="combobox" aria-label={label} aria-expanded={menu?.type === type} aria-haspopup="menu" onClick={event => setMenu({ anchor: event.currentTarget, type })}>{label}<span className="filter-value">{value}</span><Icon name="down" small /></button>;
  const stats = (id: string, group = false) => <div className="staff-card-stats"><span>任务数 <b>{loaded ? related(id, group).length : '—'}</b></span><i /><span>最近运行 <b title={lastRun(related(id, group))}>{loaded ? relativeTime(lastRun(related(id, group))) : '—'}</b></span></div>;
  return <main className="staff-management-page" data-ued-node="management.page"><div className="staff-management">
    <header className="staff-management-header"><div><h1>专家管理</h1><p>选择专家开始任务，或者新建一个开始工作。</p></div><button className="btn primary" onClick={newItem}><Icon name="plus" small />{tab === 'experts' ? '新建专家' : '新建群组'}</button></header>
    <div className="segmented staff-management-tabs" role="tablist" aria-label="管理分类">{(['experts', 'groups'] as const).map(value => <button key={value} role="tab" aria-selected={tab === value} className={tab === value ? 'active' : ''} onClick={() => { setTab(value); setSearch(''); setMenu(null); location.hash = value === 'groups' ? 'expert-management/groups' : 'expert-management'; }}>{value === 'experts' ? '专家' : '群组'}</button>)}</div>
    <div role="region" aria-label={tab === 'experts' ? '专家' : '群组'}>
      <div className="staff-management-filters" data-ued-node="management.filters"><label className="search"><input aria-label={tab === 'experts' ? '搜索专家' : '搜索群组'} placeholder="搜索名称或角色…" value={search} onChange={event => setSearch(event.target.value)} />{search ? <button className="clear" aria-label="清空搜索" onClick={() => setSearch('')}><Icon name="close" small /></button> : <Icon name="search" small />}</label>{tab === 'experts' && <>{filter('status', '运行状态', status)}{filter('role', '角色', role)}{filter('environment', '环境', environment)}</>}{filter('sort', '排序字段', sort)}<span className="staff-result-count">{tab === 'experts' ? `${experts.length} 个专家` : `${groups.length} 个群组`}</span></div>
      {taskError && <p className="form-error" role="alert">任务统计读取失败。<button className="btn text" onClick={() => refreshTasks()}>重新读取</button></p>}
      <div className="staff-card-grid" data-ued-node={tab === 'experts' ? 'management.expert-list' : 'management.group-list'}>
        <button className="staff-card staff-create-card" onClick={newItem}><span className="staff-create-art" aria-hidden="true">{library.templates.slice(0, 6).map((item, index) => <span className="staff-create-chip" key={item.id} style={{ '--chip-index': index } as CSSProperties}><Avatar name={item.name} avatar={item.avatar} /></span>)}</span><span className="staff-create-label"><Icon name="plus" />{tab === 'experts' ? '新建专家' : '新建群组'}</span></button>
        {tab === 'experts' ? experts.map(expert => <article className="staff-card" key={expert.id} data-expert-id={expert.id}><div className="staff-device"><span className="staff-presence"><i className={loaded && runningState(related(expert.id)) === '执行中' ? 'running' : ''} />{taskError ? '未知' : loaded ? runningState(related(expert.id)) : '读取中'}</span><span className="staff-local"><svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M4 16H20V5H4V16ZM13 18V20H17V22H7V20H11V18H2.9918C2.44405 18 2 17.5511 2 16.9925V4.00748C2 3.45107 2.45531 3 2.9918 3H21.0082C21.556 3 22 3.44892 22 4.00748V16.9925C22 17.5489 21.5447 18 21.0082 18H13Z" /></svg>本地</span></div><a className="staff-identity" href={`#expert/${encodeURIComponent(expert.id)}`} aria-label={`查看 ${expert.name} 的角色详情`}><Avatar name={expert.name} avatar={expert.avatar} /><div className="staff-title-row"><h2 title={expert.name}>{expert.name}</h2><span title={expert.role}><Icon name="workspace-users" small />{expert.role}</span></div><p title={expert.description}>{expert.description}</p></a><div className="staff-card-footer">{stats(expert.id)}<div className="staff-card-actions"><button className="btn" aria-label={`管理 ${expert.name}`} onClick={event => more(event.currentTarget, 'expert', expert)}><Icon name="settings" small /></button><button className="btn primary" onClick={() => { location.hash = `chat/expert/${encodeURIComponent(expert.id)}`; }}>对话</button></div></div></article>) : groups.map(group => <article className="staff-card" key={group.id}><button className="staff-identity" onClick={() => { setSelected(group); setModal('group'); }} aria-label={`编辑 ${group.name}`}><span className="staff-group-icon"><Icon name="users" /></span><div className="staff-title-row"><h2 title={group.name}>{group.name}</h2><span>{group.members.length} 位专家</span></div><div className="staff-group-members">{group.members.map(member => { const expert = library.experts.find(item => item.id === member.expertId); return expert ? <Avatar key={member.expertId} name={expert.name} avatar={expert.avatar} /> : <span key={member.expertId}>成员资料缺失</span>; })}</div></button><div className="staff-card-footer">{stats(group.id, true)}<div className="staff-card-actions"><button className="btn" aria-label={`管理 ${group.name}`} onClick={event => more(event.currentTarget, 'group', group)}><Icon name="settings" small /></button><button className="btn primary" onClick={() => { location.hash = `chat/group/${encodeURIComponent(group.id)}`; }}>对话</button></div></div></article>)}
      </div>
      {(tab === 'experts' ? !experts.length : !groups.length) && <div className="empty" data-ued-node="management.no-results"><h3>{query || role !== '全部角色' || status !== '全部' ? '没有找到匹配结果' : tab === 'experts' ? '还没有专家' : '还没有群组'}</h3><p>{query || role !== '全部角色' || status !== '全部' ? '试试其他名称或重置筛选。' : '从创建卡开始添加。'}</p>{(query || role !== '全部角色' || status !== '全部') && <button className="btn" onClick={() => { setSearch(''); setRole('全部角色'); setStatus('全部'); }}>重置筛选</button>}</div>}
      {library.removed > 0 && <button className="btn text recovery" disabled={busy} onClick={() => run(async () => { saved(await window.soulDesktop.restoreExperts()); notice('已移除内容已恢复'); })}>恢复已移除内容（{library.removed}）</button>}
    </div>
  </div>
    {menu && <Menu anchor={menu.anchor} onClose={() => setMenu(null)}>
      {menu.type === 'status' && ['全部', '执行中', '待审批', '空闲'].map(value => <button role="menuitem" key={value} onClick={() => setStatus(value)}>{value}</button>)}
      {menu.type === 'role' && ['全部角色', ...roles].map(value => <button role="menuitem" key={value} onClick={() => setRole(value)}>{value}</button>)}
      {menu.type === 'environment' && ['全部环境', '本地'].map(value => <button role="menuitem" key={value} onClick={() => setEnvironment(value)}>{value}</button>)}
      {menu.type === 'sort' && ['默认排序', '名称', '任务数', '最近运行'].map(value => <button role="menuitem" key={value} onClick={() => setSort(value)}>{value}</button>)}
      {menu.type === 'expert' && (() => { const expert = menu.item as ExpertRecord; return <><button role="menuitem" onClick={() => openExpert(expert.id)}><Icon name="home" small />查看主页</button><button role="menuitem" onClick={() => { location.hash = `expert/${encodeURIComponent(expert.id)}/flow`; }}><Icon name="clock" small />创建自动任务</button><button role="menuitem" onClick={() => { setSelected(expert); setModal('rename'); }}><Icon name="edit" small />编辑名称</button><hr /><button role="menuitem" className="danger" onClick={() => { setSelected(expert); setModal('remove'); }}><Icon name="trash" small />移除专家</button></>; })()}
      {menu.type === 'group' && <><button role="menuitem" onClick={() => { setSelected(menu.item!); setModal('group'); }}><Icon name="edit" small />编辑群组</button><button role="menuitem" className="danger" onClick={() => { setSelected(menu.item!); setModal('remove'); }}><Icon name="trash" small />移除群组</button></>}
    </Menu>}
    {modal === 'group' && <GroupDialog {...actions} group={selected && 'members' in selected ? selected : undefined} onClose={() => setModal(null)} />}
    {modal === 'rename' && selected && 'role' in selected && <RenameDialog {...actions} expert={selected} onClose={() => setModal(null)} />}
    {modal === 'remove' && selected && <RemoveDialog name={selected.name} onClose={() => setModal(null)} remove={async () => { saved(await ('members' in selected ? window.soulDesktop.removeGroup(selected.id) : window.soulDesktop.removeExpert(selected.id))); notice('已移除，资料仍然保留'); }} />}
  </main>;
}
