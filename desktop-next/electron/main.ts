import { app, BrowserWindow, dialog, ipcMain, nativeImage, safeStorage, powerSaveBlocker, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { probeRuntime } from './runtime-probe';
import { ExpertLibrary } from './expert-library';
import { ResourceStore } from './resources';
import { verifyWorkflowPages } from './verify-workflows';
import { verifyResourcePages } from './verify-resources';
import { TaskRepository } from './task-repository';
import { TaskModels } from './task-models';
import { TaskRuntime } from './task-runtime';
import { WorkflowStore } from './workflow-store';
import { WorkflowRuntime } from './workflow-runtime';
import { taskFile } from './task-tools';
import { verificationModel, verificationCall, verifyTaskPages } from './verify-tasks';
import { Permissions, defaultPermissions } from './permissions';
import { ConnectorRuntime } from './connector-runtime';
import { IMRuntime } from './im-runtime';
import { AppSettings } from './app-settings';
import { verifyIntegrationPages } from './verify-integrations';
import { autoUpdater } from 'electron-updater';
import { UpdateManager, validateFeed } from './update-manager';
import { migrateProfile, backupProfile } from './profile-upgrade';
import type { UpdatePolicy } from '../shared/updates';
import { verifyUpgrade } from './verify-upgrade';

const flag = (name: string) => process.argv.find(item => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const verifyOutput = flag('verify-output');
const profile = flag('profile');
const upgradeOutput = flag('verify-upgrade');
if (upgradeOutput && (!profile || !path.isAbsolute(upgradeOutput))) throw new Error('Upgrade verification requires isolated absolute profile and output');
if (verifyOutput && !profile) throw new Error('Install verification requires an isolated --profile');
if (profile && !path.isAbsolute(profile)) throw new Error('Profile must be absolute');
app.setName('Soul Next');
app.setPath('userData', profile ?? path.join(app.getPath('appData'), 'SoulNextValidation'));
fs.mkdirSync(app.getPath('userData'), { recursive: true });
const ownsProfile = app.requestSingleInstanceLock();
if (!ownsProfile) app.quit();
let window: BrowserWindow | null = null;
let timer: NodeJS.Timeout | undefined;
let library: ExpertLibrary | undefined;
let resources: ResourceStore | undefined;
let tasks: TaskRuntime | undefined;
let taskRepository: TaskRepository | undefined;
let models: TaskModels | undefined;
let workflows: WorkflowRuntime | undefined;
let permissions: Permissions | undefined;
let connectors: ConnectorRuntime | undefined;
let im: IMRuntime | undefined;
let settings: AppSettings | undefined;
let wakeId: number | undefined;
let updater: UpdateManager | undefined;
let upgrading = false;
let recoveringUpdate = false;
const closeLibrary = () => { im?.close(); im = undefined; void connectors?.close(); connectors = undefined; settings?.close(); settings = undefined; permissions?.close(); permissions = undefined; workflows?.close(); workflows = undefined; tasks?.close(); tasks = undefined; taskRepository?.close(); taskRepository = undefined; models?.close(); models = undefined; resources?.close(); resources = undefined; library?.close(); library = undefined; };

const fail = (error: unknown) => {
  const detail = error instanceof Error ? error.stack : String(error);
  console.error(detail);
  if (verifyOutput) {
    fs.mkdirSync(path.dirname(verifyOutput), { recursive: true });
    fs.writeFileSync(verifyOutput, JSON.stringify({ ok: false, error: detail, execPath: process.execPath }, null, 2));
  }
  app.exit(1);
};
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

app.whenReady().then(async () => {
  if (!ownsProfile) return;
  const migration = await migrateProfile(app.getPath('userData'));
  const resourceRoot = app.isPackaged ? path.join(process.resourcesPath, 'soul-resources') : path.join(app.getAppPath(), 'build/resources');
  const status = probeRuntime(resourceRoot, app.getPath('userData'), app.getVersion());
  library = new ExpertLibrary(resourceRoot, app.getPath('userData'));
  resources = new ResourceStore(resourceRoot, app.getPath('userData'), library);
  taskRepository = new TaskRepository(app.getPath('userData'));
  models = new TaskModels(app.getPath('userData'), {
    encrypt(value) { if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥加密暂不可用'); return safeStorage.encryptString(value); },
    decrypt(value) { return safeStorage.decryptString(value); },
  });
  const executionModels = verifyOutput || upgradeOutput ? { list: () => [verificationModel], resolve: () => verificationModel } : models;
  const codec = { encrypt(value: string) { if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥加密暂不可用'); return safeStorage.encryptString(value); }, decrypt(value: Buffer) { return safeStorage.decryptString(value); } };
  const integrationChanged = () => { if (!window?.isDestroyed()) window?.webContents.send('soul-next:integrations-changed'); };
  permissions = new Permissions(app.getPath('userData'), id => library!.detail(id));
  connectors = new ConnectorRuntime(app.getPath('userData'), codec, id => library!.detail(id), integrationChanged);
  settings = new AppSettings(app.getPath('userData'), executionModels, status, {
    encryption() { return safeStorage.isEncryptionAvailable(); },
    setStartup(openAtLogin) { app.setLoginItemSettings({ openAtLogin, path: process.execPath }); },
    startup() { return app.getLoginItemSettings({ path: process.execPath }).openAtLogin; },
    wake(start) { if (start && wakeId === undefined) wakeId = powerSaveBlocker.start('prevent-app-suspension'); if (!start && wakeId !== undefined) { powerSaveBlocker.stop(wakeId); wakeId = undefined; } return wakeId !== undefined && powerSaveBlocker.isStarted(wakeId); },
    async open(file) { const error = await shell.openPath(file); if (error) throw new Error('无法打开日志目录'); },
  });
  tasks = new TaskRuntime(taskRepository, library, resources, executionModels, app.getPath('userData'), () => { if (!window?.isDestroyed()) window?.webContents.send('soul-next:tasks-changed'); queueMicrotask(() => { workflows?.synchronize(); im?.synchronize(); settings?.activity(tasks?.read().tasks.some(t => t.status === 'running') ?? false); }); }, verifyOutput || upgradeOutput ? verificationCall(status.persistenceRun) : undefined, { permissions, connectors, preferences: () => settings!.preferences() });
  im = new IMRuntime(app.getPath('userData'), codec, library, tasks, integrationChanged);
  await im.start();
  workflows = new WorkflowRuntime(new WorkflowStore(taskRepository, library), tasks, {
    encrypt(value) { if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥加密暂不可用'); return safeStorage.encryptString(value); },
    decrypt(value) { return safeStorage.decryptString(value); },
  }, () => { if (!window?.isDestroyed()) window?.webContents.send('soul-next:workflows-changed'); });
  await workflows.start();
  const policyFile = path.join(resourceRoot, 'update-policy.json');
  let policy: UpdatePolicy | null = fs.existsSync(policyFile) ? JSON.parse(fs.readFileSync(policyFile, 'utf8')) : null;
  if (upgradeOutput && flag('upgrade-feed')) policy = { url: validateFeed(flag('upgrade-feed')!, true), channel: 'candidate', production: false };
  autoUpdater.logger = { info() {}, warn() {}, error() {} };
  updater = new UpdateManager(app.getPath('userData'), app.getVersion(), policy, autoUpdater,
    () => {
      if (!window?.isDestroyed()) window?.webContents.send('soul-next:updates-changed');
      if (upgrading && !upgradeOutput && !recoveringUpdate && updater?.read().state === 'error') {
        recoveringUpdate = true;
        void dialog.showMessageBox({ type: 'error', message: '更新未完成', detail: '已保留升级前备份。应用将重新启动以恢复工作；不会自动重试安装。' }).then(() => { app.relaunch(); app.exit(1); });
      }
    },
    () => Boolean(tasks?.read().tasks.some(t => t.status === 'running') || workflows?.read().runs.some(r => r.status === 'running') || im?.isSending()),
    async () => {
      upgrading = true;
      im?.close(); im = undefined;
      await workflows?.close(); workflows = undefined;
      await connectors?.close(); connectors = undefined;
      closeLibrary();
      try { return await backupProfile(app.getPath('userData'), 'pre-update'); }
      catch (e) { if (!upgradeOutput) { await dialog.showMessageBox({ type: 'error', message: '升级前备份失败，未安装更新', detail: '应用将重新启动以恢复当前工作。' }); app.relaunch(); app.exit(1); } throw e; }
    }, process.platform === 'darwin' && !policy?.production ? 'Mac 自动安装需要签名发行包；当前内部版本可使用 DMG 验证安装和数据保留' : '', Boolean(upgradeOutput));
  const page = path.join(__dirname, '../dist/index.html');
  const pageUrl = pathToFileURL(page).href;
  window = new BrowserWindow({
    width: 1440, height: 900, minWidth: 960, minHeight: 600,
    backgroundColor: '#ffffff', show: false, title: 'Soul Next', enableLargerThanScreen: Boolean(verifyOutput || upgradeOutput),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const handle = (channel: string, listener: (...args: any[]) => unknown) => ipcMain.handle(`soul-next:${channel}`, (event, ...args) => {
    if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url.split('#')[0] !== pageUrl) throw new Error('Untrusted IPC sender');
    if (upgrading && channel !== 'updates') throw new Error('正在准备更新，请稍候');
    return listener(...args);
  });
  handle('updates', () => updater!.read());
  handle('update-check', () => updater!.check());
  handle('update-download', () => updater!.download());
  handle('update-cancel', () => updater!.cancel());
  handle('update-automatic', value => updater!.automatic(value));
  handle('update-install', async () => { const result = await dialog.showMessageBox(window!, { type: 'question', message: '重启并安装更新？', detail: '请保存页面中尚未提交的编辑。已保存的数据会在升级前备份；运行中的任务和外部发送需先停止。', buttons: ['稍后', '重启并安装'], defaultId: 0, cancelId: 0 }); if (result.response === 1) await updater!.install(); });
  handle('status', () => status);
  handle('integrations', scope => ({ connectors: connectors!.read(scope), channels: im!.channels(), sessions: im!.sessions(), events: im!.publicEvents(), permissions: scope ? permissions!.read(scope) : defaultPermissions() }));
  handle('connector-save', input => connectors!.save(input));
  handle('connector-connect', id => connectors!.connect(id));
  handle('connector-remove', id => connectors!.remove(id));
  handle('permissions-save', (id, input) => { permissions!.save(id, input); integrationChanged(); });
  handle('im-channel-save', input => im!.saveChannel(input));
  handle('im-channel-remove', id => im!.removeChannel(id));
  handle('im-session-save', input => im!.saveSession(input));
  handle('im-session-remove', id => im!.removeSession(id));
  handle('im-pair', (id, input) => im!.pair(id, input));
  handle('im-send-reply', id => im!.sendReply(id));
  handle('settings', () => settings!.read());
  handle('settings-save', input => { settings!.save(input); settings!.activity(tasks!.read().tasks.some(t => t.status === 'running')); });
  handle('settings-diagnose', () => settings!.diagnose());
  handle('settings-logs', () => settings!.openLogs());
  handle('library', () => library!.list());
  handle('expert', id => library!.detail(id));
  handle('archive', (id, file) => library!.archive(id, file));
  handle('install', id => library!.installExpert(id));
  handle('create', input => library!.createExpert(input));
  handle('rename', (id, name) => library!.renameExpert(id, name));
  handle('remove', id => library!.removeExpert(id));
  handle('restore', () => library!.restoreExperts());
  handle('import', token => library!.importExpert(token));
  handle('discard-import', token => library!.discardImport(token));
  handle('save-group', input => library!.saveGroup(input));
  handle('remove-group', id => library!.removeGroup(id));
  handle('create-role', input => library!.createRole(input));
  handle('workflows', () => workflows!.read());
  handle('workflow-save', (id, version, spec, requestId) => workflows!.save(id, version, spec, requestId));
  handle('workflow-configure', (id, version, config, requestId) => workflows!.configure(id, version, config, requestId));
  handle('workflow-restore', (id, version, target, requestId) => workflows!.restore(id, version, target, requestId));
  handle('workflow-remove', (id, requestId) => workflows!.remove(id, requestId));
  handle('workflow-restore-removed', requestId => workflows!.restoreRemoved(requestId));
  handle('workflow-run', (id, input, requestId) => workflows!.run(id, input, requestId));
  handle('workflow-resume', (id, requestId) => workflows!.resume(id, requestId));
  handle('workflow-cancel', (id, requestId) => workflows!.cancel(id, requestId));
  handle('workflow-token', id => workflows!.apiToken(id));
  handle('tasks', () => tasks!.read());
  handle('task-send', input => tasks!.send(input));
  handle('task-resume', (id, requestId) => { const task = taskRepository!.get(id); return task.workflow ? workflows!.resume(task.workflow.runId, requestId) : tasks!.resume(id, requestId); });
  handle('task-cancel', (id, requestId) => { const task = taskRepository!.get(id); return task.workflow ? workflows!.cancel(task.workflow.runId, requestId) : tasks!.cancel(id, requestId); });
  handle('task-approve', (id, approvalId, approved, note, requestId) => tasks!.approve(id, approvalId, approved, note, requestId));
  handle('task-model-save', input => { const result = models!.save(input); window!.webContents.send('soul-next:tasks-changed'); return result; });
  handle('task-model-import', async () => {
    const result = await dialog.showOpenDialog(window!, { properties: ['openFile'], filters: [{ name: '旧版 Soul 数据库', extensions: ['db', 'sqlite'] }] });
    if (result.canceled || !result.filePaths[0]) return models!.list();
    const entries = models!.importLegacy(result.filePaths[0]); window!.webContents.send('soul-next:tasks-changed'); return entries;
  });
  handle('task-attachments', async () => {
    const result = await dialog.showOpenDialog(window!, { properties: ['openFile', 'multiSelections'], filters: [{ name: '文本资料', extensions: ['md', 'txt', 'csv', 'json'] }] });
    if (result.canceled) return [];
    if (result.filePaths.length > 5) throw new Error('最多添加 5 个附件');
    return result.filePaths.map(file => {
      if (fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile() || !/\.(md|txt|csv|json)$/i.test(file) || fs.statSync(file).size > 200000) throw new Error('附件须为 200 KB 内的文本文件');
      return taskFile(crypto.randomUUID(), path.basename(file), file, fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    });
  });
  handle('task-export', async id => {
    const task = taskRepository!.get(id);
    if (task.status !== 'completed') throw new Error('任务尚未完成');
    const result = await dialog.showSaveDialog(window!, { defaultPath: `Soul-${task.id}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (result.canceled || !result.filePath) return false;
    fs.writeFileSync(result.filePath, `# ${task.title}\n\n任务 ID：${task.id}\n\n${task.messages.filter(message => message.role === 'assistant').map(message => `## ${task.members.find(member => member.expertId === message.expertId)?.name}\n\n${message.text}`).join('\n\n')}`);
    return true;
  });
  handle('resources', scope => resources!.read(scope));
  handle('project-save', (input, scope) => resources!.saveProject(input, scope));
  handle('project-remove', (id, scope) => resources!.removeProject(id, scope));
  handle('collection-save', (id, title) => resources!.saveCollection(id, title));
  handle('collection-remove', id => resources!.removeCollection(id));
  handle('resource-restore', scope => resources!.restoreTrash(scope));
  handle('knowledge-bind', (id, ids) => resources!.bind(id, ids));
  handle('documents', (id, scope) => resources!.documents(id, scope));
  handle('document', (id, file, scope) => resources!.readDocument(id, file, scope));
  handle('document-save', (input, scope) => resources!.saveDocument(input, scope));
  handle('document-remove', (id, file, revision, scope) => resources!.removeDocument(id, file, revision, scope));
  handle('memory-save', (id, value, revision, group) => resources!.saveMemory(id, value, revision, group));
  handle('memory-restore', (id, version, revision) => resources!.restoreVersion(id, version, revision));
  handle('skill', (id, key) => resources!.readSkill(id, key));
  handle('skill-configure', (id, key, enabled) => resources!.configureSkill(id, key, enabled));
  handle('skill-upload', (id, value) => resources!.uploadSkill(id, value));
  handle('expert-settings', (id, name, intro, model) => library!.saveSettings(id, name, intro, model));
  handle('soul-save', (id, value, revision) => resources!.saveSoul(id, value, revision));
  handle('quality', id => resources!.checkQuality(id));
  handle('test-case', (id, file) => resources!.readCase(id, file));
  handle('resource-text', async kind => {
    if (kind !== 'document' && kind !== 'skill') throw new Error('导入类型无效');
    const result = await dialog.showOpenDialog(window!, { properties: ['openFile'], filters: [{ name: 'Markdown / 文本', extensions: kind === 'skill' ? ['md'] : ['md', 'txt'] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    const file = result.filePaths[0];
    if (fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile() || !(/\.md$/i.test(file) || (kind === 'document' && /\.txt$/i.test(file))) || fs.statSync(file).size > (kind === 'skill' ? 65536 : 2 * 1024 * 1024)) throw new Error('文件格式或大小不符合要求');
    return { name: path.basename(file), content: fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '') };
  });
  const directory = async () => {
    const result = await dialog.showOpenDialog(window!, { properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  };
  handle('choose-import', async () => { const source = await directory(); return source ? library!.previewImport(source) : null; });
  handle('choose-directory', directory);
  handle('choose-role-text', async () => {
    const result = await dialog.showOpenDialog(window!, { properties: ['openFile'], filters: [{ name: '角色 Markdown', extensions: ['md', 'txt'] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    const file = result.filePaths[0];
    if (fs.statSync(file).size > 8000 * 4) throw new Error('角色段落过长，请控制在 8000 个字符以内');
    return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  });
  handle('save-role-template', async () => {
    const result = await dialog.showSaveDialog(window!, { defaultPath: 'Soul角色草案.md', filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (result.canceled || !result.filePath) return false;
    fs.copyFileSync(path.join(resourceRoot, 'templates/soul-template.md'), result.filePath);
    return true;
  });
  handle('choose-avatar', async () => {
    const result = await dialog.showOpenDialog(window!, { properties: ['openFile'], filters: [{ name: '头像', extensions: ['png', 'jpg', 'jpeg'] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    const file = result.filePaths[0];
    if (fs.statSync(file).size > 2 * 1024 * 1024) throw new Error('头像文件不能超过 2 MB');
    const image = nativeImage.createFromPath(file);
    if (image.isEmpty()) throw new Error('无法读取头像图片');
    const png = image.resize({ width: 512, height: 512 }).toPNG();
    if (png.length > 2 * 1024 * 1024) throw new Error('头像图片不能超过 2 MB');
    return `data:image/png;base64,${png.toString('base64')}`;
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('render-process-gone', (_event, detail) => fail(detail));
  window.webContents.on('did-fail-load', (_event, code, message) => fail(new Error(`${code}: ${message}`)));
  window.once('ready-to-show', () => { window?.show(); window?.focus(); });
  if (verifyOutput) timer = setTimeout(() => fail(new Error('Installed renderer timed out')), 60_000);
  await window.loadFile(page);
  if (upgradeOutput) { await verifyUpgrade(window, updater, library!, app.getPath('userData'), upgradeOutput, flag('upgrade-mode') ?? 'read', migration); return; }
  if (!verifyOutput) updater.start();
  if (!verifyOutput) return;
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    let attempts = 0;
    const poll = () => {
      if (document.querySelector('[data-runtime-ready="true"]')) return document.fonts.ready.then(resolve);
      if (++attempts > 200) return reject(new Error('Renderer or typed preload did not initialize'));
      setTimeout(poll, 50);
    }; poll();
  })`);
  fs.mkdirSync(path.dirname(verifyOutput), { recursive: true });
  const renderChecks: unknown[] = [];
  const homeRenderChecks: unknown[] = [];
  for (const [width, height] of [[1440, 900], [1280, 800]]) {
    window.setContentSize(width, height);
    await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const rendered = await window.webContents.executeJavaScript(`({
      width: innerWidth, height: innerHeight, title: document.querySelector('h1')?.textContent,
      cards: document.querySelectorAll('[data-expert-id]').length,
      railWidth: document.querySelector('.rail')?.getBoundingClientRect().width,
      overflow: document.documentElement.scrollWidth > innerWidth,
      ipc: typeof window.soulDesktop?.readStatus === 'function',
      nodeDisabled: typeof window.require === 'undefined',
      fontLoaded: document.fonts.check('13px "DM Sans"'),
      error: document.querySelector('[data-runtime-error]')?.textContent ?? null
    })`);
    if (rendered.width !== width || rendered.height !== height || rendered.cards !== status.experts.length || rendered.railWidth !== 64 || rendered.overflow || !rendered.ipc || !rendered.nodeDisabled || !rendered.fontLoaded || rendered.error) throw new Error(`Installed window check failed: ${JSON.stringify(rendered)}`);
    renderChecks.push(rendered);
    const shot = await window.webContents.capturePage();
    fs.writeFileSync(path.join(path.dirname(verifyOutput), `window-${width}x${height}-${status.persistenceRun}.png`), shot.toPNG());
  }
  await window.loadFile(page, { hash: 'expert/finance-expert' });
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    let attempts = 0;
    const poll = () => {
      if (document.querySelector('[data-ued-node="expert.home"]')) return document.fonts.ready.then(resolve);
      if (++attempts > 200) return reject(new Error('Expert library or detail IPC did not initialize'));
      setTimeout(poll, 50);
    }; poll();
  })`);
  for (const [width, height] of [[1440, 900], [1280, 800]]) {
    window.setContentSize(width, height);
    await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const rendered = await window.webContents.executeJavaScript(`(() => {
      const box = selector => { const rect = document.querySelector(selector).getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; };
      return { width: innerWidth, height: innerHeight, name: document.querySelector('.identity-name h2').textContent,
        rail: box('.rail'), sidebar: box('.expert-sidebar'), page: box('.home-page'), identity: box('.identity'),
        work: box('[data-ued-node="expert.work-record"]'), memory: box('[data-ued-node="expert.memory-summary"]'),
        skills: document.querySelectorAll('.badges .badge').length, archives: document.querySelectorAll('.archive').length,
        overflow: document.documentElement.scrollWidth > innerWidth, fontLoaded: document.fonts.check('13px "DM Sans"') };
    })()`);
    if (rendered.name !== library.detail('finance-expert').name || rendered.rail.width !== 64 || rendered.sidebar.width !== 240 || rendered.sidebar.x !== 64 || rendered.page.width !== (width === 1440 ? 960 : 896) || rendered.page.x !== (width === 1440 ? 392 : 344) || rendered.identity.height !== 210 || rendered.work.y !== 280 || rendered.work.height !== 348 || rendered.memory.y !== 644 || rendered.overflow || !rendered.fontLoaded || rendered.skills !== library.detail('finance-expert').skills.length || rendered.archives !== library.detail('finance-expert').archives.length) throw new Error(`Installed home check failed: ${JSON.stringify(rendered)}`);
    homeRenderChecks.push(rendered);
    fs.writeFileSync(path.join(path.dirname(verifyOutput), `home-${width}x${height}-${status.persistenceRun}.png`), (await window.webContents.capturePage()).toPNG());
  }
  const resourceRenderChecks = await verifyResourcePages(window, page, verifyOutput, status.persistenceRun);
  const taskRenderChecks = await verifyTaskPages(window, page, verifyOutput, app.getPath('userData'), status.persistenceRun);
  const workflowRenderChecks = await verifyWorkflowPages(window, page, verifyOutput, app.getPath('userData'), status.persistenceRun);
  const integrationRenderChecks = await verifyIntegrationPages(window, page, verifyOutput, status.persistenceRun);
  if (timer) clearTimeout(timer);
  const ok = app.isPackaged && status.checks.every(check => check.ok);
  console.log(JSON.stringify({ ok, checks: status.checks, renderChecks }));
  fs.writeFileSync(verifyOutput, JSON.stringify({
    ok, packaged: app.isPackaged, execPath: process.execPath, resourcesPath: process.resourcesPath,
    userData: app.getPath('userData'), host: { platform: os.platform(), release: os.release(), arch: os.arch() },
    versions: process.versions, renderChecks, homeRenderChecks, resourceRenderChecks, taskRenderChecks, workflowRenderChecks, integrationRenderChecks, status,
  }, null, 2));
  closeLibrary();
  app.exit(ok ? 0 : 1);
}).catch(fail);
app.on('window-all-closed', () => app.quit());
app.on('will-quit', closeLibrary);
app.on('will-quit', () => updater?.close());
