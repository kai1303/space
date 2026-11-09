const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('signIn', {
  output: callback => ipcRenderer.on('login-output', (_event, text) => callback(text)),
  input: text => ipcRenderer.send('login-input', text),
});
