import { app, BrowserWindow, dialog, ipcMain, nativeImage, safeStorage, powerSaveBlocker, shell, desktopCapturer, systemPreferences } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { probeRuntime } from './runtime-probe';
import { ExpertLibrary } from './expert-library';
import { RoleGeneration } from './role-generation';
import { SkillEvolution } from './skill-evolution';
import { RecordingLearning } from './recording-learning';
import { WorkspaceAssistant } from './workspace-assistant';
import { roleConnector } from './role-definition';
import { ResourceStore } from './resources';
import { TaskRepository } from './task-repository';
import { TaskModels } from './task-models';
import { TaskRuntime } from './task-runtime';
import { WorkflowStore } from './workflow-store';
import { WorkflowRuntime } from './workflow-runtime';
import { taskFile } from './task-tools';
import { verificationModel, verificationCall } from './verify-tasks';
import { Permissions, defaultPermissions } from './permissions';
import { ConnectorRuntime } from './connector-runtime';
import { IMRuntime } from './im-runtime';
import { AppSettings } from './app-settings';
import { verifyReplica } from './verify-replica';
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
let roleGeneration: RoleGeneration | undefined;
let evolution: SkillEvolution | undefined;
let recording: RecordingLearning | undefined;
let assistant: WorkspaceAssistant | undefined;
let workflows: WorkflowRuntime | undefined;
let permissions: Permissions | undefined;
let connectors: ConnectorRuntime | undefined;
let im: IMRuntime | undefined;
let settings: AppSettings | undefined;
let wakeId: number | undefined;
let updater: UpdateManager | undefined;
let upgrading = false;
let recoveringUpdate = false;
const closeLibrary = () => { assistant?.close(); assistant = undefined; recording?.close(); recording = undefined; evolution?.close(); evolution = undefined; roleGeneration?.close(); roleGeneration = undefined; im?.close(); im = undefined; void connectors?.close(); connectors = undefined; settings?.close(); settings = undefined; permissions?.close(); permissions = undefined; workflows?.close(); workflows = undefined; tasks?.close(); tasks = undefined; taskRepository?.close(); taskRepository = undefined; models?.close(); models = undefined; resources?.close(); resources = undefined; library?.close(); library = undefined; };

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
  roleGeneration = new RoleGeneration(models);
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
  }, () => library!.list().experts.filter(expert => expert.installed).length);
  tasks = new TaskRuntime(taskRepository, library, resources, executionModels, app.getPath('userData'), () => { if (!window?.isDestroyed()) window?.webContents.send('soul-next:tasks-changed'); queueMicrotask(() => { workflows?.synchronize(); im?.synchronize(); evolution?.synchronize(); settings?.activity(tasks?.read().tasks.some(t => t.status === 'running') ?? false); }); }, verifyOutput || upgradeOutput ? verificationCall(status.persistenceRun) : undefined, { permissions, connectors, preferences: () => settings!.preferences() });
  evolution = new SkillEvolution(app.getPath('userData'), library, resources, taskRepository, models, () => { if (!window?.isDestroyed()) window?.webContents.send('soul-next:evolution-changed'); });
  recording = new RecordingLearning(app.getPath('userData'), library, resources, taskRepository, models, codec, () => { if (!window?.isDestroyed()) window?.webContents.send('soul-next:learning-changed'); });
  assistant = new WorkspaceAssistant(app.getPath('userData'), path.join(app.getAppPath(), 'dist/product-guide.md'), executionModels, taskRepository, codec, app.getVersion(), () => { if (!window?.isDestroyed()) window?.webContents.send('soul-next:assistant-changed'); });
  im = new IMRuntime(app.getPath('userData'), codec, library, tasks, integrationChanged);
  await im.start();
  workflows = new WorkflowRuntime(new WorkflowStore(taskRepository, library), tasks, {
    encrypt(value) { if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥加密暂不可用'); return safeStorage.encryptString(value); },
    decrypt(value) { return safeStorage.decryptString(value); },
  }, () => { if (!window?.isDestroyed()) window?.webContents.send('soul-next:workflows-changed'); });
  await workflows.start();
  const policyFile = path.join(resourceRoot, 'update-policy.json');
  let policy: UpdatePolicy | null = fs.existsSync(policyFile) ? JSON.parse(fs.readFileSync(policyFile, 'utf8')) : null;
  if (upgradeOutput && policy?.production) throw new Error('正式发行包不接受内部升级验收模式');
  if (upgradeOutput && flag('upgrade-feed')) policy = { url: validateFeed(flag('upgrade-feed')!, true), channel: 'candidate', production: false };
  autoUpdater.logger = { info() {}, warn() {}, error() {} };
  if (upgradeOutput && flag('upgrade-feed')) {
    const config = path.join(app.getPath('userData'), 'upgrade-app-update.yml');
    fs.writeFileSync(config, JSON.stringify({ provider: 'generic', url: policy!.url, updaterCacheDirName: `soul-next-upgrade-${crypto.createHash('sha256').update(app.getPath('userData')).digest('hex').slice(0, 16)}` }));
    autoUpdater.updateConfigPath = config;
    autoUpdater.logger = console;
  }
  updater = new UpdateManager(app.getPath('userData'), app.getVersion(), policy, autoUpdater,
    () => {
      if (!window?.isDestroyed()) window?.webContents.send('soul-next:updates-changed');
      if (upgrading && !upgradeOutput && !recoveringUpdate && updater?.read().state === 'error') {
        recoveringUpdate = true;
        void dialog.showMessageBox({ type: 'error', message: '更新未完成', detail: '已保留升级前备份。应用将重新启动以恢复工作；不会自动重试安装。' }).then(() => { app.relaunch(); app.exit(1); });
      }
    },
    () => Boolean(tasks?.read().tasks.some(t => t.status === 'running') || workflows?.read().runs.some(r => r.status === 'running') || im?.isSending() || evolution?.isRunning() || recording?.isRunning() || assistant?.isRunning()),
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
  handle('assistant', () => assistant!.read());
  handle('assistant-create', id => assistant!.createChat(id));
  handle('assistant-send', input => assistant!.send(input));
  handle('assistant-cancel', id => assistant!.cancel(id));
  handle('assistant-read', id => assistant!.markRead(id));
  handle('assistant-feedback', input => assistant!.feedback(input));
  const feedbackImage = (bytes: Uint8Array) => {
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 5 * 1024 * 1024) throw new Error('请选择5MB以内的截图文件');
    let image = nativeImage.createFromBuffer(Buffer.from(bytes)); if (image.isEmpty()) throw new Error('截图格式无效');
    const size = image.getSize(), scale = Math.min(1, 1600 / Math.max(size.width, size.height));
    if (scale < 1) image = image.resize({ width: Math.round(size.width * scale), height: Math.round(size.height * scale) });
    const png = image.toPNG(); if (png.length > 2 * 1024 * 1024) throw new Error('截图压缩后仍超过2MB');
    return `data:image/png;base64,${png.toString('base64')}`;
  };
  handle('assistant-import-image', feedbackImage);
  handle('assistant-image', async () => {
    const result = await dialog.showOpenDialog(window!, { title: '选择反馈截图（仅本机保存）', filters: [{ name: '截图', extensions: ['png', 'jpg', 'jpeg', 'webp'] }], properties: ['openFile'] });
    if (result.canceled) return null;
    const file = result.filePaths[0], stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 5 * 1024 * 1024) throw new Error('请选择5MB以内的截图文件');
    return feedbackImage(fs.readFileSync(file));
  });
  handle('assistant-export-feedback', async id => {
    const record = assistant!.feedbackRecord(id);
    const result = await dialog.showSaveDialog(window!, { title: '导出本机反馈记录', defaultPath: `Soul反馈-${record.id}.json`, filters: [{ name: '反馈记录', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) return false;
    fs.writeFileSync(result.filePath, JSON.stringify(record, null, 2), { mode: 0o600 }); return true;
  });
  handle('evolution', id => evolution!.read(id));
  handle('evolution-configure', (id, revision, enabled) => evolution!.configure(id, revision, enabled));
  handle('evolution-allow', (id, key, enabled) => evolution!.allow(id, key, enabled));
  handle('evolution-generate', input => evolution!.generate(input));
  handle('evolution-resolve', (id, updated, content, accepted) => evolution!.resolve(id, updated, content, accepted));
  handle('evolution-cancel', id => evolution!.cancel(id));
  const capturePermission = () => process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : ['win32', 'linux'].includes(process.platform) ? 'system-picker' : 'unsupported';
  let captureArm: { sourceId: string; id: string; expires: number } | undefined;
  window.webContents.session.setDisplayMediaRequestHandler(async (request, callback) => {
    const arm = captureArm; captureArm = undefined;
    if (!arm || arm.expires < Date.now() || request.frame !== window?.webContents.mainFrame || request.frame.url.split('#')[0] !== pageUrl || request.audioRequested || recording?.get(arm.id).state !== 'capturing') { callback(null); return; }
    try { const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 0, height: 0 } }); const source = sources.find(item => item.id === arm.sourceId); callback(source ? { video: source } : null); }
    catch { callback(null); }
  });
  handle('learning-read', (kind, id) => recording!.read(kind, id, capturePermission()));
  handle('learning-configure', (id, revision, enabled) => { captureArm = undefined; recording!.configure(id, revision, enabled); });
  handle('learning-create', input => recording!.create(input));
  handle('learning-source', id => recording!.source(id));
  handle('learning-text', async () => {
    const result = await dialog.showOpenDialog(window!, { title: '选择已授权学习资料', filters: [{ name: '文字资料', extensions: ['md', 'txt', 'json'] }], properties: ['openFile'] });
    if (result.canceled) return null; const file = result.filePaths[0], stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 150000 || !/\.(?:md|txt|json)$/i.test(file)) throw new Error('请选择150KB以内的文字资料');
    let content = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    if (/\.json$/i.test(file)) { let value; try { value = JSON.parse(content); } catch { throw new Error('聊天JSON格式无效'); } if (!value || typeof value !== 'object' || !Array.isArray(value.messages) || value.messages.length > 500 || value.messages.some((item: any) => typeof item.text !== 'string' || typeof item.role !== 'string')) throw new Error('聊天JSON须包含messages数组，每条有role/text'); content = value.messages.map((item: any) => `${item.role}: ${item.text}`).join('\n\n'); }
    if (!content.trim() || content.includes('\0') || content.includes('\uFFFD') || content.length > 36000) throw new Error('文字须为有效UTF-8且不超过36000字符'); return { name: path.basename(file), content };
  });
  handle('learning-video', async (id, name, taskId) => { const result = await dialog.showOpenDialog(window!, { title: '选择已授权演示视频', filters: [{ name: 'WebM视频', extensions: ['webm'] }], properties: ['openFile'] }); return result.canceled ? null : recording!.importVideo(id, name, taskId, result.filePaths[0]); });
  handle('learning-media', async id => { const file = recording!.mediaPath(id); if (!fs.existsSync(file) || !fs.statSync(file).size) throw new Error('暂无录制视频'); if (await shell.openPath(file)) throw new Error('无法打开本机视频，请检查系统播放器'); });
  handle('learning-sources', async () => { if (process.platform === 'darwin' && capturePermission() !== 'granted') throw new Error('请在macOS系统设置→隐私与安全性→录屏与系统录音中授权Soul，再重启应用；当前未采集屏幕'); if (capturePermission() === 'unsupported') throw new Error('当前平台不支持本机录制'); return (await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 0, height: 0 } })).map(item => ({ id: item.id, name: item.name })); });
  handle('learning-begin', (id, name, taskId, sourceId, consented) => { if (process.platform === 'darwin' && capturePermission() !== 'granted') throw new Error('系统尚未授权录屏，当前未开始采集'); if (typeof sourceId !== 'string' || !/^(window|screen):[\d:]+$/.test(sourceId)) throw new Error('请选择实际录制窗口或屏幕'); const record = recording!.begin(id, name, taskId, consented); captureArm = { sourceId, id: record, expires: Date.now() + 30000 }; return record; });
  handle('learning-append', (id, bytes) => recording!.append(id, bytes));
  handle('learning-finish', (id, text, frames, duration) => recording!.finish(id, text, frames, duration));
  handle('learning-analyze', (id, revision, model, vision, text, consented) => recording!.analyze(id, revision, model, vision, text, consented));
  handle('learning-resolve', (id, revision, content, role, memory, accepted) => recording!.resolve(id, revision, content, role, memory, accepted));
  handle('learning-cancel', id => { captureArm = undefined; recording!.cancel(id); });
  handle('integrations', scope => ({ connectors: connectors!.read(scope), channels: im!.channels(), sessions: im!.sessions(), events: im!.publicEvents(), imRules: im!.rules(), permissions: scope ? permissions!.read(scope) : defaultPermissions() }));
  handle('connector-save', input => connectors!.save(input));
  handle('connector-connect', id => connectors!.connect(id));
  handle('connector-remove', id => connectors!.remove(id));
  handle('permissions-save', (id, input) => { permissions!.save(id, input); integrationChanged(); });
  handle('im-channel-save', input => im!.saveChannel(input));
  handle('im-channel-remove', id => im!.removeChannel(id));
  handle('im-rule-save', input => im!.saveRule(input));
  handle('im-pair-code', id => im!.sendPairingCode(id));
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
  handle('create', async input => {
    const before = new Set(library!.list().experts.map(expert => expert.id));
    const result = library!.createExpert(input);
    const instance = result.experts.find(expert => !before.has(expert.id));
    if (instance) for (const config of library!.readRole(input.templateId).connectors ?? []) await connectors!.save({ ...config, id: '', expertId: instance.id, mode: 'off', secret: '' });
    return result;
  });
  handle('rename', (id, name) => library!.renameExpert(id, name));
  handle('remove', id => library!.removeExpert(id));
  handle('restore', () => library!.restoreExperts());
  handle('import', token => library!.importExpert(token));
  handle('discard-import', token => library!.discardImport(token));
  handle('save-group', input => library!.saveGroup(input));
  handle('remove-group', id => library!.removeGroup(id));
  handle('create-role', input => library!.createRole(input));
  handle('read-role', id => library!.readRole(id));
  handle('role-skills', () => library!.roleSkills());
  handle('generate-role', input => roleGeneration!.generate(input));
  handle('cancel-role-generation', id => roleGeneration!.cancel(id));
  handle('choose-role-connector', async () => {
    const result = await dialog.showOpenDialog(window!, { properties: ['openFile'], filters: [{ name: '连接器配置', extensions: ['json'] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    const file = result.filePaths[0];
    if (fs.statSync(file).size > 65536) throw new Error('连接器配置不能超过 64 KB');
    let data: unknown;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { throw new Error('连接器配置不是有效 JSON'); }
    return roleConnector(data);
  });
  handle('workflows', () => workflows!.read());
  handle('workflow-save', (id, version, spec, requestId) => workflows!.save(id, version, spec, requestId));
  handle('automation-save', (id, version, input, requestId) => workflows!.saveAutomation(id, version, input, requestId));
  handle('workflow-configure', (id, version, config, requestId) => workflows!.configure(id, version, config, requestId));
  handle('workflow-restore', (id, version, target, requestId) => workflows!.restore(id, version, target, requestId));
  handle('workflow-remove', (id, requestId) => workflows!.remove(id, requestId));
  handle('workflow-restore-removed', (requestId, automationOnly) => workflows!.restoreRemoved(requestId, automationOnly === true));
  handle('workflow-run', (id, input, requestId) => workflows!.run(id, input, requestId));
  handle('workflow-resume', (id, requestId) => workflows!.resume(id, requestId));
  handle('workflow-cancel', (id, requestId) => workflows!.cancel(id, requestId));
  handle('workflow-token', id => workflows!.apiToken(id));
  handle('tasks', () => tasks!.read());
  handle('task-send', input => tasks!.send(input));
  handle('task-review', (id, revision, requestId) => tasks!.review(id, revision, requestId));
  handle('task-directory', async id => {
    const task = taskRepository!.get(id), directory = task.members.find(member => member.expertId === task.expertId)?.directory;
    if (!directory || !fs.statSync(directory).isDirectory()) throw new Error('此任务没有可用的工作目录');
    const error = await shell.openPath(directory); if (error) throw new Error('无法打开任务工作目录');
  });
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
  handle('capabilities', scope => resources!.capabilities.read(scope));
  handle('capability', key => resources!.capabilities.detail(key));
  handle('capability-configure', (key, revision, state) => resources!.capabilities.configure(key, revision, state));
  handle('capability-import', (content, kind) => resources!.capabilities.import(content, kind));
  handle('capability-file', async kind => {
    if (kind !== 'plugin' && kind !== 'skill') throw new Error('资源类型无效');
    const result = await dialog.showOpenDialog(window!, { properties: ['openFile'], filters: [{ name: kind === 'plugin' ? 'Soul 插件 JSON' : 'Skill Markdown', extensions: kind === 'plugin' ? ['json'] : ['md'] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    const file = result.filePaths[0];
    if (fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile() || fs.statSync(file).size > (kind === 'plugin' ? 1024 * 1024 : 65536)) throw new Error('文件格式或大小不符合要求');
    return { name: path.basename(file), content: fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '') };
  });
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
  handle('expert-settings', (id, name, intro, model, avatar) => library!.saveSettings(id, name, intro, model, avatar));
  handle('profile-file', (id, file) => resources!.readProfileFile(id, file));
  handle('profile-file-save', (id, file, value, revision) => resources!.saveProfileFile(id, file, value, revision));
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
  if (verifyOutput) timer = setTimeout(() => fail(new Error('Installed renderer timed out')), 120_000);
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
  const replica = await verifyReplica(window, page, verifyOutput, app.getPath('userData'), status.persistenceRun);
  if (timer) clearTimeout(timer);
  const ok = app.isPackaged && status.checks.every(check => check.ok);
  console.log(JSON.stringify({ ok, checks: status.checks, replicaChecks: replica.replicaRenderChecks.length }));
  fs.writeFileSync(verifyOutput, JSON.stringify({
    ok, packaged: app.isPackaged, execPath: process.execPath, resourcesPath: process.resourcesPath,
    userData: app.getPath('userData'), host: { platform: os.platform(), release: os.release(), arch: os.arch() },
    versions: process.versions, ...replica, status,
  }, null, 2));
  closeLibrary();
  app.exit(ok ? 0 : 1);
}).catch(fail);
app.on('window-all-closed', () => app.quit());
app.on('will-quit', closeLibrary);
app.on('will-quit', () => updater?.close());
