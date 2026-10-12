import { useEffect, useState } from 'react';
import type { ExpertGroup, ExpertRecord, TaskView } from '../shared/contracts';
import { Avatar } from './primitives';
import { belongsToExpert, needsReview, taskKind } from './task-filters';
import { openTask, taskRoute } from './tasks-page';

export function ConversationContext({ expert, group, tasks, current, im, width, resize, manage }: { expert?: ExpertRecord; group?: ExpertGroup; tasks: TaskView[]; current?: TaskView; im: Set<string>; width: number; resize(width: number): void; manage(): void }) {
  const [tab, setTab] = useState(current?.workflow ? 'auto' : 'chat');
  useEffect(() => { if (current) setTab(current.workflow ? 'auto' : 'chat'); }, [current?.id, Boolean(current?.workflow)]);
  const relevant = tasks.filter(task => group ? task.groupId === group.id : expert && belongsToExpert(task, expert.id) && !task.groupId);
  const history = relevant.filter(task => tab === 'auto' ? taskKind(task, im) === 'auto' : taskKind(task, im) !== 'auto');
  const startResize = (event: React.PointerEvent) => {
    const start = event.clientX; event.currentTarget.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) => resize(Math.max(200, Math.min(400, width + next.clientX - start)));
    const stop = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', stop); };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', stop, { once: true });
  };
  return <aside className="conversation-sidebar conversation-context" aria-label={group?.name || expert?.name || '对话历史'} style={{ width }} data-ued-node="chat.sidebar"><header><button className="conversation-identity" onClick={manage}><Avatar name={group?.name || expert?.name || '专家'} avatar={group ? '' : expert?.avatar || ''} /><strong>{group?.name || expert?.name}</strong></button><button className="btn" onClick={manage}>管理</button></header>
    <div className="conversation-context-tabs" role="tablist" aria-label="对话历史">{[['chat', '对话任务'], ['auto', '自动任务']].map(([id, label]) => <button role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} key={id} onClick={() => setTab(id)}>{label}</button>)}</div>
    <div className="conversation-count"><span>共 {history.length} 个任务</span><button className="btn" aria-label={tab === 'chat' ? '新建对话任务' : '新建自动任务'} onClick={() => { location.hash = tab === 'chat' ? taskRoute(group ? 'group' : 'expert', group?.id || expert?.id || '') : `expert/${encodeURIComponent(expert?.id || '')}/autonomous`; }}>新建</button></div>
    <div className="conversation-history-list">{history.length ? history.map(task => <button className={`conversation-history ${current?.id === task.id ? 'active' : ''}`} key={task.id} onClick={() => openTask(task.id)}><i className={needsReview(task) ? 'unread' : task.status} title={needsReview(task) ? '有待查收结果' : task.status} /><strong title={task.title}>{task.title}</strong><span>{task.workflow ? 'Auto' : im.has(task.id) ? 'IM' : 'Chat'}<time>{new Date(task.updated).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></span></button>) : <p className="sidebar-empty">暂无{tab === 'auto' ? '自动' : '对话'}任务</p>}</div>
    <div className="conversation-resize" role="separator" aria-label="调整对话任务栏宽度" aria-orientation="vertical" tabIndex={0} onPointerDown={startResize} onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); resize(Math.max(200, Math.min(400, width + (event.key === 'ArrowLeft' ? -10 : 10)))); } }} />
  </aside>;
}
