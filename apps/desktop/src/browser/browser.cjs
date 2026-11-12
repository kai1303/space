const { app, WebContentsView, View, systemPreferences, session, dialog } = require('electron');
const { createHash } = require('node:crypto');
const { join } = require('node:path');
const { runBrowserTask, runOfficeTask } = require('./agent.cjs');

const { isAssetDownload } = require('../policy.cjs');
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const maxTabs = 12;
const dividerWidth = 8;
const minPaneWidth = 320;
const paneTransitionMs = 300;
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
  let full = false, splitRatio, navigationWidth = 0, theme = 'dark';
  let currentActor, profile, toolbar, active, task, visible = false, ready = false, barHeight = 64;
  let officeTask;
  let generation = 0, opening = false, notice = '';
  let frameTimer, closingTab;
  const tabs = new Map();
  const pane = new View();
  pane.setVisible(false);
  win.contentView.addChildView(pane);
  function splitWidth(width) {
    const zoom = owner.getZoomFactor();
    // Share the area after Space's navigation between the conversation and browser.
    // Keep chat above its 720 CSS pixel mobile breakpoint when both panes fit.
    const desktopMinimum = navigationWidth ? Math.ceil(721 * zoom) : minPaneWidth;
    const preferred = splitRatio === undefined
      ? Math.max(desktopMinimum, Math.round((width - dividerWidth + navigationWidth * zoom) / 2))
      : Math.round(width * splitRatio);
    return Math.max(minPaneWidth, Math.min(width - dividerWidth - minPaneWidth, preferred));
  }
  function state() {
    const [width] = win.getContentSize();
    const tab = tabs.get(active);
    return { theme, tool: tab ? (tab.officePath ? 'office' : 'browser') : null, newTab: !!tab && !tab.url && !tab.popup, tabs: [...tabs].map(([id, tab]) => ({ id, tool: tab.officePath ? 'office' : 'browser', title: tab.title || 'Browser' })), active, full, splitWidth: splitWidth(width), minSplit: minPaneWidth, maxSplit: width - dividerWidth - minPaneWidth, notice, controlling: !!task,
      url: tabs.get(active)?.url || '', back: !!tabs.get(active)?.view.webContents.navigationHistory.canGoBack(),
      forward: !!tabs.get(active)?.view.webContents.navigationHistory.canGoForward(), maxTabs };
  }
  function publish() {
    if (visible && ready && !win.isDestroyed() && toolbar && !toolbar.webContents.isDestroyed()) toolbar.webContents.send('browser-state', state());
  }
  function layoutGuest() {
    const { width, height } = toolbar.getBounds();
    const gutter = full ? 0 : dividerWidth;
    tabs.get(active)?.view.setBounds({ x: gutter, y: barHeight, width: Math.max(0, width - gutter), height: Math.max(0, height - barHeight) });
  }
  function releaseTab(tab) {
    if (!win.isDestroyed()) pane.removeChildView(tab.view);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close({ waitForBeforeUnload: false });
  }
  function layout(transition = false) {
    clearTimeout(frameTimer);
    frameTimer = undefined;
    if (closingTab) { releaseTab(closingTab); closingTab = undefined; }
    if (win.isDestroyed()) return;
    const [width, height] = win.getContentSize();
    const shown = visible && ready;
    const target = shown ? (full ? 0 : splitWidth(width)) : width;
    const start = pane.getVisible() ? pane.getBounds().x : width;
    // Slide the guest at its settled size. Only the workspace reflows as the
    // divider moves, and a reversal starts at the last displayed position.
    const paneWidth = shown ? width - target : pane.getBounds().width;
    const animate = transition && (shown || pane.getVisible()) && start !== target &&
      win.isVisible() && !systemPreferences.getAnimationSettings().prefersReducedMotion;
    if (shown) {
      toolbar.setBounds({ x: 0, y: 0, width: paneWidth, height });
      layoutGuest();
    }
    const started = performance.now();
    const travel = Math.abs(target - start);
    const duration = paneTransitionMs * Math.sqrt(Math.min(1, travel / Math.max(1, paneWidth)));
    function draw() {
      const progress = animate ? Math.min(1, (performance.now() - started) / duration) : 1;
      const eased = (1 - Math.cos(Math.PI * progress)) / 2;
      const x = Math.round(start + (target - start) * eased);
      const moving = progress < 1;
      workspace.setVisible(x > 0 || !shown);
      workspace.setBounds({ x: 0, y: 0, width: x, height });
      pane.setBounds({ x, y: 0, width: paneWidth, height });
      pane.setVisible(shown || moving);
      if (moving) {
        frameTimer = setTimeout(draw, 1000 / 60);
      } else {
        frameTimer = undefined;
        if (closingTab) { releaseTab(closingTab); closingTab = undefined; }
      }
    }
    draw();
  }
  function stop(message = '') {
    if (task) { clearTimeout(task.timer); task.controller.abort(); task = undefined; }
    notice = message;
    publish();
  }
  function hide(withMotion = true) {
    officeTask?.abort();
    if (!toolbar) return;
    const slide = withMotion && visible && ready;
    visible = false;
    full = false;
    stop();
    if (!owner.isDestroyed()) owner.focus();
    layout(slide);
  }
  function select(id, enter = false) {
    if (!tabs.has(id)) return;
    if (id !== active) { officeTask?.abort(); stop(); }
    active = id;
    for (const [key, tab] of tabs) tab.view.setVisible(visible && key === active && (!!tab.url || tab.popup));
    layout(enter); publish();
  }
  function remove(id) {
    const tab = tabs.get(id);
    if (!tab) return;
    if (id === active) officeTask?.abort();
    tabs.delete(id);
    if (id === active) {
      active = undefined;
      if (tabs.size) select([...tabs.keys()].at(-1)); else hide();
    }
    if (frameTimer && !tabs.size) closingTab = tab;
    else releaseTab(tab);
    publish();
  }
  function reset() {
    generation++;
    hide(false);
    for (const id of [...tabs.keys()]) remove(id);
    if (toolbar) {
      if (!win.isDestroyed()) pane.removeChildView(toolbar);
      if (!toolbar.webContents.isDestroyed()) toolbar.webContents.close();
    }
    profile?.removeListener('will-download', handleDownload);
    toolbar = profile = currentActor = undefined;
    ready = false;
  }
  function add(popupContents, enter = false, officePath) {
    if (tabs.size >= maxTabs) throw new Error('Close a tab before opening another.');
    const view = new WebContentsView({ ...(popupContents && { webContents: popupContents }), webPreferences: { ...isolated, disableDialogs: true,
      session: officePath ? owner.session : profile,
      ...(officePath && { preload: join(__dirname, 'office-preload.cjs') }) } });
    const guest = view.webContents, id = guest.id;
    const tab = { view, officePath, title: officePath ? 'Office editor' : '', url: officePath || '', popup: !!popupContents };
    tabs.set(id, tab);
    const manualInput = (_event, input) => {
      if (task && active === id && ['keyDown', 'mouseDown'].includes(input.type)) stop('You have control.');
    };
    guest.on('before-input-event', manualInput);
    guest.on('before-mouse-event', manualInput);
    guest.on('will-attach-webview', e => e.preventDefault());
    if (officePath) {
      const trusted = event => event.senderFrame === guest.mainFrame && guest.getURL() === origin + officePath;
      guest.ipc.handle('office-open-file', (event, id) =>
        trusted(event) && uuid.test(id) && openOffice('file', id));
      guest.ipc.handle('office-agent', async (event, goal, selection, key) => {
        if (!trusted(event) || !visible || active !== id || officeTask || !officePath.startsWith('/office/file/')
          || typeof goal !== 'string' || !goal.trim() || goal.length > 1000 || typeof key !== 'string' || key.length > 160
          || typeof selection !== 'string' || !selection.trim() || selection.length > 16000) throw new Error('Office task unavailable.');
        const controller = new AbortController();
        officeTask = controller;
        try {
          const fileId = officePath.slice('/office/file/'.length);
          const authorized = async () => {
            const response = await owner.session.fetch(origin + '/v1/assets/' + fileId + '/office-session?mode=edit',
              { credentials: 'include', cache: 'no-store', redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(6000)]) });
            if (!response.ok) {
              await response.body?.cancel();
              throw new Error('Editing access changed.');
            }
            const { config } = await response.json();
            if (config?.document?.key !== key || config.editorConfig?.mode !== 'edit' || config.editorConfig.user?.id !== currentActor
              || !trusted(event) || active !== id || !visible || controller.signal.aborted) throw new Error('Editing access changed.');
          };
          await authorized();
          const directory = app.isPackaged ? join(process.resourcesPath, 'runner') : join(__dirname, '../../dist/runner');
          const result = await runOfficeTask(goal, selection, controller.signal, join(directory, 'office-mcp.mjs'));
          await authorized();
          return result;
        } finally { if (officeTask === controller) officeTask = undefined; }
      });
      guest.ipc.on('office-agent-cancel', event => { if (trusted(event) && active === id) officeTask?.abort(); });
      guest.ipc.on('office-close-ready', (event, ready) => { if (trusted(event)) tab.closeReady = ready === true; });
      guest.ipc.on('office-closed', event => { if (trusted(event)) remove(id); });
    }
    const guard = (e, url, main) => {
      if (officePath && main && url !== origin + officePath) {
        e.preventDefault();
        if (isAssetDownload(url, origin)) guest.downloadURL(url);
        return;
      }
      if (!webAddress(url) && url !== 'about:blank' && !(url === 'about:srcdoc' && !main)) { e.preventDefault(); return; }
      if (main && task && active === id && new URL(url).origin !== task.origin) {
        e.preventDefault(); stop('Site changed. You have control.');
      }
    };
    guest.on('will-frame-navigate', e => guard(e, e.url, e.isMainFrame));
    guest.on('will-redirect', e => guard(e, e.url, e.isMainFrame));
    guest.setWindowOpenHandler(({ url }) => {
      if (officePath || !visible || active !== id || task || tabs.size >= maxTabs || (!webAddress(url) && url !== 'about:blank')) return { action: 'deny' };
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
    if (officePath) void guest.loadURL(origin + officePath).catch(() => stop('Could not open the Office editor.'));
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
    if (tabs.get(active)?.officePath && ['go', 'agent', 'reload', 'back', 'forward'].includes(action)) return;
    switch (action) {
      case 'office': owner.send('space-office-picker'); break;
      case 'new': add(); break;
      case 'switch': select(arg); break;
      case 'close': {
        const tab = tabs.get(arg);
        if (tab?.officePath?.startsWith('/office/file/') && tab.view.webContents.getURL() === origin + tab.officePath &&
            !tab.view.webContents.isCrashed() && tab.closeReady) {
          select(arg);
          tab.view.webContents.send('office-request-close');
        } else remove(arg);
        break;
      }
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
  function openOffice(kind, id) {
    if (typeof id !== 'string' || !uuid.test(id) || !['file', 'library'].includes(kind)) return false;
    return open(false, '/office/' + kind + '/' + id);
  }
  async function open(newTab = false, officePath) {
    if (opening || win.isDestroyed()) return;
    opening = true;
    const version = generation;
    try {
      if (!visible && !pane.getVisible() && splitRatio === undefined) {
        navigationWidth = await owner.executeJavaScript(`Array.from(document.querySelectorAll('.chat-rail, .chat-sidebar'))
          .filter(element => !['fixed', 'absolute'].includes(getComputedStyle(element).position))
          .reduce((width, element) => width + element.getBoundingClientRect().width, 0)`);
      }
      const response = await owner.session.fetch(origin + '/v1/me', { credentials: 'include', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(6000) });
      if (version !== generation || win.isDestroyed()) return false;
      if (response.status === 401 || response.status === 403) {
        reset();
        void dialog.showMessageBox(win, { message: 'Sign in to Space to open the side panel.' });
        return false;
      }
      if (!response.ok) throw new Error();
      const { id } = await response.json();
      if (typeof id !== 'string' || !id || id.length > 128) throw new Error();
      if (version !== generation || win.isDestroyed()) return;
      if (currentActor && id !== currentActor) reset();
      currentActor = id;
      if (!toolbar) createToolbar(id);
      const enter = !visible;
      visible = true; toolbar.setVisible(true);
      if (officePath) {
        const existing = [...tabs].find(([, tab]) => tab.officePath === officePath);
        if (existing) select(existing[0], enter);
        else if (tabs.size < maxTabs) add(undefined, enter, officePath);
        else { stop('Close a tab before opening another.'); return false; }
        tabs.get(active).view.webContents.focus();
        return true;
      }
      if (newTab && tabs.size < maxTabs) add(undefined, enter);
      else if (active) select(active, enter);
      else { layout(enter); publish(); }
      const selected = tabs.get(active);
      if (selected?.url) selected.view.webContents.focus();
      else {
        toolbar.webContents.focus();
        if (ready && selected) toolbar.webContents.send('browser-address-focus');
      }
    } catch {
      if (version !== generation || win.isDestroyed()) return;
      if ([...tabs.values()].some(tab => tab.officePath)) {
        stop('Could not verify your Space session. Try opening the file again.');
        return false;
      }
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
  owner.on('did-start-navigation', (_e, _url, inPage, main) => { if (main && !inPage) { generation++; hide(false); } });
  owner.on('render-process-gone', reset);
  win.on('resize', () => { layout(); publish(); });
  layout();
  win.once('closed', () => { cookies.off('changed', cookieChanged); reset(); });
  function togglePanel() {
    if (!visible) return open();
    if (full) return hide();
    full = true; layout(true); publish();
  }
  return { open, openOffice, hide, togglePanel,
    showPanel() { if (!visible) return open(); },
    hidePanel() {
      if (opening) generation++; // A pending session check must not reopen the panel.
      hide();
    },
    accountChanged(actor) {
    // Renderer notifications can revoke access. Only the authenticated /me response opens a profile.
    if (currentActor && actor !== currentActor) reset();
    else if (opening && (!actor || actor !== currentActor)) generation++;
  } };
}
module.exports = { createBrowser };
