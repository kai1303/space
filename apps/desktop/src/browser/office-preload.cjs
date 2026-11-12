const { contextBridge, ipcRenderer } = require('electron');

if (process.isMainFrame) contextBridge.exposeInMainWorld('spaceOffice', {
  ask: (goal, selection, key) => ipcRenderer.invoke('office-agent', goal, selection, key),
  cancel: () => ipcRenderer.send('office-agent-cancel'),
  openFile: id => ipcRenderer.invoke('office-open-file', id),
  onClose: fn => {
    const handler = () => fn(() => ipcRenderer.send('office-closed'));
    ipcRenderer.on('office-request-close', handler);
    ipcRenderer.send('office-close-ready', true);
    return () => {
      ipcRenderer.removeListener('office-request-close', handler);
      ipcRenderer.send('office-close-ready', false);
    };
  },
});
