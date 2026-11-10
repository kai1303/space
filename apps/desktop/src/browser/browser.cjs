const { WebContentsView, View, systemPreferences, session, dialog } = require('electron');
const { createHash } = require('node:crypto');
const { join } = require('node:path');
const { runBrowserTask } = require('./agent.cjs');

const maxTabs = 12;
const dividerWidth = 8;
const minPaneWidth = 320;
const isolated = { sandbox: true, contextIsolation: true, webSecurity: true, nodeIntegration: false, webviewTag: false };
function webAddress(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 8192) return;
  try {
    const url = new URL(input);
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch {}
}

function createBrowser(win, base, workspace) {
  const origin = new URL(base).origin;
  const owner = win.webContents;
  let full = false, splitRatio = 0.5, theme = 'dark';
  let currentActor, profile, toolbar, active, task, visible = false, ready = false, barHeight = 64;
  let generation = 0, opening = false, notice = '';
  let lastLayoutAnimated = false;
  const tabs = new Map();
  const pane = new View();
  pane.setVisible(false);
  win.contentView.addChildView(pane);
  function splitWidth(width) {
    return Math.max(minPaneWidth, Math.min(width - dividerWidth - minPaneWidth, Math.round(width * splitRatio)));
  }
  function state() {
    const [width] = win.getContentSize();
    const tab = tabs.get(active);
    return { theme, newTab: !!tab && !tab.url && !tab.popup, tabs: [...tabs].map(([id, tab]) => ({ id, title: tab.title || 'New tab' })), active, full, splitWidth: splitWidth(width), minSplit: minPaneWidth, maxSplit: width - dividerWidth - minPaneWidth, notice, controlling: !!task,
      url: tabs.get(active)?.url || '', back: !!tabs.get(active)?.view.webContents.navigationHistory.canGoBack(),
      forward: !!tabs.get(active)?.view.webContents.navigationHistory.canGoForward(), maxTabs };
  }
  function publish() {
    if (ready && !win.isDestroyed() && toolbar && !toolbar.webContents.isDestroyed()) toolbar.webContents.send('browser-state', state());
  }
  function layoutGuest() {
    const { width, height } = toolbar.getBounds();
    const gutter = full ? 0 : dividerWidth;
    tabs.get(active)?.view.setBounds({ x: gutter, y: barHeight, width: Math.max(0, width - gutter), height: Math.max(0, height - barHeight) });
  }
  function layout(enter = false) {
    if (win.isDestroyed()) return;
    const [width, height] = win.getContentSize();
    const shown = visible && ready;
    const split = shown && !full;
    const left = split ? splitWidth(width) : 0;
    const bounds = { x: left, y: 0, width: width - left, height };
    const animate = enter && split && win.isVisible() && !systemPreferences.getAnimationSettings().prefersReducedMotion;
    // A direct setBounds doesn't cancel an in-flight native layer animation.
    const preempt = lastLayoutAnimated && !animate;
    const options = { animate: animate || preempt ? { duration: animate ? 220 : 0, easing: 'ease-out' } : false };
    lastLayoutAnimated = animate;
    if (animate) pane.setBounds({ ...bounds, x: width });
    pane.setVisible(shown);
    workspace.setVisible(!shown || split);
    workspace.setBounds({ x: 0, y: 0, width: split ? left : width, height }, options);
    if (shown || preempt) pane.setBounds(bounds, options);
    if (!shown) return;
    toolbar.setBounds({ ...bounds, x: 0 });
    layoutGuest();
  }
  function stop(message = '') {
    if (task) { clearTimeout(task.timer); task.controller.abort(); task = undefined; }
    notice = message;
    publish();
  }
  function hide() {
    if (!toolbar) return;
    stop(); visible = false; full = false;
    for (const tab of tabs.values()) tab.view.setVisible(false);
    toolbar.setVisible(false);
    layout();
    if (!owner.isDestroyed()) owner.focus();
  }
  function select(id, enter = false) {
    if (!tabs.has(id)) return;
    if (id !== active) stop();
    active = id;
    for (const [key, tab] of tabs) tab.view.setVisible(visible && key === active && (!!tab.url || tab.popup));
    layout(enter); publish();
  }
  function remove(id) {
    const tab = tabs.get(id);
    if (!tab) return;
    tabs.delete(id);
    if (id === active) {
      stop();
      active = undefined;
      if (tabs.size) select([...tabs.keys()].at(-1)); else hide();
    }
    if (!win.isDestroyed()) pane.removeChildView(tab.view);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close({ waitForBeforeUnload: false });
    publish();
  }
  function reset() {
    generation++;
    hide();
    for (const id of [...tabs.keys()]) remove(id);
    if (toolbar) {
      if (!win.isDestroyed()) pane.removeChildView(toolbar);
      if (!toolbar.webContents.isDestroyed()) toolbar.webContents.close();
    }
    profile?.removeListener('will-download', handleDownload);
    toolbar = profile = currentActor = undefined;
    ready = false;
  }
  function add(popupContents, enter = false) {
    if (tabs.size >= maxTabs) throw new Error('Close a tab before opening another.');
    const view = new WebContentsView({ ...(popupContents && { webContents: popupContents }), webPreferences: { ...isolated, disableDialogs: true, session: profile } });
    const guest = view.webContents, id = guest.id;
    const tab = { view, title: '', url: '', popup: !!popupContents };
    tabs.set(id, tab);
    const manualInput = (_event, input) => {
      if (task && active === id && ['keyDown', 'mouseDown'].includes(input.type)) stop('You have control.');
    };
    guest.on('before-input-event', manualInput);
    guest.on('before-mouse-event', manualInput);
    guest.on('will-attach-webview', e => e.preventDefault());
    const guard = (e, url, main) => {
      if (!webAddress(url) && url !== 'about:blank' && !(url === 'about:srcdoc' && !main)) { e.preventDefault(); return; }
      if (main && task && active === id && new URL(url).origin !== task.origin) {
        e.preventDefault(); stop('Site changed. You have control.');
      }
    };
    guest.on('will-frame-navigate', e => guard(e, e.url, e.isMainFrame));
    guest.on('will-redirect', e => guard(e, e.url, e.isMainFrame));
    guest.setWindowOpenHandler(({ url }) => {
      if (!visible || active !== id || task || tabs.size >= maxTabs || (!webAddress(url) && url !== 'about:blank')) return { action: 'deny' };
      return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { ...isolated, disableDialogs: true, session: profile } },
        createWindow: options => add(options.webContents).webContents };
    });
    const updated = () => {
      tab.url = guest.getURL() === 'about:blank' ? '' : guest.getURL();
      view.setVisible(visible && active === id && (!!tab.url || tab.popup));
      tab.title = guest.getTitle() || (webAddress(tab.url) ? new URL(tab.url).hostname : '');
      publish();
    };
    guest.on('did-navigate', updated);
    guest.on('did-navigate-in-page', updated);
    guest.on('page-title-updated', updated);
    guest.on('did-fail-load', (_e, code, _description, _url, main) => {
      if (active === id && main && code !== -3) stop('Could not load this page.');
    });
    guest.on('render-process-gone', () => { if (id === active) stop('Page stopped. Reload to continue.'); });
    guest.on('destroyed', () => remove(id));
    pane.addChildView(view);
    select(id, enter);
    return view;
  }
  function begin(goal) {
    const guest = tabs.get(active)?.view.webContents;
    if (task || !guest || !webAddress(guest.getURL()) || guest.isLoadingMainFrame() || typeof goal !== 'string' || !goal.trim() || goal.length > 1000) throw new Error('Open a page and enter a task first.');
    const controller = new AbortController();
    const grant = { controller, origin: new URL(guest.getURL()).origin, timer: setTimeout(() => stop('Task timed out. You have control.'), 180000) };
    task = grant; notice = ''; publish();
    void runBrowserTask(guest, goal, controller.signal).then(result => {
      if (task === grant) stop(result);
    }, error => {
      if (task === grant) stop(error.message.startsWith('Codex ') ? error.message : 'Agent stopped. The page needs your attention.');
    });
  }
  function command(action, arg) {
    if (!visible) return;
    const guest = tabs.get(active)?.view.webContents;
    switch (action) {
      case 'new': add(); break;
      case 'switch': select(arg); break;
      case 'close': remove(arg); break;
      case 'space': hide(); break;
      case 'layout': full = !full; layout(); publish(); break;
      case 'stop': stop('You have control.'); break;
      case 'agent': begin(arg); break;
      case 'resize':
        if (!full && Number.isFinite(arg)) {
          const [width] = win.getContentSize();
          splitRatio = Math.max(minPaneWidth, Math.min(width - dividerWidth - minPaneWidth, arg)) / width;
          layout(); publish();
        }
        break;
      case 'height':
        if (Number.isInteger(arg) && arg >= 32 && arg <= 300) { barHeight = arg; layoutGuest(); }
        break;
      case 'go': {
        const input = typeof arg === 'string' ? arg.trim() : '';
        const url = webAddress(input) || ((!input.includes(':') || /^[\w.-]+:\d+(?:\/|$)/.test(input)) && webAddress('https://' + input));
        if (!url) throw new Error('Enter an HTTP or HTTPS address.');
        stop(); void guest.loadURL(url).catch(() => {}); guest.focus(); break;
      }
      case 'back': stop(); if (guest.navigationHistory.canGoBack()) guest.navigationHistory.goBack(); break;
      case 'forward': stop(); if (guest.navigationHistory.canGoForward()) guest.navigationHistory.goForward(); break;
      case 'reload': stop(); guest.reload(); break;
    }
  }
  function handleDownload(event, _item, contents) {
    if (task && contents === tabs.get(active)?.view.webContents) {
      event.preventDefault();
      stop('You have control. Start the download yourself.');
    }
  }
  function createToolbar(actor) {
    const hash = createHash('sha256').update(JSON.stringify([origin, actor])).digest('hex');
    profile = session.fromPartition('persist:space-browser-' + hash);
    profile.setPermissionRequestHandler((_contents, _permission, cb) => cb(false));
    profile.setPermissionCheckHandler(() => false);
    profile.setDevicePermissionHandler(() => false);
    profile.on('will-download', handleDownload);
    toolbar = new WebContentsView({ webPreferences: { ...isolated, partition: 'space-browser-toolbar', preload: join(__dirname, 'preload.cjs') } });
    const chrome = toolbar.webContents;
    chrome.setWindowOpenHandler(() => ({ action: 'deny' }));
    chrome.on('will-navigate', e => e.preventDefault());
    chrome.ipc.handle('browser-command', (e, action, arg) => {
      if (e.senderFrame !== chrome.mainFrame) return;
      try { command(action, arg); } catch (error) { notice = error.message; publish(); }
    });
    chrome.on('did-finish-load', () => { ready = true; layout(visible); publish(); });
    pane.addChildView(toolbar);
    void chrome.loadFile(join(__dirname, 'toolbar.html')).catch(() => { if (toolbar?.webContents === chrome) reset(); });
  }
  async function open(newTab = false) {
    if (opening || win.isDestroyed()) return;
    opening = true;
    const version = generation;
    try {
      const response = await owner.session.fetch(origin + '/v1/me', { credentials: 'include', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(6000) });
      if (!response.ok) throw new Error();
      const { id } = await response.json();
      if (typeof id !== 'string' || !id || id.length > 128) throw new Error();
      if (version !== generation || win.isDestroyed()) return;
      if (currentActor && id !== currentActor) reset();
      currentActor = id;
      if (!toolbar) createToolbar(id);
      const enter = !visible;
      visible = true; toolbar.setVisible(true);
      if (!active || (newTab && tabs.size < maxTabs)) add(undefined, enter); else select(active, enter);
      if (ready && (newTab || !tabs.get(active)?.url)) toolbar.webContents.send('browser-address-focus');
      toolbar.webContents.focus();
    } catch {
      if (version !== generation || win.isDestroyed()) return;
      reset();
      void dialog.showMessageBox(win, { message: 'Sign in to Space to open your browser.', detail: 'Space needs a connection to verify your account.' });
    } finally { opening = false; }
  }
  owner.ipc.on('space-browser-theme', (event, value) => {
    if (event.senderFrame !== owner.mainFrame || event.senderFrame.origin !== origin) return;
    if ((value === 'light' || value === 'dark') && value !== theme) { theme = value; publish(); }
  });
  const cookies = owner.session.cookies;
  const cookieChanged = (_e, cookie, cause, removed) => {
    if (removed && cause !== 'overwrite' && /(?:session_token|space\.refresh)$/.test(cookie.name) && new URL(origin).hostname === cookie.domain.replace(/^\./, '')) reset();
  };
  cookies.on('changed', cookieChanged);
  owner.on('did-start-navigation', (_e, _url, inPage, main) => { if (main && !inPage) { generation++; hide(); } });
  owner.on('render-process-gone', reset);
  win.on('resize', () => { layout(); publish(); });
  layout();
  win.once('closed', () => { cookies.off('changed', cookieChanged); reset(); });
  function togglePanel() {
    if (!visible) return open();
    if (!full) return hide();
    full = false; layout(); publish();
  }
  return { open, hide, togglePanel, accountChanged(actor) {
    // Renderer notifications can revoke access. Only the authenticated /me response opens a profile.
    if (currentActor && actor !== currentActor) reset();
    else if (opening && (!actor || actor !== currentActor)) generation++;
  } };
}
module.exports = { createBrowser };
