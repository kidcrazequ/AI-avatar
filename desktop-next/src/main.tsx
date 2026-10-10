import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ArchiveFile, DesktopAPI, ExpertDetail, LibrarySnapshot, RuntimeStatus } from '../shared/contracts';
import { Icon } from './primitives';
import { Management } from './management';
import { ExpertHome } from './expert-home';
import { ArchiveDialog } from './expert-dialogs';
import { ResourcesPage } from './resources-page';
import './style.css';

declare global { interface Window { soulDesktop: DesktopAPI } }
const currentRoute = () => { try { return location.hash.slice(1).split('/').map(decodeURIComponent); } catch { return ['']; } };
const globalItems = [['users', '专家管理'], ['chat', '任务对话'], ['bot', 'IM'], ['flow', '工作流'], ['board', '任务看板'], ['project', '公开项目'], ['book', '知识库']];

function App() {
  const [status, setStatus] = useState<RuntimeStatus>();
  const [library, setLibrary] = useState<LibrarySnapshot>();
  const [error, setError] = useState('');
  const [route, setRoute] = useState(currentRoute);
  const id = route[0] === 'expert' ? route[1] ?? '' : '';
  const page = id ? route[2] ?? 'home' : route[0] ?? '';
  const detail = id ? route[3] ?? '' : route[1] ?? '';
  const [expert, setExpert] = useState<ExpertDetail>();
  const [file, setFile] = useState<ArchiveFile>();
  const [toast, setToast] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const notice = useCallback((message: string) => { setToast(message); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(''), 4000); }, []);
  useEffect(() => {
    Promise.all([window.soulDesktop.readStatus(), window.soulDesktop.readLibrary()]).then(([runtime, snapshot]) => { setStatus(runtime); setLibrary(snapshot); }).catch(cause => setError(String(cause)));
    const navigate = () => { setRoute(currentRoute()); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', navigate);
    return () => { window.removeEventListener('hashchange', navigate); clearTimeout(toastTimer.current); };
  }, []);
  useEffect(() => {
    let active = true;
    if (!id) { setExpert(undefined); return; }
    setExpert(undefined);
    window.soulDesktop.readExpert(id).then(detail => { if (active) setExpert(detail); }).catch(cause => { if (active) { notice(String(cause)); location.hash = ''; } });
    return () => { active = false; };
  }, [id, library, notice]);
  const back = () => { location.hash = ''; };
  const archive = async (expertId: string, path: string) => { try { setFile(await window.soulDesktop.readArchive(expertId, path)); } catch (cause) { notice(String(cause)); } };
  const saved = (snapshot: LibrarySnapshot) => setLibrary(snapshot);
  const activeGlobal = !id && page === 'projects' ? 5 : !id && page === 'knowledge' ? 6 : 0;
  return <div className="shell" data-runtime-ready={Boolean(status && library)} data-ued-node="shell.desktop">
    <aside className="rail" aria-label="主导航" data-ued-node="shell.global-nav"><div className="brand"><img src="./assets/soul-avatar.png" alt="Soul" /></div><nav>{globalItems.map(([icon, label], index) => <button key={label} className={`rail-tab ${index === activeGlobal ? 'active' : ''}`} aria-label={label} aria-current={index === activeGlobal ? 'page' : undefined} title={label} data-tip={label} onClick={index === 0 ? back : index === 5 || index === 6 ? () => { location.hash = index === 5 ? 'projects' : 'knowledge'; } : () => notice('该功能暂未开放')}><Icon name={icon} /></button>)}</nav><div className="rail-footer">{[['gauge', '用量'], ['settings', '设置']].map(([icon, label]) => <button key={label} className="rail-tab" aria-label={label} title={label} data-tip={label} onClick={() => notice('该功能暂未开放')}><Icon name={icon} /></button>)}</div></aside>
    {error && <main className="management"><h1>无法读取专家资料</h1><p role="alert" data-runtime-error>{error}</p></main>}
    {!library && !error && <main className="management"><p>正在读取专家资料…</p></main>}
    {library && !id && !['projects', 'knowledge'].includes(page) && <Management {...{ library, saved, notice, archive }} openExpert={expertId => { location.hash = `expert/${encodeURIComponent(expertId)}`; }} />}
    {library && id && !expert && <main className="management"><p>正在读取专家档案…</p></main>}
    {library && expert && page === 'home' && <ExpertHome key={expert.id} {...{ expert, library, saved, notice, archive, back }} />}
    {library && (!id || expert) && ['projects', 'knowledge', 'memory', 'skills', 'settings'].includes(page) && <ResourcesPage key={`${id}/${page}`} {...{ expert: id ? expert : undefined, page, detail, saved, notice, archive }} />}
    {file && <ArchiveDialog file={file} onClose={() => setFile(undefined)} />}
    {toast && <div className="toast" role="status">{toast}</div>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);
