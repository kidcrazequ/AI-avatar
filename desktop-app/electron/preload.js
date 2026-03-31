import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('electronAPI', {
    ping: () => ipcRenderer.invoke('ping'),
    loadAvatar: (avatarId) => ipcRenderer.invoke('load-avatar', avatarId),
});
