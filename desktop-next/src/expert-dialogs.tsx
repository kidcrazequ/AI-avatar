import { useState } from 'react';
import type { ArchiveFile, ExpertGroup, ExpertRecord, GroupMember, ImportPreview, LibrarySnapshot, RoleInput } from '../shared/contracts';
import { Avatar, Icon, Modal } from './primitives';

export interface DialogActions {
  library: LibrarySnapshot;
  saved(library: LibrarySnapshot): void;
  notice(message: string): void;
  archive(id: string, file: string): void;
}
function useSave() {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async (action: () => Promise<void>) => {
    if (busy) return;
    setError(''); setBusy(true);
    try { await action(); } catch (cause) { setError(String(cause).replace(/^Error:.*?: /, '')); }
    finally { setBusy(false); }
  };
  return { error, busy, save };
}

export function CreateDialog({ library, saved, notice, archive, onClose }: DialogActions & { onClose(): void }) {
  const [templateId, setTemplate] = useState(library.templates.find(item => item.installable)?.id ?? '');
  const selected = library.templates.find(item => item.id === templateId);
  const [name, setName] = useState('');
  const [description, setDescription] = useState(selected?.description ?? '');
  const [image, setImage] = useState<string | null>(null);
  const [child, setChild] = useState<'role' | 'import' | null>(null);
  const { error, busy, save } = useSave();
  return <>
    <Modal title="新建专家" className="create-dialog" onClose={onClose} footer={<>
      <button className="btn primary" disabled={busy || !selected?.installable} onClick={() => save(async () => {
        const snapshot = await window.soulDesktop.createExpert({ templateId, name, description, avatar: image });
        saved(snapshot); notice('专家已创建，完整资料已保存'); onClose();
      })}>{busy ? '正在创建…' : '创建专家'}</button><button className="btn" disabled={busy} onClick={onClose}>取消</button>
      <span className="spacer" /><button className="btn text" disabled={busy} onClick={() => setChild('import')}><Icon name="upload" small />导入专家包</button>
    </>}>
      <div className="dialog-body"><h2>新建专家</h2><div className="choose-heading"><span>选择一个角色</span><button onClick={() => setChild('role')}>自定义角色 &gt;</button></div>
        <div className="templates" data-ued-node="management.create.templates">{library.templates.map(expert => <div key={expert.id} className={`template ${templateId === expert.id ? 'selected' : ''}`}>
          <button className="template-select" aria-label={`选择${expert.name}角色`} aria-pressed={templateId === expert.id} onClick={() => { setTemplate(expert.id); setDescription(expert.description); setImage(null); }}><Avatar name={expert.name} avatar={expert.avatar} /></button>
          <div className="template-info"><div className="template-title"><button className="template-name" onClick={() => { setTemplate(expert.id); setDescription(expert.description); setImage(null); }}><strong>{expert.name}</strong></button><button onClick={() => archive(expert.id, 'soul.md')}>查看详情</button></div><p title={expert.description}>{expert.draft ? '角色草案 · 待审核 · ' : ''}{expert.description}</p></div>
        </div>)}</div>
        <div className="field"><label htmlFor="create-name">名称<span className="required">*</span></label><input id="create-name" placeholder="请输入专家名称" maxLength={24} autoComplete="off" value={name} onChange={event => setName(event.target.value)} /></div>
        <div className="field"><label>头像<span className="required">*</span></label><div className="avatar-upload"><Avatar name={name || selected?.name || '专家'} avatar={image ?? selected?.avatar ?? ''} /><div><button className="btn" onClick={() => save(async () => { const avatar = await window.soulDesktop.chooseAvatar(); if (avatar) setImage(avatar); })}>上传头像</button><p className="tiny" style={{ marginTop: 8 }}>支持 PNG / JPG，文件大小不超过 2 MB</p></div></div></div>
        <div className="field"><label htmlFor="create-description">简介</label><textarea id="create-description" rows={5} maxLength={2000} placeholder="描述专家擅长什么，以及应该如何与你协作。" value={description} onChange={event => setDescription(event.target.value)} /></div>
        {!selected?.installable && <p className="form-error">角色草案需完善知识、示例与测试后才能安装。</p>}<p className="form-error" role="alert">{error}</p>
      </div>
    </Modal>
    {child === 'role' && <RoleDialog {...{ library, notice, archive }} saved={snapshot => {
      const role = snapshot.templates.find(item => !library.templates.some(previous => previous.id === item.id));
      saved(snapshot);
      if (role) { setTemplate(role.id); setDescription(role.description); setImage(null); }
    }} onClose={() => setChild(null)} />}
    {child === 'import' && <ImportDialog {...{ library, saved, notice, archive }} onClose={() => setChild(null)} />}
  </>;
}

