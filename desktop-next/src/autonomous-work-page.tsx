import { useCallback, useEffect, useState } from 'react';
import type { LibrarySnapshot, WorkflowRecord, WorkflowSnapshot } from '../shared/contracts';
import { Avatar, Icon, Modal } from './primitives';
import { AutomationDialog } from './automation-dialog';
import { FlowConfigDialog, triggerSummary } from './workflow-dialogs';
import { openTask, taskStatuses, useTasks } from './tasks-page';
import './autonomous-work.css';

export function AutonomousWorkPage({ library, notice, scope = '' }: { library: LibrarySnapshot; notice(value: string): void; scope?: string }) {
  const [snapshot, setSnapshot] = useState<WorkflowSnapshot>({ workflows: [], runs: [], api: { url: '', error: '' } });
  const [loaded, setLoaded] = useState(false), [error, setError] = useState('');
  const [executor, setExecutor] = useState('all'), [type, setType] = useState('all'), [state, setState] = useState('all'), [sort, setSort] = useState('created');
  const [edit, setEdit] = useState<WorkflowRecord | null>(), [history, setHistory] = useState<WorkflowRecord>(), [busy, setBusy] = useState(false);
  const tasks = useTasks(notice);
  const refresh = useCallback(() => { void window.soulDesktop.workflows.read().then(value => { setSnapshot(value); setLoaded(true); setError(''); }).catch(error => { setLoaded(true); setError(String(error)); }); }, []);
  useEffect(() => { refresh(); return window.soulDesktop.workflows.onChanged(refresh); }, [refresh]);
  const owned = (job: WorkflowRecord) => {
    if (!scope) return true;
    if (job.automation?.kind === 'expert') return job.automation.targetId === scope;
    return (snapshot.workflows.find(item => item.id === job.automation?.targetId)?.steps ?? job.steps).some(step => step.expert === scope);
  };
  const jobs = snapshot.workflows.filter(job => (job.automation || job.config.triggers.length) && owned(job));
  const kind = (job: WorkflowRecord) => job.automation?.kind ?? 'workflow';
  const targetName = (job: WorkflowRecord) => kind(job) === 'expert' ? library.experts.find(item => item.id === job.automation?.targetId)?.name ?? '专家已移除' : snapshot.workflows.find(item => item.id === job.automation?.targetId)?.name ?? (job.automation ? '工作流已移除' : job.name);
  const runs = (job: WorkflowRecord) => snapshot.runs.filter(run => run.workflowId === job.id);
  const filtered = jobs.filter(job => (executor === 'all' || kind(job) === executor) && (type === 'all' || job.config.triggers.some(trigger => trigger.type === type)) && (state === 'all' || job.config.enabled === (state === 'enabled'))).sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name, 'zh-CN') : Date.parse(b[sort === 'updated' ? 'updated' : 'created']) - Date.parse(a[sort === 'updated' ? 'updated' : 'created']));
  const act = async (action: () => Promise<unknown>) => { if (busy) return; setBusy(true); try { await action(); refresh(); } catch (error) { notice(String(error)); } finally { setBusy(false); } };
  const currentEdit = edit ? snapshot.workflows.find(item => item.id === edit.id) ?? edit : edit;
  const runJob = (job: WorkflowRecord) => act(async () => { const id = await window.soulDesktop.workflows.run(job.id, job.config.prompt || `执行工作流：${targetName(job)}`, crypto.randomUUID()); const snapshot = await window.soulDesktop.workflows.read(); const run = snapshot.runs.find(item => item.id === id); if (run?.taskId) openTask(run.taskId); else setHistory(job); });
  return <><main className="autonomous-page" data-ued-node="autonomous.page"><header className="management-header"><div><h1>自主工作</h1><p>通过定时、事件或 API 自动开工，并由专家或工作流响应。</p></div><button className="btn primary" onClick={() => setEdit(null)}><Icon name="plus" small />新建自动任务</button></header>
    <section className="autonomous-summary" aria-label="自主工作">{[
      [jobs.length, '自动任务总数', '全部自动任务'], [jobs.filter(job => job.config.enabled).length, '已启用', '当前已启用的自动任务'],
      [jobs.filter(job => kind(job) === 'expert').length, '专家执行', '由专家执行的自动任务'], [jobs.filter(job => kind(job) === 'workflow').length, '工作流执行', '由工作流执行的自动任务'],
    ].map(([number, label, hint]) => <article key={label}><strong>{number}</strong><span>{label}</span><small>{hint}</small></article>)}</section>
    <div className="autonomous-filters">{[
      ['执行者', executor, setExecutor, [['all', '全部执行者'], ['expert', '专家'], ['workflow', '工作流']]],
      ['触发类型', type, setType, [['all', '全部类型'], ['timer', '定时'], ['event', '事件'], ['api', 'API']]],
      ['自动任务状态', state, setState, [['all', '全部状态'], ['enabled', '已启用'], ['disabled', '已暂停']]],
      ['排序', sort, setSort, [['created', '最近创建'], ['updated', '最近更新'], ['name', '名称']]],
    ].map(([label, value, set, options]) => <label className="labeled-select" key={label as string}><span>{label as string}</span><select aria-label={label as string} value={value as string} onChange={event => (set as (value: string) => void)(event.target.value)}>{(options as string[][]).map(([id, text]) => <option value={id} key={id}>{text}</option>)}</select></label>)}</div>
    {snapshot.api.error && <p role="alert" className="form-error">{snapshot.api.error}</p>}
    {error ? <div className="autonomous-empty"><p role="alert">{error}</p><button className="btn" onClick={refresh}>重试</button></div> : !loaded ? <p className="autonomous-empty">正在读取自动任务…</p> : !filtered.length ? <div className="autonomous-empty"><strong>{jobs.length ? '暂无符合筛选条件的自动任务' : '还没有自动任务'}</strong><p>创建自动任务，按定时、事件或 API 自动唤起专家 / 工作流。</p></div> : <div className="autonomous-list">{filtered.map(job => { const last = runs(job)[0], target = library.experts.find(item => item.id === job.automation?.targetId); return <article className="automatic-job" key={job.id}><header><div><button className="row-title" onClick={() => setEdit(job)}>{job.name}</button><span className={`task-badge ${job.config.enabled ? 'completed' : 'stopped'}`}>{job.config.enabled ? '已启用' : '已暂停'}</span></div><button className="switch" role="switch" aria-label={`启用 ${job.name}`} aria-checked={job.config.enabled} disabled={busy} onClick={() => act(() => window.soulDesktop.workflows.configure(job.id, job.version, { ...job.config, enabled: !job.config.enabled }, crypto.randomUUID()))} /></header><div className="automatic-executor">{target ? <Avatar name={target.name} avatar={target.avatar} /> : <Icon name="flow" />}<span>{kind(job) === 'expert' ? '专家' : '工作流'} · {targetName(job)}</span></div><div className="automatic-triggers">{job.config.triggers.map(trigger => <div key={trigger.id}><Icon name={trigger.type === 'timer' ? 'clock' : trigger.type === 'event' ? 'flow' : 'connector'} small /><span>{triggerSummary(trigger)}{trigger.error && <small role="alert">{trigger.error}</small>}{trigger.nextAt && job.config.enabled && <small>下次运行：{new Date(trigger.nextAt).toLocaleString('zh-CN')}</small>}</span></div>)}</div><footer><small>{runs(job).length} 次记录 · {last ? `${last.origin} · ${new Date(last.created).toLocaleString('zh-CN')}` : '尚未运行'}</small><div><button className="btn text" onClick={() => setHistory(job)}>执行记录</button><button className="btn" onClick={() => setEdit(job)}>编辑</button><button className="btn" disabled={busy} onClick={() => runJob(job)}>运行</button><button className="icon-button" aria-label={`移除 ${job.name}`} disabled={busy} onClick={() => act(() => window.soulDesktop.workflows.remove(job.id, crypto.randomUUID()))}><Icon name="trash" small /></button></div></footer></article>; })}</div>}
    {Boolean(snapshot.removedAutomations) && <button className="btn text" disabled={busy} onClick={() => act(() => window.soulDesktop.workflows.restoreRemoved(crypto.randomUUID(), true))}>恢复已移除任务</button>}
  </main>
  {currentEdit !== undefined && (!currentEdit || currentEdit.automation ? <AutomationDialog key={currentEdit?.id ?? 'new'} {...{ library, scope, snapshot }} job={currentEdit ?? undefined} onClose={() => setEdit(undefined)} saved={refresh} /> : <FlowConfigDialog flow={currentEdit} models={tasks.models} projects={[]} triggerMode saved={refresh} onClose={() => setEdit(undefined)} />)}
  {history && <Modal title="自动任务执行记录" className="task-dialog" onClose={() => setHistory(undefined)} footer={<button className="btn" onClick={() => setHistory(undefined)}>关闭</button>}><div className="dialog-body"><h2>{history.name}</h2>{runs(history).length ? runs(history).map(run => <article className="automation-run" key={run.id}><strong>{taskStatuses[run.status as keyof typeof taskStatuses] ?? ({ missed: '漏执行', skipped: '已跳过', queued: '排队中' } as Record<string, string>)[run.status]}</strong><p>{run.origin} · {new Date(run.created).toLocaleString('zh-CN')} · v{run.version}</p>{run.note && <p>{run.note}</p>}<div className="flex">{run.taskId && <button className="btn" onClick={() => openTask(run.taskId)}>查看任务</button>}{['missed', 'interrupted', 'failed', 'queued'].includes(run.status) && <button className="btn" disabled={busy} onClick={() => act(() => window.soulDesktop.workflows.resume(run.id, crypto.randomUUID()))}>{run.status === 'missed' ? '补跑一次' : '继续执行'}</button>}{['missed', 'interrupted', 'waiting', 'running', 'queued', 'pending'].includes(run.status) && <button className="btn" disabled={busy} onClick={() => act(() => window.soulDesktop.workflows.cancel(run.id, crypto.randomUUID()))}>停止</button>}</div></article>) : <p className="sidebar-empty">尚无执行记录</p>}</div></Modal>}
  </>;
}
