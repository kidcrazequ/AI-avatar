import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { SoulLoader } from './soul-loader';
let mainWindow = null;
// 初始化 Soul 加载器
const avatarsPath = path.join(app.getPath('userData'), '../../../avatars');
const soulLoader = new SoulLoader(avatarsPath);
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    // 开发环境加载 Vite 服务器
    if (process.env.NODE_ENV === 'development') {
        mainWindow.loadURL('http://localhost:5173');
        mainWindow.webContents.openDevTools();
    }
    else {
        // 生产环境加载打包后的文件
        mainWindow.loadFile(path.join(__dirname, '../dist-electron/index.html'));
    }
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}
app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});
// IPC 处理器
ipcMain.handle('ping', () => 'pong');
// 加载分身配置
ipcMain.handle('load-avatar', async (_, avatarId) => {
    return soulLoader.loadAvatar(avatarId);
});
