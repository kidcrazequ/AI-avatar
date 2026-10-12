const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 360, height: 320, webPreferences: { backgroundThrottling: false } });
  try {
    await win.loadFile(path.resolve(process.argv[2]));
    const checks = await win.webContents.executeJavaScript('window.verifyOrb()');
    const output = path.resolve(process.argv[3]);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify({ checks }, null, 2));
    console.log(`${checks.length} particle lifecycle checks passed in Chromium`);
    win.destroy(); app.exit(0);
  } catch (error) { console.error(error); win.destroy(); app.exit(1); }
});
