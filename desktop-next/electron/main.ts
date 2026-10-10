import { app, BrowserWindow, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { probeRuntime } from './runtime-probe';

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

const fail = (error: unknown) => {
  const detail = error instanceof Error ? error.stack : String(error);
  if (verifyOutput) {
    fs.mkdirSync(path.dirname(verifyOutput), { recursive: true });
    fs.writeFileSync(verifyOutput, JSON.stringify({ ok: false, error: detail, execPath: process.execPath }, null, 2));
  } else console.error(detail);
  app.exit(1);
};
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

app.whenReady().then(async () => {
  const resourceRoot = app.isPackaged ? path.join(process.resourcesPath, 'soul-resources') : path.join(app.getAppPath(), 'build/resources');
  const status = probeRuntime(resourceRoot, app.getPath('userData'), app.getVersion());
  const page = path.join(__dirname, '../dist/index.html');
  const pageUrl = pathToFileURL(page).href;
  window = new BrowserWindow({
    width: 1440, height: 900, minWidth: 960, minHeight: 600,
    backgroundColor: '#ffffff', show: false, title: 'Soul Next', enableLargerThanScreen: Boolean(verifyOutput),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  ipcMain.handle('soul-next:status', event => {
    if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== pageUrl) throw new Error('Untrusted IPC sender');
    return status;
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
  for (const [width, height] of [[1440, 900], [1280, 800]]) {
    window.setContentSize(width, height);
    await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const rendered = await window.webContents.executeJavaScript(`({
      width: innerWidth, height: innerHeight, title: document.querySelector('h1')?.textContent,
      cards: document.querySelectorAll('[data-expert-id]').length,
      railWidth: document.querySelector('nav')?.getBoundingClientRect().width,
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
  if (timer) clearTimeout(timer);
  const ok = app.isPackaged && status.checks.every(check => check.ok);
  fs.writeFileSync(verifyOutput, JSON.stringify({
    ok, packaged: app.isPackaged, execPath: process.execPath, resourcesPath: process.resourcesPath,
    userData: app.getPath('userData'), host: { platform: os.platform(), release: os.release(), arch: os.arch() },
    versions: process.versions, renderChecks, status,
  }, null, 2));
  app.exit(ok ? 0 : 1);
}).catch(fail);
app.on('window-all-closed', () => app.quit());