export function RoleDialog({ saved, notice, onClose }: DialogActions & { onClose(): void }) {
  const [input, setInput] = useState<RoleInput>({ name: '', description: '', identity: '', style: '', workflow: '', avatar: null });
  const [mode, setMode] = useState('upload');
  const { error, busy, save } = useSave();
  const update = (key: keyof RoleInput, value: string) => setInput({ ...input, [key]: value });
  return <Modal title="创建角色模板" className="custom-dialog" onClose={onClose} footer={<><button className="btn primary" disabled={busy} onClick={() => save(async () => { saved(await window.soulDesktop.createRole(input)); notice('角色草案已保存，待完善资料与审核'); onClose(); })}>{busy ? '正在保存…' : '创建模板'}</button><button className="btn" disabled={busy} onClick={onClose}>取消</button></>}>
    <div className="dialog-header"><h2>创建角色模板</h2></div><p className="custom-subtitle">现有 Soul 专家不能满足需求时，可以定义自己的角色。</p>
    <div className="dialog-body"><div className="custom-row">
      <div className="field"><label htmlFor="role-name">模板名称<span className="required">*</span></label><input id="role-name" value={input.name} maxLength={24} onChange={event => update('name', event.target.value)} placeholder="例如：数据分析师、储能运维专家" /></div>
      <div className="field"><label>头像</label><div className="avatar-upload"><Avatar name={input.name || '专家'} avatar={input.avatar ?? ''} /><button className="btn" onClick={() => save(async () => { const image = await window.soulDesktop.chooseAvatar(); if (image) update('avatar', image); })}>上传头像</button></div></div>
    </div><div className="field"><label htmlFor="role-description">一句话模板定位<span className="required">*</span></label><textarea id="role-description" value={input.description} maxLength={2000} onChange={event => update('description', event.target.value)} placeholder="出现在角色卡片上，说明服务谁、解决什么类型的问题。" /></div>
      <div className="custom-mode" role="tablist" aria-label="角色填写方式">{[['upload', '上传 Markdown'], ['manual', '手动填写']].map(([value, label]) => <button role="tab" aria-selected={mode === value} className={mode === value ? 'active' : ''} key={value} onClick={() => setMode(value)}>{label}</button>)}</div>
      <button className="section-link" onClick={() => save(async () => { if (await window.soulDesktop.saveRoleTemplate()) notice('Soul 空白人格模板已保存'); })}><Icon name="download" small />下载空白角色草案</button>
      {([['identity', '核心职责', 'Identity'], ['style', '工作风格', 'Style'], ['workflow', '工作流程', 'Workflow']] as const).map(([key, label, english]) => <div className="upload-panel" key={key}><h3>{label}<span className="tiny">{english}</span></h3>{mode === 'manual' ? <textarea aria-label={label} value={input[key]} maxLength={8000} onChange={event => update(key, event.target.value)} placeholder={`填写${label}`} /> : <><button className="btn" disabled={busy} onClick={() => save(async () => { const text = await window.soulDesktop.chooseRoleText(); if (text !== null) update(key, text); })}><Icon name="upload" small />{input[key] ? '已载入 · 替换文件' : `上传 ${key}.md`}</button>{input[key] && <p className="tiny" style={{ marginTop: 8 }}>{input[key].slice(0, 100)}</p>}</>}</div>)}
      <p className="tiny" style={{ marginTop: 16 }}>按 Soul 人格模板补全红线、来源与回答示例后，再审核安装。</p><p className="form-error" role="alert">{error}</p>
    </div>
  </Modal>;
}

