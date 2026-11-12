const { contextBridge, ipcRenderer } = require('electron');

if (process.isMainFrame) contextBridge.exposeInMainWorld('spaceOffice', {
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
