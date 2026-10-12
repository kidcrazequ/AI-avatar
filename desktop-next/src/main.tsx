import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ArchiveFile, DesktopAPI, ExpertDetail, LibrarySnapshot, RuntimeStatus } from '../shared/contracts';
import { WorkspaceSidebar, type WorkspaceSection } from './workspace-sidebar';
import { Management } from './management';
import { RecruitmentPage } from './recruitment-page';
import { ExpertHome } from './expert-home';
import { ExpertSidebar } from './expert-sidebar';
import { ExpertProfile } from './expert-profile';
import { ArchiveDialog, GroupDialog } from './expert-dialogs';
import { ResourceHub } from './resource-hub';
import { CapabilityMarket } from './capability-market';
import { ResourcesPage } from './resources-page';
import { WorkflowsPage } from './workflows-page';
import { AutonomousWorkPage } from './autonomous-work-page';
import { TasksPage } from './tasks-page';
import { IMPage } from './im-page';
import { EvolutionPage } from './evolution-page';
import { RecordingPage } from './recording-page';
import { WorkspaceAssistant } from './workspace-assistant';
import { ConnectorsPage } from './connectors-page';
import { PermissionsPage } from './permissions-page';
import { SettingsPage, UsagePopover, applyTheme } from './settings-page';
import './style.css';
import './expert-home.css';
import './task-replica.css';

declare global { interface Window { soulDesktop: DesktopAPI } }
const currentRoute = () => { try { return location.hash.slice(1).split('/').map(decodeURIComponent); } catch { return ['']; } };
const resourcePages = ['plugins', 'connectors', 'skills', 'knowledge', 'flows', 'flow', 'workflow', 'projects'];
const resolveRoute = (route: string[]) => {
  if (route[0] === 'resources') return [resourcePages.includes(route[1]) ? route[1] : 'plugins', ...route.slice(2)];
  const aliases: Record<string, string> = { 'work-management': 'board', 'at-expert': 'im', 'autonomous-work': 'autonomous', 'expert-management': '' };
  return [aliases[route[0]] ?? route[0], ...route.slice(1)];
};
const initialCollapsed = () => { try { return localStorage.getItem('soul.workspace.sidebar.collapsed') === 'true'; } catch { return false; } };

