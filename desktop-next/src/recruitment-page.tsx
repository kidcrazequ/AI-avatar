import { useEffect, useState } from 'react';
import type { ExpertDetail, ExpertRecord } from '../shared/contracts';
import { Avatar, Icon, Modal } from './primitives';
import { CreateDialog, ImportDialog, RoleDialog, type DialogActions } from './expert-dialogs';
import './recruitment.css';
import { PersonalConsent } from './recording-page';
import { generalRoleIcons } from './general-role-icons';
import { PersonalParticleOrb } from './personal-particle-orb';

const coverIcons: Record<string, string> = { '小堵-工商储专家': 'gauge', 'design-master': 'layers', 'finance-expert': 'project', 'electrical-engineer-expert': 'connector', 'product-manager-expert': 'board', 'hr-expert': 'users', 'legal-expert': 'shield', 'market-analyst-expert': 'gauge', 'project-manager-expert': 'flow', 'orchestrator': 'bot' };

export function RecruitmentPage(actions: DialogActions) {
  const { library, saved, notice } = actions;
  const [details, setDetails] = useState<Record<string, ExpertDetail>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState('');
  const [create, setCreate] = useState('');
  const [modal, setModal] = useState<'role' | 'import' | 'personal' | null>(null);
  const [installing, setInstalling] = useState(false);
  const [editingRole, setEditingRole] = useState('');
  const expert = library.templates.find(item => item.id === selected);
  useEffect(() => {
    let active = true;
    // Yield between IPC reads so the native window can paint the catalog.
    void (async () => {
      for (const item of library.templates) {
        if (!active) break;
        try {
          const detail = await window.soulDesktop.readExpert(item.id);
          if (active) setDetails(previous => ({ ...previous, [item.id]: detail }));
        } catch (error) {
          if (active) setErrors(previous => ({ ...previous, [item.id]: String(error) }));
        }
      }
    })();
    return () => { active = false; };
  }, [library.templates]);
  const retry = async (id: string) => {
    setErrors(previous => ({ ...previous, [id]: '' }));
    try { const detail = await window.soulDesktop.readExpert(id); setDetails(previous => ({ ...previous, [id]: detail })); }
    catch (error) { setErrors(previous => ({ ...previous, [id]: String(error) })); }
  };
  const choose = (item: ExpertRecord) => { setSelected(''); setCreate(item.id); };
  return <main className="recruitment-page" data-ued-node="recruitment.page">
    <nav className="recruitment-breadcrumb" aria-label="创建专家导航"><a href="#expert-management">专家管理</a><Icon name="chevron" small /><span>创建专家</span></nav>
    <div className="recruitment-content">
      <header className="recruitment-header"><div><h1>创建专家</h1><p>选择适合工作场景的预置专家，直接使用或按需调整；若没有合适的角色，可以创建自定义专家。</p></div><button className="btn primary" onClick={() => setModal('role')}><Icon name="plus" small />自定义专家</button></header>
      <div className="recruitment-grid" role="list" aria-label="预置专家角色" data-ued-node="recruitment.roles">
        <div role="listitem"><button className="personal-avatar-card" onClick={() => setModal('personal')} data-ued-node="recruitment.personal-avatar"><span className="beta-tag">Beta</span><PersonalParticleOrb /><span className="personal-avatar-copy"><strong>创建个人分身<Icon name="chevron" small /></strong><span>学习你的工作信息与表达方式，生成你的记忆和专家档案。</span></span></button></div>
        {library.templates.filter(item => item.source !== 'bundled' || item.id === '小堵-工商储专家' || Object.hasOwn(generalRoleIcons, item.id)).map(item => <article key={item.id} role="listitem" className="recruitment-card" data-template-id={item.id}>
          <div className="recruitment-cover"><span className="recruitment-cover-icon" aria-hidden="true">{generalRoleIcons[item.id] ? <span dangerouslySetInnerHTML={{ __html: generalRoleIcons[item.id] }} /> : <Icon name={coverIcons[item.id] ?? 'bot'} />}</span><Avatar name={item.name} avatar={item.avatar} /></div>
          <button className="recruitment-card-body" aria-label={`查看 ${item.role || item.name} 的详情`} onClick={() => setSelected(item.id)}>
            <span className="recruitment-card-title">{item.role || item.name}{item.draft && <small>角色草案</small>}</span><span className="recruitment-card-description" title={item.description}>{item.description}</span>
            <span className="recruitment-tags">{details[item.id]?.skills.filter(skill => skill.available).slice(0, 3).map(skill => <span key={`${skill.source}/${skill.id}`} title={skill.name}>{skill.domain || skill.name}</span>)}</span>
          </button>
          <div className="recruitment-card-actions"><button className="btn text" onClick={() => setSelected(item.id)}>查看详情</button><button className="btn primary" disabled={!item.installable} onClick={() => choose(item)}>{item.draft ? '待完善' : '创建'}</button></div>
        </article>)}
      </div>
      <button className="btn text recruitment-import" onClick={() => setModal('import')}><Icon name="upload" small />导入专家包</button>
    </div>
    {expert && <Modal title="专家角色详情" className="role-detail-drawer" onClose={() => { if (!installing) setSelected(''); }}>
      <header className="role-detail-header"><Avatar name={expert.name} avatar={expert.avatar} /><div><h2>{expert.role || expert.name}</h2><p>{expert.description}</p></div><div className="role-detail-header-actions"><button className="btn" disabled={installing} onClick={() => setSelected('')}>返回列表</button><button className="btn primary" disabled={!expert.installable || installing} onClick={() => choose(expert)}>就他了！</button></div></header>
      <div className="role-detail-body" data-ued-node="recruitment.role-detail">
        {errors[expert.id] ? <div className="empty"><p role="alert">{errors[expert.id]}</p><button className="btn" onClick={() => void retry(expert.id)}>重新读取</button></div> : !details[expert.id] ? <p role="status">正在读取角色资料…</p> : <>
          {details[expert.id].about.map((section, index) => <section className="role-detail-section" key={section.title}><h3>{index === 0 ? `核心能力（${section.items.length}）` : section.title}</h3><div className={section.title === '工作风格' ? 'role-workstyles' : section.title === '工作模式' ? 'role-workflows' : 'role-capabilities'}>{section.items.map((item, itemIndex) => <div key={itemIndex} className="role-detail-item"><strong>{item.title}</strong>{item.text !== item.title && <p>{item.text}</p>}</div>)}</div></section>)}
          <section className="role-detail-section"><h3>技能（{details[expert.id].skills.length}）</h3><ul className="role-skills">{details[expert.id].skills.map(skill => <li key={`${skill.source}/${skill.id}`}><Icon name="bulb" small /><span>{skill.name}</span>{!skill.available && <small>资料缺失</small>}</li>)}</ul></section>
          {expert.source === 'custom' && <button className="btn" onClick={() => { setEditingRole(expert.id); setSelected(''); setModal('role'); }}>编辑角色模板</button>}
          {expert.source === 'imported' && !library.experts.some(item => item.id === expert.id && item.installed) && expert.installable && <button className="btn" disabled={installing} onClick={async () => { setInstalling(true); try { saved(await window.soulDesktop.installExpert(expert.id)); notice('专家包已安装'); setSelected(''); location.hash = 'expert-management'; } catch (error) { notice(String(error)); } finally { setInstalling(false); } }}>{installing ? '正在安装…' : '安装此专家包'}</button>}
        </>}
      </div>
    </Modal>}
    {create && <CreateDialog {...actions} initialTemplateId={create} saved={snapshot => { saved(snapshot); location.hash = 'expert-management'; }} onClose={() => setCreate('')} />}
    {modal === 'role' && <RoleDialog {...actions} roleId={editingRole || undefined} saved={snapshot => { saved(snapshot); const role = snapshot.templates.find(item => !library.templates.some(previous => previous.id === item.id)); setSelected(role?.id ?? editingRole); }} onClose={() => { setModal(null); setEditingRole(''); }} />}
    {modal === 'import' && <ImportDialog {...actions} saved={snapshot => { saved(snapshot); const imported = snapshot.templates.find(item => !library.templates.some(previous => previous.id === item.id)); if (imported) setSelected(imported.id); }} onClose={() => setModal(null)} />}
    {modal === 'personal' && <PersonalConsent close={() => setModal(null)} />}
  </main>;
}
