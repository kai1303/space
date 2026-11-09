const { contextBridge, ipcRenderer } = require('electron');
if (process.isMainFrame) contextBridge.exposeInMainWorld('spaceDesktop', {
  pair: (provider, code) => ipcRenderer.invoke('pair-local-agent', provider, code),
});
