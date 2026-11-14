const { contextBridge, ipcRenderer } = require('electron');
if (process.isMainFrame) contextBridge.exposeInMainWorld('spaceDesktop', {
  browserAccountChanged: id => ipcRenderer.send('space-browser-account', id),
  onBrowserSidekick: fn => {
    const handler = (_event, tab) => fn(tab);
    ipcRenderer.on('space-browser-sidekick', handler);
    return () => ipcRenderer.removeListener('space-browser-sidekick', handler);
  },
  browserSessionId: (tab, workspace) => ipcRenderer.invoke('space-browser-session', tab, workspace),
  dismissBrowserSidekick: tab => ipcRenderer.send('space-browser-dismiss-sidekick', tab),
  onOfficePicker: fn => {
    const handler = () => fn();
    ipcRenderer.on('space-office-picker', handler);
    return () => ipcRenderer.removeListener('space-office-picker', handler);
  },
  openOffice: (kind, id) => ipcRenderer.invoke('space-office-open', kind, id),
  openWorkspacePanel: () => ipcRenderer.send('space-browser-open'),
  hideWorkspacePanel: () => ipcRenderer.send('space-browser-hide'),
  openBrowser: () => ipcRenderer.send('space-browser-open'),
  pair: (provider, code) => ipcRenderer.invoke('pair-local-agent', provider, code),
});

if (process.isMainFrame) window.addEventListener('DOMContentLoaded', () => {
  const root = document.documentElement;
  const syncTheme = () => ipcRenderer.send('space-browser-theme', root.dataset.theme === 'light' ? 'light' : 'dark');
  new MutationObserver(syncTheme).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  syncTheme();
}, { once: true });
