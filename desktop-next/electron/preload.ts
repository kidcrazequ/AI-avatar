import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI } from '../shared/contracts';

const api: DesktopAPI = { readStatus: () => ipcRenderer.invoke('soul-next:status') };
contextBridge.exposeInMainWorld('soulDesktop', api);
