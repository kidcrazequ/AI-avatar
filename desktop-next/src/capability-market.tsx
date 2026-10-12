import { useCallback, useEffect, useState } from 'react';
import type { CapabilityDetail, CapabilityItem, CapabilitySnapshot, LibrarySnapshot } from '../shared/contracts';
import { Avatar, Icon, Modal } from './primitives';
import './resource-hub.css';

const pluginCategories = ['全部分类', '电商零售', '金融财务', '代码开发', '安全与测试', '数据库与分析', '运维部署', '开发者工具', '设计', '产品管理', '知识研究', '工作流', 'Agent 自进化'];
const skillCategories = ['全部分类', 'DevOps 与部署', '效率工具', '研究与分析', '内容创作', '设计与 UI', '数据与 AI', '文档与写作'];
const api = () => window.soulDesktop.resources;
export function CapabilityMarket({ kind, library, notice, scope = '' }: { kind: 'plugin' | 'skill'; library: LibrarySnapshot; notice(text: string): void; scope?: string }) {
  const [data, setData] = useState<CapabilitySnapshot>(), [error, setError] = useState(''), [tab, setTab] = useState(scope ? 'mine' : 'market');
  const [query, setQuery] = useState(''), [category, setCategory] = useState('全部分类'), [origin, setOrigin] = useState('all'), [page, setPage] = useState(1);
  const [detail, setDetail] = useState<CapabilityDetail>(), [importing, setImporting] = useState(false);
  const [loading, setLoading] = useState(false);
  const refresh = useCallback(async () => { try { setData(await api().capabilities('')); setError(''); } catch (cause) { setError(String(cause)); } }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const label = kind === 'plugin' ? '插件' : 'Skill';
  const all = data?.items.filter(item => item.kind === kind) ?? [];
  const installed = all.filter(item => item.installed && (!scope || item.expertIds.includes(scope)));
  const base = tab === 'mine' ? installed : all;
  const filtered = base.filter(item => (category === '全部分类' || tab === 'mine' || item.category === category) && (origin === 'all' || item.origin === origin) && `${item.name} ${item.description} ${item.skills.map(skill => skill.name).join(' ')}`.toLowerCase().includes(query.trim().toLowerCase()));
  const count = Math.max(1, Math.ceil(filtered.length / (kind === 'plugin' ? 20 : 16))), current = Math.min(page, count);
  const categories = [...new Set([...(kind === 'plugin' ? pluginCategories : skillCategories), ...all.map(item => item.category)])].filter(value => value === '全部分类' || all.some(item => item.category === value));
  const open = async (item: CapabilityItem) => { if (loading) return; setLoading(true); try { setDetail(await api().capability(item.key)); setError(''); } catch (cause) { setError(String(cause)); } finally { setLoading(false); } };
  const changeTab = (value: string) => { setTab(value); setQuery(''); setOrigin('all'); setPage(1); };
  return <section className="capability-market" data-ued-node={`resource.${kind}-market`} data-capability-ready={Boolean(data)}>
    <div className="hub-secondary-tabs" role="tablist" aria-label={`${label}视图`}>{[['market', kind === 'plugin' ? '插件市场' : '技能市场'], ['mine', kind === 'plugin' ? '我的插件' : '我的技能']].map(([value, title]) => <button role="tab" key={value} aria-selected={tab === value} className={tab === value ? 'active' : ''} onClick={() => changeTab(value)}>{title}{value === 'mine' && <span>{installed.length}</span>}</button>)}</div>
    {error && <p className="form-error" role="alert">{error}<button className="btn text" onClick={() => void refresh()}>重试</button></p>}
    {data?.errors.map(error => <p className="form-error" role="alert" key={error}>{error}</p>)}
    {!data && !error && <p>正在读取真实资源…</p>}
    <div className={`hub-market-layout ${tab === 'mine' ? 'hub-mine' : ''}`}>
      <aside className="hub-market-filter" aria-label={`${label}筛选`}><div className="hub-search"><Icon name="search" small /><input aria-label={`搜索${label}`} placeholder={`搜索${label}...`} value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} /></div>{tab === 'market' && <div role="listbox" aria-label="分类">{categories.map(value => <button role="option" aria-selected={category === value} key={value} className={category === value ? 'active' : ''} onClick={() => { setCategory(value); setPage(1); }}><span>{value}</span><span>{value === '全部分类' ? all.length : all.filter(item => item.category === value).length}</span></button>)}</div>}</aside>
      {tab === 'mine' && <div className="hub-mine-actions"><label>来源<select aria-label="来源" value={origin} onChange={event => { setOrigin(event.target.value); setPage(1); }}><option value="all">全部</option><option value="bundled">Soul 公共资源</option><option value="uploaded">本地导入</option></select></label><button className="btn" onClick={() => setImporting(true)}><Icon name="plus" small />{kind === 'plugin' ? '添加插件' : '上传 Skill'}</button></div>}
      <div className="hub-market-results" role="region" aria-label={tab === 'mine' ? `我的${label}` : `${label}市场`}>
        {tab === 'market' && <div className="hub-market-summary"><strong>{category}</strong><span role="status">{filtered.length} 个{label}</span></div>}
        {filtered.length ? <div className="hub-capability-grid">{filtered.slice((current - 1) * (kind === 'plugin' ? 20 : 16), current * (kind === 'plugin' ? 20 : 16)).map(item => <button className="hub-capability-card" key={item.key} disabled={loading} aria-label={`查看 ${item.name} 详情`} onClick={() => void open(item)}><div className="hub-card-title"><span className="hub-card-icon"><Icon name={kind === 'plugin' ? 'sparkles' : 'skill'} small /></span><strong>{item.name}</strong></div><p>{item.description}</p><div className="hub-card-meta"><span>@{item.author}</span><span>{item.installed ? item.enabled ? '已启用' : '已停用' : `${item.skills.length} 个技能`}</span></div>{tab === 'mine' && <span className="hub-card-association">{item.expertIds.length} 位专家关联</span>}</button>)}</div> : data && <div className="hub-empty"><Icon name={kind === 'plugin' ? 'sparkles' : 'skill'} /><p>{query ? '没有匹配结果' : tab === 'mine' ? `还没有安装或上传${label}` : `当前没有可用${label}`}</p>{tab === 'market' && <button className="btn" onClick={() => setImporting(true)}>导入{label}</button>}</div>}
        {count > 1 && <nav className="hub-pagination" aria-label={`${label}市场分页`}><button disabled={current === 1} onClick={() => setPage(current - 1)}>上一页</button>{Array.from({ length: count }, (_, index) => index + 1).map(value => <button className={current === value ? 'active' : ''} aria-current={current === value ? 'page' : undefined} key={value} onClick={() => setPage(value)}>{value}</button>)}<button disabled={current === count} onClick={() => setPage(current + 1)}>下一页</button></nav>}
      </div>
    </div>
    {detail && <CapabilityDialog key={detail.item.key} {...{ detail, library, scope }} onClose={() => setDetail(undefined)} saved={() => { void refresh(); setDetail(undefined); notice('资源配置已保存'); }} />}
    {importing && <ImportCapability kind={kind} onClose={() => setImporting(false)} saved={async key => { await refresh(); setImporting(false); setTab('market'); setCategory('全部分类'); setDetail(await api().capability(key)); }} />}
  </section>;
}
function CapabilityDialog({ detail, library, scope, onClose, saved }: { detail: CapabilityDetail; library: LibrarySnapshot; scope: string; onClose(): void; saved(): void }) {
  const item = detail.item;
  const [expertIds, setExpertIds] = useState(item.expertIds.length ? item.expertIds : scope ? [scope] : []), [enabled, setEnabled] = useState(item.installed ? item.enabled : true);
  const [associating, setAssociating] = useState(!item.installed), [expanded, setExpanded] = useState(false), [preview, setPreview] = useState(-1), [query, setQuery] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [removing, setRemoving] = useState(false);
  const save = async (remove = false) => { if (busy) return; setBusy(true); setError(''); try { await api().configureCapability(item.key, item.revision, remove ? { installed: false, enabled: false, expertIds: [] } : { installed: true, enabled, expertIds }); saved(); } catch (cause) { setError(String(cause)); } finally { setBusy(false); } };
  const toggle = (id: string) => setExpertIds(previous => previous.includes(id) ? previous.filter(value => value !== id) : [...previous, id]);
  return <Modal title={item.name} className="hub-capability-dialog" onClose={onClose} footer={<><button className="btn" disabled={busy} onClick={onClose}>关闭</button>{item.installed && <button className="btn" disabled={busy} onClick={() => setRemoving(!removing)}>卸载</button>}<span className="spacer" /><button className="btn primary" disabled={busy} onClick={() => void save()}>{busy ? '保存中…' : item.installed ? '保存配置' : '安装'}</button></>}>
    <header className="hub-detail-heading"><h2>{item.name}</h2><p>查看{item.kind === 'plugin' ? '插件' : 'Skill'}信息、组成和使用说明</p><div><span>v{item.version}</span><span>@{item.author}</span><span>{item.category}</span><span>{item.origin === 'bundled' ? 'Soul 公共资源' : '本地导入'}</span></div></header>
    <div className="hub-detail-body"><p>{item.description}</p><div className="hub-detail-controls"><label><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />启用</label><button className="btn text" aria-expanded={associating} onClick={() => setAssociating(!associating)}>关联专家（{expertIds.length}）</button></div>
      {associating && <section className="hub-expert-association" aria-label="关联专家"><input placeholder="搜索专家" aria-label="搜索关联专家" value={query} onChange={event => setQuery(event.target.value)} /><div>{library.experts.filter(expert => expert.installed && `${expert.name} ${expert.role}`.toLowerCase().includes(query.toLowerCase())).map(expert => <label key={expert.id}><input type="checkbox" checked={expertIds.includes(expert.id)} onChange={() => toggle(expert.id)} /><Avatar name={expert.name} avatar={expert.avatar} /><span>{expert.name}</span></label>)}</div><p className="tiny">仅对选中的专家开放技能；未选择专家时保存在“我的资源”。</p></section>}
      <section className="hub-detail-skills"><div><h3>Skills <span>{item.skills.length}</span></h3>{item.skills.length > 6 && <button className="btn text" onClick={() => setExpanded(!expanded)}>{expanded ? '收起' : '展开全部'}</button>}</div>{item.skills.slice(0, expanded ? undefined : 6).map((skill, index) => <button key={skill.key} onClick={() => setPreview(preview === index ? -1 : index)} aria-expanded={preview === index}><strong>{skill.name}</strong><span>{skill.description}</span>{preview === index && <pre>{detail.documents[index].content}</pre>}</button>)}</section>
      <section className="hub-detail-readme"><h3>{item.kind === 'plugin' ? '插件说明' : 'Skill 说明'}</h3><pre>{detail.readme}</pre></section>
      {removing && <div className="hub-remove-confirm"><p>卸载将解除此资源的专家关联，保留导入文件和已有配置。</p><button className="btn" disabled={busy} onClick={() => void save(true)}>确认卸载</button></div>}{error && <p role="alert" className="form-error">{error}</p>}
    </div>
  </Modal>;
}
function ImportCapability({ kind, onClose, saved }: { kind: 'plugin' | 'skill'; onClose(): void; saved(key: string): Promise<void> }) {
  const [content, setContent] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const choose = async () => { try { const file = await api().chooseCapability(kind); if (file) setContent(file.content); } catch (cause) { setError(String(cause)); } };
  const submit = async () => { if (busy) return; setBusy(true); try { await saved(await api().importCapability(content, kind)); } catch (cause) { setError(String(cause)); } finally { setBusy(false); } };
  return <Modal title={kind === 'plugin' ? '添加插件' : '上传 Skill'} className="hub-import-dialog" onClose={onClose} footer={<><button className="btn" onClick={onClose}>取消</button><span className="spacer" /><button className="btn primary" disabled={busy || !content.trim()} onClick={() => void submit()}>预览并安装</button></>}><div className="dialog-body"><h2>{kind === 'plugin' ? '添加插件' : '上传 Skill'}</h2><p className="resource-note">{kind === 'plugin' ? '导入 Soul 插件 JSON，包含元信息和 Markdown 技能。' : '导入含 name 与 description frontmatter 的 Markdown 技能。'}</p><button className="btn" disabled={busy} onClick={() => void choose()}><Icon name="upload" small />选择文件</button>{kind === 'plugin' && <details><summary>查看插件包格式</summary><pre>{JSON.stringify({ schema: 'soul-plugin-v1', name: '插件名称', description: '插件说明', version: '1.0.0', readme: '# 使用说明', skills: ['---\nname: my-skill\ndescription: 技能说明\n---\n# 技能内容'] }, null, 2)}</pre></details>}<label className="field">{kind === 'plugin' ? '插件 JSON' : 'Skill Markdown'}<textarea aria-label={kind === 'plugin' ? '插件 JSON' : 'Skill Markdown'} spellCheck={false} value={content} onChange={event => setContent(event.target.value)} /></label>{error && <p role="alert" className="form-error">{error}</p>}</div></Modal>;
}