function App() {
  const [status, setStatus] = useState<RuntimeStatus>();
  const [library, setLibrary] = useState<LibrarySnapshot>();
  const [error, setError] = useState('');
  const [route, setRoute] = useState(currentRoute);
  const viewRoute = resolveRoute(route);
  const id = viewRoute[0] === 'expert' ? viewRoute[1] ?? '' : '';
  const page = id ? viewRoute[2] ?? 'home' : viewRoute[0] ?? '';
  const detail = id ? viewRoute[3] ?? '' : viewRoute[1] ?? '';
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [create, setCreate] = useState<'group'>();
  const toggleSidebar = () => setCollapsed(previous => { const next = !previous; try { localStorage.setItem('soul.workspace.sidebar.collapsed', String(next)); } catch { /* Layout still works when local storage is unavailable. */ } return next; });
  const [expert, setExpert] = useState<ExpertDetail>();
  const [file, setFile] = useState<ArchiveFile>();
  const [toast, setToast] = useState('');
  const [usage, setUsage] = useState(false);
  const closeUsage = useCallback(() => setUsage(false), []);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const notice = useCallback((message: string) => { setToast(message); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(''), 4000); }, []);
  useEffect(() => {
    Promise.all([window.soulDesktop.readStatus(), window.soulDesktop.readLibrary()]).then(([runtime, snapshot]) => { setStatus(runtime); setLibrary(snapshot); }).catch(cause => setError(String(cause)));
    const media = matchMedia('(prefers-color-scheme: dark)');
    const theme = () => window.soulDesktop.settings.read().then(s => applyTheme(s.preferences.theme)).catch(c => notice(String(c)));
    void theme(); media.addEventListener('change', theme);
    const navigate = () => { setRoute(currentRoute()); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', navigate);
    return () => { window.removeEventListener('hashchange', navigate); media.removeEventListener('change', theme); clearTimeout(toastTimer.current); };
  }, []);
  useEffect(() => {
    let active = true;
    if (!id) { setExpert(undefined); return; }
    setExpert(undefined);
    window.soulDesktop.readExpert(id).then(detail => { if (active) setExpert(detail); }).catch(cause => { if (active) { notice(String(cause)); location.hash = ''; } });
    return () => { active = false; };
  }, [id, library, notice, page]);
  const back = () => { location.hash = 'expert-management'; };
  const archive = async (expertId: string, path: string) => { try { setFile(await window.soulDesktop.readArchive(expertId, path)); } catch (cause) { notice(String(cause)); } };
  const saved = (snapshot: LibrarySnapshot) => setLibrary(snapshot);
  const active: WorkspaceSection | undefined = ['app-settings', 'chat', 'task', 'workspace-assistant'].includes(page) ? undefined : route[0] === 'autonomous-work' ? 'autonomous' : page === 'board' ? 'board' : page === 'im' ? 'im' : !id && resourcePages.includes(page) ? 'resources' : 'management';
  const resourceContext = active === 'resources' && !['workflow', 'flow'].includes(page);
  return <div className={`shell ${collapsed ? 'shell-collapsed' : ''}`} data-runtime-ready={Boolean(status && library)} data-ued-node="shell.desktop">
    <WorkspaceSidebar {...{ library, status, active, collapsed, usage }} route={viewRoute} toggle={toggleSidebar} create={group => { if (group) setCreate('group'); else location.hash = 'recruitment-market'; }} showUsage={() => setUsage(previous => !previous)} />
    {library && resourceContext && <ResourceHub page={page}>
      {['plugins', 'skills'].includes(page) && <CapabilityMarket key={page} kind={page === 'plugins' ? 'plugin' : 'skill'} {...{ library, notice }} />}
      {page === 'connectors' && <ConnectorsPage {...{ library, notice }} />}
      {['knowledge', 'projects'].includes(page) && <ResourcesPage embedded key={page} {...{ page, detail, saved, notice, archive }} />}
      {page === 'flows' && <WorkflowsPage embedded {...{ library, notice }} />}
    </ResourceHub>}
    {error && <main className="management"><h1>无法读取专家资料</h1><p role="alert" data-runtime-error>{error}</p></main>}
    {!library && !error && <main className="management"><p>正在读取专家资料…</p></main>}
    {library && !id && !['plugins', 'connectors', 'projects', 'knowledge', 'skills', 'chat', 'task', 'board', 'flows', 'workflow', 'flow', 'autonomous', 'im', 'app-settings', 'recruitment-market', 'personal-avatar', 'workspace-assistant'].includes(page) && <Management key={detail} initialTab={detail === 'groups' ? 'groups' : 'experts'} {...{ library, saved, notice, archive }} openExpert={expertId => { location.hash = `expert/${encodeURIComponent(expertId)}`; }} />}
    {library && (!id || expert) && page === 'im' && <IMPage key={id + detail} {...{ expert, library, notice }} page={detail} />}
    {library && expert && page === 'connectors' && <ConnectorsPage {...{ expert, notice }} />}
    {library && expert && page === 'permissions' && <PermissionsPage {...{ expert, notice, archive }} />}
    {library && page === 'app-settings' && <SettingsPage page={detail} notice={notice} />}
    {library && !id && ['flow', 'workflow'].includes(page) && <WorkflowsPage key={detail} {...{ library, notice }} id={['workflow', 'flow'].includes(page) ? detail : ''} initialModal={viewRoute[2] === 'triggers' ? 'trigger' : ''} />}
    {library && !id && page === 'autonomous' && <AutonomousWorkPage {...{ library, notice }} />}
    {library && expert && ['flow', 'autonomous'].includes(page) && <><ExpertSidebar id={id} {...{ expert, page, notice }} /><div className="expert-context-content">{page === 'autonomous' ? <AutonomousWorkPage key={id} {...{ library, notice }} scope={id} /> : <WorkflowsPage key={id + detail} {...{ library, notice }} scope={id} id={detail} initialModal={viewRoute[4] === 'triggers' ? 'trigger' : ''} />}</div></>}
    {library && !id && ['chat', 'task', 'board'].includes(page) && <TasksPage key={viewRoute.join('/')} {...{ library, saved, notice, archive }} route={viewRoute} />}
    {library && expert && page === 'board' && <><ExpertSidebar id={id} {...{ expert, page, notice }} /><div className="expert-context-content"><TasksPage key={id + detail} {...{ library, saved, notice, archive }} route={['board', 'expert', id, detail]} /></div></>}
    {library && id && !expert && <main className="management"><p>正在读取专家档案…</p></main>}
    {library && expert && page === 'home' && <ExpertHome key={expert.id} {...{ expert, library, saved, notice, archive, back }} />}
    {library && expert && page === 'settings' && detail !== 'quality' && <ExpertProfile key={id} {...{ expert, library, saved, notice, archive, back }} />}
    {library && expert && page === 'evolution' && <EvolutionPage key={id} {...{ expert, notice, saved }} />}
    {library && expert && page === 'recording' && <RecordingPage key={id + detail} {...{ expert, notice, saved }} taskId={detail} />}
    {library && page === 'personal-avatar' && <RecordingPage {...{ notice, saved }} />}
    {library && expert && page === 'plugins' && <><ExpertSidebar id={id} {...{ expert, page, notice }} /><div className="resource-main"><div className="resource-page"><header className="resource-header"><div><h1>插件</h1><p>管理专家关联的插件能力。</p></div></header><CapabilityMarket kind="plugin" scope={id} {...{ library, notice }} /></div></div></>}
    {library && expert && (['projects', 'knowledge', 'memory', 'skills'].includes(page) || page === 'settings' && detail === 'quality') && <ResourcesPage key={`${id}/${page}`} {...{ expert, page, detail, saved, notice, archive }} />}
    {library && page === 'recruitment-market' && <RecruitmentPage {...{ library, saved, notice, archive }} />}
    {library && create === 'group' && <GroupDialog {...{ library, saved, notice, archive }} onClose={() => setCreate(undefined)} />}
    {usage && <UsagePopover onClose={closeUsage} />}
    {file && <ArchiveDialog file={file} onClose={() => setFile(undefined)} />}
    {toast && <div className="toast" role="status">{toast}</div>}
    {library && <WorkspaceAssistant full={page === 'workspace-assistant'} notice={notice} />}
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);