export function ImportDialog({ saved, notice, onClose }: DialogActions & { onClose(): void }) {
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const { error, busy, save } = useSave();
  const close = () => { if (preview) void window.soulDesktop.discardImport(preview.token).catch(notice); onClose(); };
  return <Modal title="导入专家包" className="compact-dialog" onClose={close} footer={<><button className="btn primary" disabled={busy || !preview} onClick={() => save(async () => { saved(await window.soulDesktop.importExpert(preview!.token)); notice('完整专家包已导入，可安装后使用'); onClose(); })}>确认导入</button><button className="btn" disabled={busy} onClick={close}>取消</button></>}>
    <div className="dialog-body"><h2>导入专家包</h2><p className="muted" style={{ marginTop: 12 }}>选择包含 expert-pack.json 和完整人格、知识、技能资料的专家包目录。</p>
      <div className="import-drop"><Icon name="upload" /><button className="btn" disabled={busy} onClick={() => save(async () => { const next = await window.soulDesktop.chooseExpertImport(); if (next) { if (preview) await window.soulDesktop.discardImport(preview.token); setPreview(next); } })}>选择专家包目录</button><span className="tiny">支持完整目录，导入前检查内容并预览</span></div>
      {preview && <div className="import-result"><strong>{preview.expert.name}</strong><p>{preview.expert.description}</p><p className="tiny">版本 {preview.expert.version} · {preview.files} 个文件 · {(preview.bytes / 1024).toFixed(1)} KB</p><p className="tiny">资料来源：{preview.expert.sourceLabel}</p></div>}<p className="form-error" role="alert">{error}</p>
    </div>
  </Modal>;
}

export function GroupDialog({ library, saved, notice, group, onClose }: DialogActions & { group?: ExpertGroup; onClose(): void }) {
  const [draft, setDraft] = useState<ExpertGroup>(() => group ? structuredClone(group) : { id: '', name: '新的群组', leader: '', members: [] });
  const [focus, setFocus] = useState(group?.members[0]?.expertId ?? '');
  const [search, setSearch] = useState('');
  const { error, busy, save } = useSave();
  const member = draft.members.find(item => item.expertId === focus);
  const expert = library.experts.find(item => item.id === focus);
  const configure = (change: Partial<GroupMember>) => setDraft(current => ({ ...current, members: current.members.map(item => item.expertId === focus ? { ...item, ...change } : item) }));
  const toggle = (item: ExpertRecord) => {
    const existing = draft.members.some(member => member.expertId === item.id);
    const members = existing ? draft.members.filter(member => member.expertId !== item.id) : [...draft.members, { expertId: item.id, model: item.defaultModel, directory: '' }];
    setDraft({ ...draft, members, leader: members.some(member => member.expertId === draft.leader) ? draft.leader : members[0]?.expertId ?? '' });
    setFocus(existing ? members[0]?.expertId ?? '' : item.id);
  };
  return <Modal title={group ? '编辑群组' : '创建群组'} className="group-dialog" onClose={onClose} footer={<><span className="muted">已选择 {draft.members.length} 位专家</span><span className="spacer" /><button className="btn" disabled={busy} onClick={onClose}>取消</button><button className="btn primary" disabled={busy || !draft.members.length} onClick={() => save(async () => { saved(await window.soulDesktop.saveGroup(draft)); notice('群组配置已保存'); onClose(); })}>{busy ? '正在保存…' : group ? '保存' : '创建'}</button></>}>
    <div className="dialog-header"><h2>{group ? '编辑群组' : '创建群组'}</h2></div><div className="group-body">
      <div className="group-name"><label htmlFor="group-name">群聊标题</label><input id="group-name" value={draft.name} maxLength={40} onChange={event => setDraft({ ...draft, name: event.target.value })} /></div>
      <div className="group-columns"><aside className="member-list"><h3>专家成员</h3><label className="search"><Icon name="search" small /><input value={search} onChange={event => setSearch(event.target.value)} aria-label="搜索群组成员" placeholder="搜索专家" /></label><p className="tiny">选择已安装专家，并指定一位 Leader。</p>
        <div className="members-scroll">{library.experts.filter(item => `${item.name} ${item.role}`.includes(search)).map(item => {
          const selected = draft.members.some(member => member.expertId === item.id);
          return <div key={item.id} className={`member ${selected ? 'selected' : ''}`}><input type="checkbox" aria-label={`加入${item.name}`} disabled={!item.installed || item.draft} checked={selected} onChange={() => toggle(item)} /><Avatar name={item.name} avatar={item.avatar} /><button className="member-name" onClick={() => selected ? setFocus(item.id) : toggle(item)} disabled={!item.installed || item.draft}><strong>{item.name}</strong><p>{item.installed ? item.role : '请先安装专家'}</p></button>{selected && <button className="leader-button" aria-pressed={draft.leader === item.id} onClick={() => setDraft({ ...draft, leader: item.id })}>{draft.leader === item.id ? 'Leader' : '设为 Leader'}</button>}</div>;
        })}</div></aside>
        <div className="member-config">{member && expert ? <><div className="config-identity"><Avatar name={expert.name} avatar={expert.avatar} /><div><strong>{expert.name}</strong><p className="tiny">{expert.role}</p></div></div><div className="config-panel"><label htmlFor="member-model">模型</label><p className="tiny">保存该成员的模型偏好。</p><input id="member-model" value={member.model} maxLength={120} onChange={event => configure({ model: event.target.value })} /></div><div className="config-panel"><label htmlFor="member-directory">工作目录</label><p className="tiny">可选；选择本机已存在的目录。</p><input id="member-directory" value={member.directory} maxLength={1000} onChange={event => configure({ directory: event.target.value })} /><button className="btn text" onClick={() => save(async () => { const directory = await window.soulDesktop.chooseDirectory(); if (directory) configure({ directory }); })}><Icon name="folder" small />选择目录</button></div></> : <div className="member-empty">选择专家成员后，配置模型与工作目录。</div>}<p className="form-error" role="alert">{error}</p></div>
      </div></div>
  </Modal>;
}

