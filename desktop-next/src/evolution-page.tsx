import { useEffect, useRef, useState } from 'react';
import type { ExpertDetail, LibrarySnapshot, SkillItem } from '../shared/contracts';
import type { EvolutionDraft, EvolutionSnapshot } from '../shared/learning';
import { ExpertSidebar } from './expert-sidebar';
import { Icon, Modal } from './primitives';
import './evolution.css';

const states: Record<EvolutionDraft['state'], string> = { generating: '正在复盘', draft: '待复核', failed: '复盘失败', cancelled: '已取消', rejected: '已放弃', applying: '正在保存', applied: '已保存' };
const api = () => window.soulDesktop.evolution;
export function EvolutionPage({ expert, notice, saved }: { expert: ExpertDetail; notice(message: string): void; saved(value: LibrarySnapshot): void }) {
  const [data, setData] = useState<EvolutionSnapshot>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [generate, setGenerate] = useState(false);
  const [allow, setAllow] = useState<SkillItem[]>();
  const [preview, setPreview] = useState<{ title: string; content: string }>();
  const [draft, setDraft] = useState<EvolutionDraft>();
  const [content, setContent] = useState('');
  const [history, setHistory] = useState<{ title: string; versions: EvolutionDraft[] }>();
  useEffect(() => {
    let current = true;
    const load = () => api().read(expert.id).then(value => { if (current) setData(value); }).catch(cause => { if (current) setError(String(cause)); });
    void load(); const off = api().onChanged(() => { void load(); });
    return () => { current = false; off(); };
  }, [expert.id]);
  const run = async (work: () => Promise<void>): Promise<boolean> => {
    if (running.current) return false; running.current = true; setBusy(true); setError('');
    try { await work(); setData(await api().read(expert.id)); return true; }
    catch (cause) { setError(String(cause)); return false; }
    finally { running.current = false; setBusy(false); }
  };
  const openAllow = () => { void run(async () => { const resources = await window.soulDesktop.resources.read(expert.id); setAllow(resources.skills.filter(item => item.source === 'local' && item.available)); }); };
  const resolve = (accepted: boolean) => { if (draft) void run(async () => { await api().resolve(draft.id, draft.updated, content, accepted); if (accepted) { saved(await window.soulDesktop.readLibrary()); notice('技能已保存到本专家，来源与版本已记录'); } setDraft(undefined); }); };
  const pending = data?.drafts.filter(item => item.state !== 'applied' && item.state !== 'rejected') ?? [];
  return <><ExpertSidebar id={expert.id} page="evolution" {...{ expert, notice }} /><main className="resource-main evolution-main" data-ued-node="learning.evolution"><div className="evolution-page">
    <header className="evolution-header"><div><h1>自进化 Skill</h1><p>让专家在任务中持续学习与进化</p></div><div className="flex"><button className="btn" disabled={!data || busy} onClick={openAllow}>允许自进化</button><button className="btn" disabled={!data?.setting.enabled || !data.tasks.length || busy} onClick={() => setGenerate(true)}>复盘成功任务</button></div></header>
    {error && <p className="error" role="alert">{error}</p>}
    {!data ? <p role="status">正在读取自进化 Skill…</p> : <>
      <section className="evolution-setting"><div><strong>自进化 Skill</strong><span className={`evolution-badge ${data.setting.enabled ? 'on' : ''}`}>{data.setting.enabled ? '已开启' : '已关闭'}</span><p>复杂任务成功完成后，专家可复盘任务，更新已有自进化 Skill 或创建新 Skill。只有专家在任务中总结出来的 Skill 和用户明确开启“允许自进化”的专属 Skill 会出现在这里。草案经复核后保存。</p></div><button className="switch" role="switch" aria-label="自进化 Skill" aria-checked={data.setting.enabled} disabled={busy} onClick={() => { void run(() => api().configure(expert.id, data.setting.revision, !data.setting.enabled)); }} /></section>
      {!data.skills.length && !pending.length ? <div className="evolution-empty">暂无自进化 Skill</div> : <>
        {!!pending.length && <section className="evolution-drafts" aria-label="任务复盘记录">{pending.map(item => <article key={item.id}><div><strong>{item.name || item.taskTitle}</strong><span className="evolution-badge">{states[item.state]}</span><p>来源：{item.taskTitle} · {new Date(item.created).toLocaleString()}</p>{item.error && <p className="error">{item.error}</p>}</div><div className="flex">{item.state === 'draft' && <button className="btn primary" disabled={busy} onClick={() => { setDraft(item); setContent(item.content); }}>复核草案</button>}{item.state === 'generating' && <button className="btn" disabled={busy} onClick={() => { void run(() => api().cancel(item.id)); }}>取消复盘</button>}<a className="btn" href={`#task/${encodeURIComponent(item.taskId)}`}>来源任务</a></div></article>)}</section>}
        <section className="evolution-skills" aria-label="自进化技能">{data.skills.map(skill => <article key={skill.item.key}><div className="evolution-skill-title"><Icon name="skill" /><div><h2>{skill.item.name}</h2><p>{skill.item.description}</p></div></div><div className="evolution-skill-meta"><span>{skill.versions.length ? `版本 ${skill.versions.length} · 任务复盘` : '专属技能'} · {skill.item.configured ? '已配置' : '未配置'}</span><label><input type="checkbox" checked={skill.allowed} disabled={busy} onChange={event => { void run(() => api().allow(expert.id, skill.item.key, event.target.checked)); }} />允许自进化</label></div><div className="flex"><button className="btn" disabled={busy} onClick={() => { void run(async () => { const file = await window.soulDesktop.resources.readSkill(expert.id, skill.item.key); setPreview({ title: skill.item.name, content: file.content }); }); }}>查看 Skill</button><button className="btn" disabled={!skill.versions.length} onClick={() => setHistory({ title: skill.item.name, versions: skill.versions })}>来源与版本</button></div></article>)}</section>
      </>}
    </>}
  </div></main>
    {generate && data && <EvolutionGenerate {...{ expert, data, busy }} close={() => setGenerate(false)} generate={input => { void run(async () => { await api().generate({ ...input, expertId: expert.id, requestId: crypto.randomUUID() }); setGenerate(false); }); }} />}
    {allow && data && <Modal title="允许自进化" className="evolution-dialog" onClose={() => setAllow(undefined)} footer={<button className="btn" onClick={() => setAllow(undefined)}>完成</button>}><h2>允许自进化</h2><p>选择本专家的专属技能。草案仍需复核，工具权限沿用专家现有配置。</p><div className="evolution-allow-list">{allow.length ? allow.map(item => <label key={item.key}><input type="checkbox" checked={data.skills.some(skill => skill.item.key === item.key && skill.allowed)} disabled={busy} onChange={event => { void run(() => api().allow(expert.id, item.key, event.target.checked)); }} /><span><strong>{item.name}</strong><small>{item.description}</small></span></label>) : <p>暂无专属技能，可先到 Skill 页面上传。</p>}</div></Modal>}
    {draft && <Modal title="复核技能草案" className="evolution-dialog" onClose={() => setDraft(undefined)} footer={<><button className="btn danger" disabled={busy} onClick={() => resolve(false)}>放弃草案</button><button className="btn" onClick={() => setDraft(undefined)}>稍后复核</button><button className="btn primary" disabled={busy || !content.trim()} onClick={() => resolve(true)}>{busy ? '正在保存…' : '复核并保存'}</button></>}><h2>复核技能草案</h2><p>来源：{draft.taskTitle} · {draft.targetKey ? '更新已有技能' : '创建新技能'}</p><p className="evolution-source-note">{draft.note}</p><label>技能 Markdown<textarea aria-label="技能 Markdown" rows={18} value={content} onChange={event => setContent(event.target.value)} /></label>{draft.usage && <small>复盘用量：输入 {draft.usage.inputTokens} · 输出 {draft.usage.outputTokens} token</small>}{error && <p className="error" role="alert">{error}</p>}</Modal>}
    {preview && <Modal title={preview.title} className="evolution-dialog" onClose={() => setPreview(undefined)} footer={<button className="btn" onClick={() => setPreview(undefined)}>关闭</button>}><h2>{preview.title}</h2><pre className="evolution-source">{preview.content}</pre></Modal>}
    {history && <Modal title="来源与版本" className="evolution-dialog" onClose={() => setHistory(undefined)} footer={<button className="btn" onClick={() => setHistory(undefined)}>关闭</button>}><h2>{history.title} · 来源与版本</h2>{history.versions.map((item, index) => <details key={item.id}><summary>版本 {history.versions.length - index} · {new Date(item.updated).toLocaleString()} · {item.taskTitle}</summary><p>{item.note}</p><a href={`#task/${encodeURIComponent(item.taskId)}`}>查看来源任务</a><pre className="evolution-source">{item.content}</pre></details>)}</Modal>}
  </>;
}
function EvolutionGenerate({ expert, data, busy, close, generate }: { expert: ExpertDetail; data: EvolutionSnapshot; busy: boolean; close(): void; generate(input: { taskId: string; model: string; targetKey: string }): void }) {
  const [taskId, setTaskId] = useState(data.tasks[0]?.id ?? '');
  const [model, setModel] = useState('Auto');
  const [targetKey, setTargetKey] = useState('');
  return <Modal title="复盘成功任务" className="evolution-dialog" onClose={close} footer={<><button className="btn" onClick={close}>取消</button><button className="btn primary" disabled={busy || !taskId || !data.models.length} onClick={() => generate({ taskId, model, targetKey })}>生成草案</button></>}><h2>复盘成功任务</h2><p>从{expert.name}的已完成任务中归纳可复用的方法，使用已配置模型起草 Skill。</p><label>来源任务<select aria-label="来源任务" value={taskId} onChange={event => setTaskId(event.target.value)}>{data.tasks.map(task => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label><label>复盘模型<select aria-label="复盘模型" value={model} onChange={event => setModel(event.target.value)}><option value="Auto">Auto</option>{data.models.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label><label>目标 Skill<select aria-label="目标 Skill" value={targetKey} onChange={event => setTargetKey(event.target.value)}><option value="">创建新 Skill</option>{data.skills.filter(skill => skill.allowed).map(skill => <option key={skill.item.key} value={skill.item.key}>更新 {skill.item.name}</option>)}</select></label>{!data.models.length && <p role="alert">尚未配置模型，请先在对话输入器的模型设置中配置。</p>}</Modal>;
}
