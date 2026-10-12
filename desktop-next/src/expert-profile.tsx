import { useState } from 'react';
import type { ExpertDetail, ResourceFile } from '../shared/contracts';
import { Avatar, Icon, Modal } from './primitives';
import { RemoveDialog, type DialogActions } from './expert-dialogs';
import { ExpertSidebar } from './expert-sidebar';
import { TaskAnswer } from './tasks-page';

const sources = [
  ['soul.md', '身份、沟通风格、红线与工作流程的主要来源'],
  ['AGENTS.md', '操作规则、知识约束与完成标准的来源'],
  ['skills/skill-index.yaml', '专属、公共及社区技能的引用配置'],
];
export function ExpertSummaryDialog({ expert, saved, notice, onClose }: { expert: ExpertDetail; saved: DialogActions['saved']; notice: DialogActions['notice']; onClose(): void }) {
  const [name, setName] = useState(expert.name), [description, setDescription] = useState(expert.description), [image, setImage] = useState<string>();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const run = async (action: () => Promise<void>) => { if (busy) return; setBusy(true); setError(''); try { await action(); } catch (cause) { setError(String(cause)); } finally { setBusy(false); } };
  return <Modal title="编辑专家" className="compact-dialog expert-summary-dialog" onClose={() => { if (!busy) onClose(); }} footer={<><button className="btn" disabled={busy} onClick={onClose}>取消</button><button className="btn primary" disabled={busy || !name.trim()} onClick={() => run(async () => { const snapshot = await window.soulDesktop.resources.saveSettings(expert.id, name, description, expert.defaultModel, image); saved(snapshot); notice('专家资料已保存'); onClose(); })}>保存</button></>}>
    <div className="dialog-header"><h2>编辑专家</h2></div><div className="dialog-body">
      <div className="field"><label htmlFor="expert-summary-name">专家名称<span className="required">*</span></label><input id="expert-summary-name" maxLength={24} value={name} onChange={event => setName(event.target.value)} /></div>
      <div className="field"><label>头像</label><div className="avatar-upload"><Avatar name={name} avatar={image ?? expert.avatar} /><div><button className="btn" disabled={busy} onClick={() => run(async () => { const value = await window.soulDesktop.chooseAvatar(); if (value) setImage(value); })}>上传头像</button><p className="tiny">支持 PNG / JPG，文件大小不超过 2 MB</p></div></div></div>
      <div className="field"><label htmlFor="expert-summary-description">简介</label><textarea id="expert-summary-description" maxLength={2000} value={description} onChange={event => setDescription(event.target.value)} /></div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  </Modal>;
}

export function ExpertProfile({ expert, back, ...actions }: DialogActions & { expert: ExpertDetail; back(): void }) {
  const { saved, notice } = actions;
  const [summary, setSummary] = useState(false), [remove, setRemove] = useState(false);
  const [source, setSource] = useState<{ file: string; description: string; data: ResourceFile }>();
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const run = async (action: () => Promise<void>) => { if (busy) return; setBusy(true); setError(''); try { await action(); } catch (cause) { setError(String(cause)); } finally { setBusy(false); } };
  return <><ExpertSidebar id={expert.id} page="settings" {...{ expert, notice }} /><main className="resource-main" data-ued-node="expert.profile"><div className="resource-page expert-profile-page">
    <header className="resource-header"><div><h1>专家档案</h1><p>查看并管理此专家的资料。</p></div></header>
    <section className="expert-profile-summary" aria-label="角色摘要"><div><div className="flex"><Avatar name={expert.name} avatar={expert.avatar} /><strong>{expert.name}</strong></div><div className="expert-profile-description"><span className="muted">个人简介</span><p>{expert.description || '暂无简介'}</p></div></div><button className="btn" disabled={!expert.installed} onClick={() => setSummary(true)}>修改</button></section>
    <section className="expert-profile-section" aria-label="角色源文件"><h2>角色源文件</h2><div className="expert-profile-list">{sources.map(([file, description]) => <div className="expert-profile-row" key={file}><div><h3>{file}</h3><p>{description}</p></div><button className="btn" disabled={busy} aria-label={`查看 ${file}`} onClick={() => run(async () => { setEditing(false); setSource({ file, description, data: await window.soulDesktop.resources.readProfileFile(expert.id, file) }); })}>查看</button></div>)}</div></section>
    <section className="expert-profile-section" aria-label="角色管理"><h2>角色管理</h2><div className="expert-profile-list"><div className="expert-profile-row"><h3>移除专家</h3><button className="btn expert-profile-danger" onClick={() => setRemove(true)}>移除</button></div></div></section>
    {error && !source && <p className="form-error" role="alert">{error}</p>}
    {!expert.installed && <p className="resource-note">专家包源文件只读。安装实例后可保存独立资料。</p>}
  </div></main>
  {summary && <ExpertSummaryDialog {...{ expert, saved, notice }} onClose={() => setSummary(false)} />}
  {source && <Modal title={source.file} className="expert-source-dialog" onClose={() => { if (!busy) { setSource(undefined); setError(''); } }} footer={editing ? <><button className="btn" disabled={busy} onClick={() => { setEditing(false); setError(''); }}>取消</button><button className="btn primary" disabled={busy} onClick={() => run(async () => { await window.soulDesktop.resources.saveProfileFile(expert.id, source.file, draft, source.data.revision); const data = await window.soulDesktop.resources.readProfileFile(expert.id, source.file); setSource({ ...source, data }); setEditing(false); notice('角色源文件已保存'); })}>保存</button></> : <button className="btn" disabled={!expert.installed} onClick={() => { setDraft(source.data.content); setEditing(true); }}>编辑</button>}>
    <div className="dialog-header"><h2>{source.file}</h2><p>{source.description}</p></div><div className="dialog-body">{editing ? <textarea aria-label={`编辑 ${source.file}`} className="expert-source-editor" spellCheck={false} value={draft} onChange={event => setDraft(event.target.value)} /> : source.file.endsWith('.md') ? <TaskAnswer text={source.data.content} /> : <pre className="expert-source-code">{source.data.content}</pre>}<p className="tiny">来源：{source.data.source}</p>{error && <p className="form-error" role="alert">{error}</p>}</div>
  </Modal>}
  {remove && <RemoveDialog name={expert.name} onClose={() => setRemove(false)} remove={async () => { saved(await window.soulDesktop.removeExpert(expert.id)); back(); notice('已移除，专家资料仍然保留'); }} />}
  </>;
}