export function RenameDialog({ expert, saved, notice, onClose }: DialogActions & { expert: ExpertRecord; onClose(): void }) {
  const [name, setName] = useState(expert.name);
  const { error, busy, save } = useSave();
  return <Modal title="编辑专家名称" className="compact-dialog" onClose={onClose} footer={<><button className="btn primary" disabled={busy} onClick={() => save(async () => { saved(await window.soulDesktop.renameExpert(expert.id, name)); notice('专家名称已保存'); onClose(); })}>保存</button><button className="btn" disabled={busy} onClick={onClose}>取消</button></>}><div className="dialog-body"><h2>编辑专家名称</h2><div className="field"><label htmlFor="rename-name">名称</label><input id="rename-name" value={name} maxLength={24} onChange={event => setName(event.target.value)} /></div>{!expert.installed && <p className="tiny">保存名称时将安装这位专家的完整资料。</p>}<p className="form-error" role="alert">{error}</p></div></Modal>;
}

export function RemoveDialog({ name, remove, onClose }: { name: string; remove(): Promise<void>; onClose(): void }) {
  const { error, busy, save } = useSave();
  return <Modal title="移除" className="compact-dialog" onClose={onClose} footer={<><button className="btn primary" disabled={busy} onClick={() => save(async () => { await remove(); onClose(); })}>移除</button><button className="btn" disabled={busy} onClick={onClose}>取消</button></>}><div className="dialog-body"><h2>移除{name}？</h2><p>资料和配置会保留，可在管理页恢复已移除内容。</p><p className="form-error" role="alert">{error}</p></div></Modal>;
}

export function ArchiveDialog({ file, onClose }: { file: ArchiveFile; onClose(): void }) {
  return <Modal title={file.path} className="detail-dialog" onClose={onClose} footer={<button className="btn" onClick={onClose}>关闭</button>}><div className="dialog-body"><h2>{file.path}</h2><p className="tiny" style={{ margin: '8px 0 16px' }}>来源：{file.source}</p><pre className="file-preview">{file.content || '（文件为空）'}</pre></div></Modal>;
}
