const { contextBridge, ipcRenderer } = require('electron');
if (process.isMainFrame) contextBridge.exposeInMainWorld('spaceDesktop', {
  browserAccountChanged: id => ipcRenderer.send('space-browser-account', id),
  openBrowser: () => ipcRenderer.send('space-browser-open'),
  pair: (provider, code) => ipcRenderer.invoke('pair-local-agent', provider, code),
});

if (process.isMainFrame) window.addEventListener('DOMContentLoaded', () => {
  const root = document.documentElement;
  const syncTheme = () => ipcRenderer.send('space-browser-theme', root.dataset.theme === 'light' ? 'light' : 'dark');
  new MutationObserver(syncTheme).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  syncTheme();
}, { once: true });
