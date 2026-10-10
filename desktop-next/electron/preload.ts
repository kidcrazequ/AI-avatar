import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI } from '../shared/contracts';

const api: DesktopAPI = {
  readStatus: () => ipcRenderer.invoke('soul-next:status'),
  readLibrary: () => ipcRenderer.invoke('soul-next:library'),
  readExpert: id => ipcRenderer.invoke('soul-next:expert', id),
  readArchive: (id, file) => ipcRenderer.invoke('soul-next:archive', id, file),
  installExpert: id => ipcRenderer.invoke('soul-next:install', id),
  createExpert: input => ipcRenderer.invoke('soul-next:create', input),
  renameExpert: (id, name) => ipcRenderer.invoke('soul-next:rename', id, name),
  removeExpert: id => ipcRenderer.invoke('soul-next:remove', id),
  restoreExperts: () => ipcRenderer.invoke('soul-next:restore'),
  chooseExpertImport: () => ipcRenderer.invoke('soul-next:choose-import'),
  importExpert: token => ipcRenderer.invoke('soul-next:import', token),
  discardImport: token => ipcRenderer.invoke('soul-next:discard-import', token),
  saveGroup: input => ipcRenderer.invoke('soul-next:save-group', input),
  removeGroup: id => ipcRenderer.invoke('soul-next:remove-group', id),
  createRole: input => ipcRenderer.invoke('soul-next:create-role', input),
  chooseAvatar: () => ipcRenderer.invoke('soul-next:choose-avatar'),
  chooseRoleText: () => ipcRenderer.invoke('soul-next:choose-role-text'),
  saveRoleTemplate: () => ipcRenderer.invoke('soul-next:save-role-template'),
  chooseDirectory: () => ipcRenderer.invoke('soul-next:choose-directory'),
};
contextBridge.exposeInMainWorld('soulDesktop', api);
