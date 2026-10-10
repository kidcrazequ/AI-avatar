import { app, BrowserWindow, dialog, ipcMain, nativeImage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { probeRuntime } from './runtime-probe';
import { ExpertLibrary } from './expert-library';
import { ResourceStore } from './resources';
import { verifyResourcePages } from './verify-resources';

const flag = (name: string) => process.argv.find(item => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const verifyOutput = flag('verify-output');
const profile = flag('profile');
if (verifyOutput && !profile) throw new Error('Install verification requires an isolated --profile');
if (profile && !path.isAbsolute(profile)) throw new Error('Profile must be absolute');
app.setName('Soul Next');
app.setPath('userData', profile ?? path.join(app.getPath('appData'), 'SoulNextValidation'));
fs.mkdirSync(app.getPath('userData'), { recursive: true });
let window: BrowserWindow | null = null;
let timer: NodeJS.Timeout | undefined;
let library: ExpertLibrary | undefined;
let resources: ResourceStore | undefined;
const closeLibrary = () => { resources?.close(); resources = undefined; library?.close(); library = undefined; };

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
  const resourceRoot = app.isPackaged ? path.join(process.resourcesPath, 'soul-resources') : path.join(app.getAppPath(), 'build/resources');
  const status = probeRuntime(resourceRoot, app.getPath('userData'), app.getVersion());
  library = new ExpertLibrary(resourceRoot, app.getPath('userData'));
  resources = new ResourceStore(resourceRoot, app.getPath('userData'), library);
  const page = path.join(__dirname, '../dist/index.html');
  const pageUrl = pathToFileURL(page).href;
  window = new BrowserWindow({
    width: 1440, height: 900, minWidth: 960, minHeight: 600,
    backgroundColor: '#ffffff', show: false, title: 'Soul Next', enableLargerThanScreen: Boolean(verifyOutput),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const handle = (channel: string, listener: (...args: any[]) => unknown) => ipcMain.handle(`soul-next:${channel}`, (event, ...args) => {
    if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url.split('#')[0] !== pageUrl) throw new Error('Untrusted IPC sender');
    return listener(...args);
  });
  handle('status', () => status);
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
  if (timer) clearTimeout(timer);
  const ok = app.isPackaged && status.checks.every(check => check.ok);
  console.log(JSON.stringify({ ok, checks: status.checks, renderChecks }));
  fs.writeFileSync(verifyOutput, JSON.stringify({
    ok, packaged: app.isPackaged, execPath: process.execPath, resourcesPath: process.resourcesPath,
    userData: app.getPath('userData'), host: { platform: os.platform(), release: os.release(), arch: os.arch() },
    versions: process.versions, renderChecks, homeRenderChecks, resourceRenderChecks, status,
  }, null, 2));
  closeLibrary();
  app.exit(ok ? 0 : 1);
}).catch(fail);
app.on('window-all-closed', () => app.quit());
app.on('will-quit', closeLibrary);
