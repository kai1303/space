const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('browserBar', {
  command: (action, arg) => ipcRenderer.invoke('browser-command', action, arg),
  onState: fn => ipcRenderer.on('browser-state', (_event, state) => fn(state)),
  onAddressFocus: fn => ipcRenderer.on('browser-address-focus', () => fn()),
});
