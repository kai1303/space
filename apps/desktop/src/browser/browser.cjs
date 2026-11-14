const { app, WebContentsView, View, powerMonitor, systemPreferences, session, dialog } = require('electron');
const { createHash, randomUUID } = require('node:crypto');
const { join } = require('node:path');
const { openVault, fillLogin, presentVault } = require('./vault.cjs');
const { runBrowserTask, runOfficeTask } = require('./agent.cjs');

const { bundledPlugins, labels } = require('./plugins.cjs');
const { isAssetDownload } = require('../policy.cjs');
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const { applicationDomain, discoverMcp } = app.isPackaged
  ? require('../../assets/browser-style/mcp-discovery.cjs')
  : require('./mcp-discovery.cjs');
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

function createBrowser(win, base, workspace, keychain = openVault, vaultManager = presentVault) {
  const origin = new URL(base).origin;
  const owner = win.webContents;
  let full = false, splitRatio, navigationWidth = 0, theme = 'dark';
  let currentActor, profile, toolbar, active, task, visible = false, ready = false, barHeight = 64;
  let officeTask, plugins;
  let generation = 0, opening = false, notice = '';
  let frameTimer, closingTab;
  const tabs = new Map();
  const dismissedSites = new Set();
  const registryCache = new Map();
  let checkedSite, suggestion, lookup, localSetup;

  const vaultResources = app.isPackaged ? join(process.resourcesPath, 'runner') : join(__dirname, '../../dist/runner');
  let vaultOperation, manager;
  function lockVault() {
    manager?.abort(); cancelVault();
    if (!owner.isDestroyed()) owner.send('space-vault-locked');
  }
  async function showVault(target, expectedActor, action = 'manager', presented, remoteSignal) {
    if (process.platform !== 'darwin' || !owner.mainFrame || owner.mainFrame.origin !== origin) return 'unavailable';
    if (manager || vaultOperation) return 'busy';
    const endpoint = target?.origin ? registryCache.get(currentSite())?.site?.url : undefined;
    const operation = manager = new AbortController();
    const abort = () => operation.abort();
    remoteSignal?.addEventListener('abort', abort, {once: true});
    if (remoteSignal?.aborted) operation.abort();
    publish();
    try {
      const response = await owner.session.fetch(origin + '/v1/me', {
        credentials: 'include', redirect: 'error', cache: 'no-store',
        signal: AbortSignal.any([operation.signal, AbortSignal.timeout(6000)]),
      });
      if (!response.ok) return 'unavailable';
      const { id } = await response.json();
      if (operation.signal.aborted || typeof id !== 'string' || !id || id.length > 128 ||
          (expectedActor && expectedActor !== id) || (currentActor && currentActor !== id)) return 'unavailable';
      currentActor = id;
      if (['web-list','list-items','change-item','save-linear'].includes(action)) {
        const fields = action === 'save-linear' ? {origin:'https://linear.app', title:target.title, token:target.token} :
          action === 'change-item' ? {origin:target.change.site, change:target.change} : {origin};
        const result = await keychain(vaultResources, {action, platform: origin, actor: id, ...fields}, operation.signal);
        return !operation.signal.aborted && currentActor === id ? result : {status: 'unavailable'};
      }
      const result = await vaultManager(vaultResources, { action, platform: origin, actor: id,
        origin: target?.origin ?? '', endpoint }, operation.signal, win, theme, presented);
      return ['closed', 'cancelled', 'saved'].includes(result.status) ? result.status : 'unavailable';
    } catch { return operation.signal.aborted ? 'closed' : 'unavailable'; }
    finally { remoteSignal?.removeEventListener('abort', abort); if (manager === operation) manager = undefined; if (!win.isDestroyed()) publish(); }
  }
  function cancelVault() { vaultOperation?.abort(); }
  powerMonitor.on('lock-screen', lockVault);
  powerMonitor.on('suspend', lockVault);
  function vaultTarget() {
    const tab = tabs.get(active);
    if (!visible || !currentActor || !tab || tab.officePath || owner.isDestroyed()) return;
    if (tab.view.webContents.isDestroyed() || tab.view.webContents.isLoadingMainFrame()) return;
    const address = webAddress(tab.view.webContents.getURL());
    if (webAddress(owner.getURL()) && new URL(owner.getURL()).origin === origin && address?.startsWith('https://')) return { tab, address, origin: new URL(address).origin };
  }
  async function useVault(action, turn, turnSignal) {
    const target = vaultTarget();
    if (!target || vaultOperation || manager || process.platform !== 'darwin') return 'unavailable';
    const { tab, address } = target, guest = tab.view.webContents, frame = guest.mainFrame;
    if (turn && (!tab.sidekickOpen || tab.vaultSession !== turn.session || tab.vaultWorkspace !== turn.workspace || !uuid.test(turn.installation) || sidekickAddress(address) !== turn.page)) return 'unavailable';
    if (turn && tab.manualSignIn) return 'manual_control';
    const operation = vaultOperation = new AbortController();
    const signal = AbortSignal.any([operation.signal, AbortSignal.timeout(90000), ...(turnSignal ? [turnSignal] : [])]);
    const actor = currentActor;
    const valid = () => !signal.aborted && currentActor === actor && visible && tabs.get(active) === tab &&
      !guest.isDestroyed() && guest.mainFrame === frame && !guest.isLoadingMainFrame() && guest.getURL() === address &&
      (!turn || (tab.sidekickOpen && tab.vaultSession === turn.session));
    try {
      stop();
      let agent;
      if (turn) {
        const response = await owner.session.fetch(origin + '/v1/agent-sessions/' + tab.vaultSession, {
          headers: { 'X-Expected-Actor': actor }, credentials: 'include', redirect: 'error', cache: 'no-store', signal,
        });
        if (!response.ok) return 'unavailable';
        const detail = await response.json();
        if (!detail.context?.browser_url || detail.session?.owner_id !== actor || detail.session.installation_id !== turn.installation ||
            detail.session.workspace_id !== turn.workspace || detail.session.id !== turn.session || !valid()) return 'unavailable';
        agent = detail.session.agent_name;
        if (typeof agent !== 'string' || !agent.trim()) return 'unavailable';
      } else {
        const response = await owner.session.fetch(origin + '/v1/me', {
          headers: { 'X-Expected-Actor': actor }, credentials: 'include', redirect: 'error', cache: 'no-store', signal,
        });
        if (!response.ok || (await response.json()).id !== actor) return 'unavailable';
      }
      if (!valid()) return 'unavailable';
      const marker = randomUUID();
      if (action === 'fill') {
        agent ??= 'you';
        await guest.executeJavaScriptInIsolatedWorld(1002, [{ code: 'globalThis.spaceVaultDocument = ' + JSON.stringify(marker) }]);
        if (!valid()) return 'unavailable';
      }
      const resources = vaultResources;
      const endpoint = registryCache.get(currentSite())?.site?.url;
      const grant = tab.apiGrant;
      if (action === 'call-api' && (!grant || grant.turn !== turn.id || grant.endpoint !== endpoint ||
          !grant.tools.includes(turn.input?.tool) || !turn.input.arguments || typeof turn.input.arguments !== 'object' ||
          JSON.stringify(turn.input.arguments).length > 4096)) return 'unavailable';
      if (action === 'list-api') tab.apiGrant = undefined;
      if (['list-api','call-api'].includes(action) && !endpoint) return 'unavailable';
      const result = await keychain(resources, { platform: origin, actor, origin: target.origin, action, agent,
        endpoint, ...(action === 'call-api' && { item: grant.item, tool: turn.input.tool, arguments: JSON.stringify(turn.input.arguments, null, 2) }) }, signal);
      if (!valid()) return 'unavailable';
      if (result.status !== 'approved') return ['saved','cancelled','no_matching_login','no_matching_token'].includes(result.status) ? result.status : 'unavailable';
      if (action === 'list-api' || action === 'call-api') {
        if (!result.token || !uuid.test(result.item)) return 'unavailable';
        const { RemoteMcp } = require(join(resources, 'remote.cjs'));
        const remote = new RemoteMcp();
        const connection = { url: endpoint, token: result.token };
        if (action === 'list-api') {
          const tools = await remote.discover(connection, signal);
          if (!valid() || JSON.stringify(tools).includes(result.token)) return 'unavailable';
          tab.apiGrant = { turn: turn.id, endpoint, item: result.item, tools: tools.map(tool => tool.name) };
          return { status: 'ready', tools };
        }
        if (result.item !== grant.item) return 'unavailable';
        const reply = await remote.call(connection, turn.input.tool, turn.input.arguments, signal);
        if (!valid() || JSON.stringify(reply).includes(result.token)) return 'unavailable';
        return { status: 'completed', result: reply };
      }
      if (action !== 'fill') return 'unavailable';
      tab.manualSignIn = true;
      publish();
      const code = '(' + fillLogin.toString() + ')(' + [target.origin, address, marker, result.username, result.password].map(v => JSON.stringify(v)).join(',') + ')';
      const filled = await guest.executeJavaScriptInIsolatedWorld(1002, [{ code }]);
      return filled ? 'filled' : 'manual_control';
    } catch { return 'unavailable'; }
    finally { if (vaultOperation === operation) vaultOperation = undefined; if (!win.isDestroyed()) publish(); }
  }

  function sidekickAddress(address) { const url = new URL(address); return url.origin + url.pathname; }

  function currentSite() {
    const tab = tabs.get(active);
    const address = visible && !tab?.officePath && webAddress(tab?.url);
    return address ? applicationDomain(address) : undefined;
  }

  function checkSite() {
    const domain = currentSite();
    if (checkedSite === domain) return;
    lookup?.abort();
    checkedSite = domain;
    suggestion = undefined;
    if (!domain || dismissedSites.has(domain)) return;
    const controller = lookup = new AbortController();
    void (async () => {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]);
      const cached = registryCache.get(domain);
      let site = cached?.site;
      if (!cached || cached.until <= Date.now()) {
        site = await discoverMcp(domain, (url, options) => profile.fetch(url, options), signal);
        if (signal.aborted) return;
        if (registryCache.size >= 128) registryCache.delete(registryCache.keys().next().value);
        registryCache.set(domain, { site, until: Date.now() + 30 * 60_000 });
      }
      if (!site) return;
      const response = await owner.session.fetch(origin + '/v1/me/connections', {
        credentials: 'include', redirect: 'error', cache: 'no-store',
        headers: { 'X-Expected-Actor': currentActor },
        signal,
      });
      if (!response.ok) return;
      const { items } = await response.json();
      if (controller.signal.aborted || !Array.isArray(items)) return;
      const endpoint = new URL(site.url);
      const connected = items.some(({ url }) => {
        if (!URL.canParse(url)) return false;
        const saved = new URL(url);
        return saved.origin === endpoint.origin && (saved.pathname + '/').startsWith(endpoint.pathname.replace(/\/$/, '') + '/');
      });
      if (!connected) { suggestion = site; publish(); }
    })().catch(() => { /* Browsing stays available when personal Connections is offline. */ });
  }
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
    return { theme, manualSignIn: !!tab?.manualSignIn, vaultBusy: !!vaultOperation || !!manager, vaultAvailable: process.platform === 'darwin' && !!vaultTarget(), mcpSuggestion: suggestion, installed: plugins?.installed() || [], tool: tab ? (tab.officePath ? 'office' : 'browser') : null, newTab: !!tab && !tab.url && !tab.popup, tabs: [...tabs].map(([id, tab]) => ({ id, tool: tab.officePath ? 'office' : 'browser', title: tab.title || 'Browser' })), active, full, splitWidth: splitWidth(width), minSplit: minPaneWidth, maxSplit: width - dividerWidth - minPaneWidth, notice, controlling: !!task,
      url: tabs.get(active)?.url || '', back: !!tabs.get(active)?.view.webContents.navigationHistory.canGoBack(),
      forward: !!tabs.get(active)?.view.webContents.navigationHistory.canGoForward(), maxTabs };
  }
  function publish() {
    checkSite();
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
  function showSidekick(focus = true) {
    const tab = tabs.get(active);
    const address = tab && !tab.officePath && webAddress(tab.view.webContents.getURL());
    if (tab?.manualSignIn || !address || owner.isDestroyed() || new URL(owner.getURL()).origin !== origin) return;
    const page = sidekickAddress(address);
    tab.sidekickKey ??= randomUUID();
    tab.sidekickOpen = true;
    if (full) { full = false; layout(); publish(); }
    owner.send('space-browser-sidekick', { tab: tab.sidekickKey, page, actor: currentActor });
    if (focus) owner.focus();
  }
  function dismissSidekick() {
    cancelVault();
    const tab = tabs.get(active);
    if (tab?.sidekickOpen) {
      tab.sidekickOpen = false;
      if (!owner.isDestroyed()) owner.send('space-browser-sidekick', null);
    }
  }
  function hide(withMotion = true) {
    dismissSidekick();
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
    if (id !== active) { dismissSidekick(); officeTask?.abort(); stop(); }
    active = id;
    for (const [key, tab] of tabs) tab.view.setVisible(visible && key === active && (!!tab.url || tab.popup));
    layout(enter); publish();
  }
  function remove(id) {
    const tab = tabs.get(id);
    if (!tab) return;
    if (id === active) { dismissSidekick(); officeTask?.abort(); }
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
    manager?.abort();
    generation++;
    localSetup = undefined;
    dismissedSites.clear();
    registryCache.clear();
    hide(false);
    for (const id of [...tabs.keys()]) remove(id);
    if (toolbar) {
      if (!win.isDestroyed()) pane.removeChildView(toolbar);
      if (!toolbar.webContents.isDestroyed()) toolbar.webContents.close();
    }
    profile?.removeListener('will-download', handleDownload);
    toolbar = profile = plugins = currentActor = undefined;
    ready = false;
  }
  function add(popupContents, enter = false, officePath) {
    if (!plugins?.has(officePath ? 'office' : 'browser')) throw new Error('Install the plugin to open a tab.');
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
      async function checkEditAccess(event, key, signal) {
        const activeFile = () => trusted(event) && visible && active === id && officePath.startsWith('/office/file/');
        if (!activeFile() || typeof key !== 'string' || key.length > 160) throw new Error('Office task unavailable.');
        const fileId = officePath.slice('/office/file/'.length);
        const response = await owner.session.fetch(origin + '/v1/assets/' + fileId + '/office-session?mode=edit',
          { credentials: 'include', cache: 'no-store', redirect: 'error', signal });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error('Editing access changed.');
        }
        const { config } = await response.json();
        if (config?.document?.key !== key || config.editorConfig?.mode !== 'edit' || config.editorConfig.user?.id !== currentActor
          || !activeFile() || signal.aborted) throw new Error('Editing access changed.');
      }
      guest.ipc.handle('office-check-edit', (event, key) => checkEditAccess(event, key, AbortSignal.timeout(6000)));
      guest.ipc.handle('office-agent', async (event, goal, selection, key, previousDraft) => {
        if (!trusted(event) || officeTask || typeof goal !== 'string' || !goal.trim() || goal.length > 1000
          || typeof selection !== 'string' || !selection.trim() || selection.length > 16000
          || (previousDraft !== undefined && (typeof previousDraft !== 'string' || previousDraft.length > 16000))) throw new Error('Office task unavailable.');
        const controller = new AbortController();
        officeTask = controller;
        const authorized = () => checkEditAccess(event, key, AbortSignal.any([controller.signal, AbortSignal.timeout(6000)]));
        try {
          await authorized();
          const directory = app.isPackaged ? join(process.resourcesPath, 'runner') : join(__dirname, '../../dist/runner');
          const result = await runOfficeTask(goal, selection, controller.signal, join(directory, 'office-mcp.mjs'), previousDraft);
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
      const previousUrl = tab.url;
      tab.url = guest.getURL() === 'about:blank' ? '' : guest.getURL();
      view.setVisible(visible && active === id && (!!tab.url || tab.popup));
      if (active === id && tab.sidekickOpen && !tab.manualSignIn && previousUrl !== tab.url) {
        if (webAddress(tab.url)) showSidekick(false);
        else dismissSidekick();
      }
      tab.title = guest.getTitle() || (webAddress(tab.url) ? new URL(tab.url).hostname : '');
      publish();
    };
    guest.on('did-start-navigation', (_event, _url, _inPage, main) => { if (main && active === id) cancelVault(); });
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
    if (vaultOperation || tabs.get(active)?.manualSignIn) throw new Error('Finish signing in and resume browser control first.');
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
      case 'install':
      case 'uninstall': {
        if (!Object.hasOwn(labels, arg)) return;
        if (action === 'uninstall' && [...tabs.values()].some(tab => (tab.officePath ? 'office' : 'browser') === arg)) {
          throw new Error('Close all ' + labels[arg] + ' tabs before removing the plugin.');
        }
        changePlugin(arg, action === 'install');
        notice = ''; publish();
        break;
      }
      case 'office': if (plugins.has('office')) owner.send('space-office-picker'); break;
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
      case 'mcp-guide':
      case 'connect-mcp':
      case 'dismiss-mcp': {
        const site = suggestion;
        if (!site || checkedSite !== currentSite() || site.url !== arg || new URL(owner.getURL()).origin !== origin) return;
        suggestion = undefined;
        if (action === 'dismiss-mcp') { dismissedSites.add(checkedSite); publish(); }
        else {
          const selected = tabs.get(active);
          hide();
          localSetup = { selected, site, actor: currentActor, address: selected.view.webContents.getURL() };
          owner.send('space-browser-connect-mcp', { ...site, actor: currentActor, ...(action === 'mcp-guide' && { showGuide: true }) });
        }
        break;
      }
      case 'fill-login':
        void useVault('fill').then(status => {
          if (tabs.get(active)?.view.webContents !== guest) return;
          if (status === 'no_matching_login') stop('Save a login for this website in Vault first.');
          if (status === 'unavailable') stop('Could not fill a login on this page.');
        });
        break;
      case 'vault':
        hide();
        owner.send('space-vault-page');
        break;
      case 'resume-control':
        if (tabs.get(active)?.manualSignIn && !vaultOperation) {
          const tab = tabs.get(active);
          tab.manualSignIn = false; stop();
          if (tab.sidekickOpen) showSidekick(false);
        }
        break;
      case 'sidekick': showSidekick(); break;
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
  function changePlugin(id, enabled) {
    try { plugins.set(id, enabled); }
    catch { throw new Error('Could not save plugin settings on this Mac. Try again.'); }
  }
  function createToolbar(actor) {
    const hash = createHash('sha256').update(JSON.stringify([origin, actor])).digest('hex');
    plugins = bundledPlugins(app.getPath('userData'), hash);
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
      const requested = officePath ? 'office' : newTab ? 'browser' : null;
      if (requested && !plugins.has(requested)) {
        const sessionVersion = generation;
        const { response: choice } = await dialog.showMessageBox(win, {
          type: 'question', message: 'Install ' + labels[requested] + '?',
          detail: 'Activate this bundled plugin for your Space account on this Mac.',
          buttons: ['Install and open', 'Cancel'], defaultId: 0, cancelId: 1,
        });
        if (choice !== 0 || sessionVersion !== generation || win.isDestroyed()) return false;
        try { changePlugin(requested, true); }
        catch (error) {
          await dialog.showMessageBox(win, { type: 'error', message: error.message });
          return false;
        }
      }
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
  owner.ipc.handle('space-vault-items', async (event, actor) => {
    if (event.senderFrame !== owner.mainFrame || event.senderFrame.origin !== origin || typeof actor !== 'string' || !actor) return {status: 'unavailable'};
    const result = await showVault(undefined, actor, 'web-list');
    if (result?.status === 'listed' && Array.isArray(result.items)) {
      return {status: 'listed', more: result.more === true, items: result.items.map(({title, site, kind}) => ({title, site, kind}))};
    }
    return {status: result === 'busy' ? 'busy' : result?.status === 'cancelled' ? 'cancelled' : 'unavailable'};
  });
  owner.ipc.handle('space-vault-item-request', async (event, actor, change) => {
    if (event.senderFrame !== owner.mainFrame || event.senderFrame.origin !== origin || !uuid.test(actor)) return {status:'unavailable'};
    if (change && (!['create','edit','delete'].includes(change.operation) || typeof change.site !== 'string' ||
        typeof change.title !== 'string' || JSON.stringify(change).length > 24000)) return {status:'invalid'};
    const result = await showVault(change ? {change} : undefined, actor, change ? 'change-item' : 'list-items');
    return typeof result === 'object' ? result : {status:result === 'busy' ? 'busy' : 'unavailable'};
  });
  owner.ipc.handle('space-vault-save-linear', async (event, actor, title, token) => {
    if (event.senderFrame !== owner.mainFrame || event.senderFrame.origin !== origin || !uuid.test(actor) ||
        typeof title !== 'string' || !title.trim() || title.length > 100 ||
        typeof token !== 'string' || !token.trim() || Buffer.byteLength(token) > 4096) return {status:'unavailable'};
    const result = await showVault({title:title.trim(), token}, actor, 'save-linear');
    return typeof result === 'object' ? result : {status:result === 'busy' ? 'busy' : 'unavailable'};
  });
  owner.ipc.handle('space-vault-open', (event, actor) => {
    if (event.senderFrame !== owner.mainFrame || event.senderFrame.origin !== origin || typeof actor !== 'string' || !actor) return 'unavailable';
    return showVault(undefined, actor);
  });
  owner.ipc.handle('space-browser-save-token', async (event, endpoint) => {
    const setup = localSetup;
    if (!setup || event.senderFrame !== owner.mainFrame || event.senderFrame.origin !== origin || setup.actor !== currentActor ||
        setup.site.url !== endpoint || setup.selected !== tabs.get(active) || setup.selected.view.webContents.getURL() !== setup.address) return 'unavailable';
    await open();
    if (setup !== localSetup || setup.selected !== tabs.get(active) || setup.actor !== currentActor ||
        setup.selected.view.webContents.getURL() !== setup.address) return 'unavailable';
    const target = vaultTarget();
    if (!target || registryCache.get(currentSite())?.site?.url !== endpoint) return 'unavailable';
    return showVault(target, currentActor, 'add-token');
  });
  owner.ipc.handle('space-browser-session', (event, tabKey, workspaceId) => {
    const tab = tabs.get(active);
    if (event.senderFrame !== owner.mainFrame || event.senderFrame.origin !== origin || !visible ||
        !tab?.sidekickOpen || tab.sidekickKey !== tabKey || typeof workspaceId !== 'string' || !uuid.test(workspaceId)) return null;
    // Keep each workspace's session stable across web-view remounts, bounded by the lifetime of the tab.
    const bytes = createHash('sha256').update(JSON.stringify([currentActor, workspaceId, tabKey])).digest();
    bytes[6] = (bytes[6] & 15) | 0x40;
    bytes[8] = (bytes[8] & 63) | 0x80;
    const hex = bytes.subarray(0, 16).toString('hex');
    const sessionId = [hex.slice(0,8), hex.slice(8,12), hex.slice(12,16), hex.slice(16,20), hex.slice(20)].join('-');
    if (tab.vaultSession !== sessionId) cancelVault();
    tab.vaultSession = sessionId;
    tab.vaultWorkspace = workspaceId;
    return sessionId;
  });
  owner.ipc.on('space-browser-dismiss-sidekick', (event, key) => {
    if (event.senderFrame === owner.mainFrame && event.senderFrame.origin === origin && tabs.get(active)?.sidekickKey === key)
      dismissSidekick();
  });
  owner.ipc.on('space-browser-theme', (event, value) => {
    if (event.senderFrame !== owner.mainFrame || event.senderFrame.origin !== origin) return;
    if ((value === 'light' || value === 'dark') && value !== theme) { theme = value; publish(); }
  });
  const cookies = owner.session.cookies;
  const cookieChanged = (_e, cookie, cause, removed) => {
    if (removed && cause !== 'overwrite' && /(?:session_token|space\.refresh)$/.test(cookie.name) && new URL(origin).hostname === cookie.domain.replace(/^\./, '')) reset();
  };
  cookies.on('changed', cookieChanged);
  owner.on('did-start-navigation', (_e, _url, inPage, main) => { if (main && !inPage) { manager?.abort(); generation++; hide(false); } });
  owner.on('render-process-gone', reset);
  win.on('resize', () => { layout(); publish(); });
  layout();
  win.once('closed', () => { powerMonitor.off('lock-screen', lockVault); powerMonitor.off('suspend', lockVault); cookies.off('changed', cookieChanged); reset(); });
  function togglePanel() {
    if (!visible) return open();
    if (full) return hide();
    full = true; layout(true); publish();
  }
  return { open, openOffice, hide, togglePanel, showVault,
    async webVault(request, signal) {
      if (!uuid.test(request.actor) || signal.aborted || !['list','list-items','manage','change-item','save-linear'].includes(request.action)) return {status: 'unavailable'};
      if (request.action !== 'manage') {
        const action = request.action === 'list' ? 'web-list' : request.action;
        const result = await showVault(request, request.actor, action, undefined, signal);
        return typeof result === 'object' ? result : {status: result === 'busy' ? 'busy' : 'unavailable'};
      }
      // A remote request can show the locked manager. Only the Mac user can unlock it.
      return new Promise(resolve => {
        void showVault(undefined, request.actor, 'manager', () => {
          if (win.isMinimized()) win.restore();
          win.show(); resolve({status: 'opened'});
        }, signal).then(status => resolve({status: status === 'busy' ? 'busy' : 'unavailable'}));
      });
    },
    vaultTool: (turn, signal) => ['fill', 'list-api', 'call-api'].includes(turn.action) ? useVault(turn.action, turn, signal) : 'unavailable',
    showPanel() { if (!visible) return open(); },
    hidePanel() {
      if (opening) generation++; // A pending session check must not reopen the panel.
      hide();
    },
    accountChanged(actor) {
    // Renderer notifications can revoke access. Only the authenticated /me response opens a profile.
    if (manager && (!actor || actor !== currentActor)) manager.abort();
    if (currentActor && actor !== currentActor) reset();
    else if (opening && (!actor || actor !== currentActor)) generation++;
  } };
}
module.exports = { createBrowser };
