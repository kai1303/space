const { contextBridge, ipcRenderer } = require('electron');
if (process.isMainFrame) contextBridge.exposeInMainWorld('spaceDesktop', {
  browserAccountChanged: id => ipcRenderer.send('space-browser-account', id),
  ...(process.platform === 'darwin' && { listVaultItems: actor => ipcRenderer.invoke('space-vault-items', actor),
    vaultItemRequest: (actor, change) => ipcRenderer.invoke('space-vault-item-request', actor, change),
    saveLinearToken: (actor, title, token) => ipcRenderer.invoke('space-vault-save-linear', actor, title, token),
    onVaultLocked: fn => {
      const handler = () => fn();
      ipcRenderer.on('space-vault-locked', handler);
      return () => ipcRenderer.removeListener('space-vault-locked', handler);
    },
    onVaultPage: fn => {
      const handler = () => fn();
      ipcRenderer.on('space-vault-page', handler);
      return () => ipcRenderer.removeListener('space-vault-page', handler);
    },
    openVault: actor => ipcRenderer.invoke('space-vault-open', actor), saveBrowserVaultToken: endpoint => ipcRenderer.invoke('space-browser-save-token', endpoint) }),
  onBrowserMcpSetup: fn => {
    const handler = (_event, site) => fn(site);
    ipcRenderer.on('space-browser-connect-mcp', handler);
    return () => ipcRenderer.removeListener('space-browser-connect-mcp', handler);
  },
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
