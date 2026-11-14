import { animate } from 'motion/mini';

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
function reveal(node) {
  if (reducedMotion.matches) return;
  animate(node, { opacity: [0.35, 1], transform: ['translateY(3px)', 'translateY(0)'] },
    { duration: 0.16, ease: 'easeOut' });
}

const el = id => document.getElementById(id);
const send = (action, arg) => window.browserBar.command(action, arg);
let picking = false;
let installed = [];
let current, shownUrl, lastNotice, splitWidth, drag;
const divider = el('divider');
divider.onpointerdown = event => {
  if (event.button !== 0 || !event.isPrimary) return;
  drag = { id: event.pointerId, x: event.screenX, width: splitWidth };
  divider.setPointerCapture(event.pointerId);
  divider.classList.add('dragging');
};
function resize(event) {
  if (drag?.id === event.pointerId) send('resize', drag.width + event.screenX - drag.x);
}
divider.onpointermove = resize;
divider.onpointerup = event => {
  resize(event);
  if (divider.hasPointerCapture(event.pointerId)) divider.releasePointerCapture(event.pointerId);
};
divider.onlostpointercapture = () => { drag = null; divider.classList.remove('dragging'); };
divider.onkeydown = event => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  send('resize', splitWidth + (event.key === 'ArrowRight' ? 24 : -24));
};
function focusAddress() { el('address').focus(); el('address').select(); }
function button(text, label, fn) {
  const node = document.createElement('button');
  node.textContent = text; node.setAttribute('aria-label', label); node.onclick = fn;
  return node;
}
const tabElements = new Map();
function renderTabs(tabs, active) {
  for (const [id, group] of tabElements) {
    if (!tabs.some(tab => tab.id === id)) {
      tabElements.delete(id);
      group.inert = true;
      if (reducedMotion.matches || !tabs.length) {
        group.remove();
      } else {
        group.style.overflow = 'hidden';
        animate(group, { width: [group.offsetWidth + 'px', '0px'], opacity: 0 },
          { duration: 0.14, ease: 'easeOut' }).then(() => group.remove());
      }
    }
  }
  for (const { id, title, tool } of tabs) {
    let group = tabElements.get(id);
    const added = !group;
    if (added) {
      group = document.createElement('span');
      group.className = 'tab';
      const open = button('', title, () => send('switch', id));
      open.append(el(tool === 'office' ? 'office' : 'new').querySelector('svg').cloneNode(true), document.createElement('span'));
      group.append(open, button('×', 'Close ' + title, () => send('close', id)));
      tabElements.set(id, group);
      el('tabs').append(group);
    }
    const [open, close] = group.children;
    if (open.lastElementChild.textContent !== title) {
      open.lastElementChild.textContent = title;
      open.setAttribute('aria-label', title);
      close.setAttribute('aria-label', 'Close ' + title);
    }
    group.classList.toggle('current', id === active);
    if (id === active) open.setAttribute('aria-current', 'page');
    else open.removeAttribute('aria-current');
    if (id === active && current !== active) group.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (added && !reducedMotion.matches) {
      animate(group, { opacity: [0, 1], transform: ['translateX(-8px) scale(.94)', 'none'] },
        { duration: 0.18, ease: 'easeOut' });
    }
  }
}
function showTools(open) {
  picking = open;
  if (!open) showPlugins(false);
  el('tools').hidden = !open;
  el('add-tool').setAttribute('aria-expanded', String(open));
}
function showPlugins(open) {
  el('plugins').hidden = !open;
  el('launch-tools').hidden = open;
  el('tools-heading').hidden = open;
}
el('manage').onclick = () => {
  showPlugins(true);
  el('plugins').querySelector('[data-plugin]').focus();
};
el('plugins-done').onclick = () => {
  showPlugins(false);
  el('manage').focus();
};
for (const node of el('plugins').querySelectorAll('[data-plugin]')) {
  const id = node.dataset.plugin;
  node.onclick = () => send(installed.includes(id) ? 'uninstall' : 'install', id);
}
el('add-tool').onclick = () => {
  showTools(!picking);
  if (picking) el('launch-tools').querySelector('button:not([hidden]):enabled').focus();
};
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !el('plugins').hidden) {
    el('plugins-done').click();
  } else if (event.key === 'Escape' && picking && current != null) {
    showTools(false);
    el('add-tool').focus();
  }
});
window.browserBar.onState(state => {
  installed = state.installed;
  el('new').hidden = !installed.includes('browser');
  el('office').hidden = !installed.includes('office');
  for (const node of el('plugins').querySelectorAll('[data-plugin]')) {
    const action = installed.includes(node.dataset.plugin) ? 'Remove' : 'Install';
    node.textContent = action;
    node.setAttribute('aria-label', action + ' ' + node.previousElementSibling.textContent);
  }
  const empty = !state.tool;
  el('tools-heading').textContent = installed.length ? 'Open a tool' : 'Workspace plugins';
  const toolsSlot = el(empty ? 'start-tools' : 'tool-slot');
  if (el('tools').parentElement !== toolsSlot) toolsSlot.append(el('tools'));
  el('workspace-start').hidden = !empty;
  el('add-tool').hidden = empty;
  if (empty || current !== state.active) showTools(empty);
  document.documentElement.dataset.theme = state.theme;
  const slot = el(state.newTab ? 'start-address-slot' : 'address-slot');
  if (el('navigate').parentElement !== slot) slot.append(el('navigate'));
  const showStart = state.newTab && (el('start').hidden || current !== state.active);
  el('start').hidden = !state.newTab;
  if (showStart) reveal(el('start').firstElementChild);
  el('navigation').hidden = state.tool !== 'browser' || state.newTab && !state.back && !state.forward;
  if (current !== state.active || !state.url || state.controlling) setTaskOpen(false);
  if (current !== state.active) { el('goal').value = ''; }
  renderTabs(state.tabs, state.active);
  if (current !== state.active || shownUrl !== state.url) {
    el('address').value = state.url;
    if (state.newTab) focusAddress();
  }
  current = state.active; shownUrl = state.url;
  const layoutLabel = state.full ? 'Enter split view' : 'Enter full view';
  el('layout').title = layoutLabel;
  el('layout').setAttribute('aria-label', layoutLabel);
  el('layout-glyph').setAttribute('d', state.full ? 'M6 2.5v11' : 'M5 8h6m-2-2 2 2-2 2');
  document.body.classList.toggle('full', state.full);
  divider.hidden = state.full;
  splitWidth = state.splitWidth;
  divider.setAttribute('aria-valuenow', splitWidth);
  divider.setAttribute('aria-valuemin', state.minSplit);
  divider.setAttribute('aria-valuemax', state.maxSplit);
  divider.setAttribute('aria-valuetext', splitWidth + ' pixels');
  el('new').disabled = state.tabs.length >= state.maxTabs;
  el('back').disabled = !state.back; el('forward').disabled = !state.forward;
  el('sidekick').hidden = state.controlling; el('sidekick').disabled = !state.url;
  el('ask').hidden = state.controlling; el('ask').disabled = !state.url;
  el('stop').hidden = !state.controlling;
  el('feedback').classList.toggle('controlling', state.controlling);
  const message = state.controlling ? 'Codex is controlling this tab.' : state.notice;
  if (message !== lastNotice) {
    el('notice').textContent = message; el('feedback').hidden = !message; lastNotice = message;
    if (message) reveal(el('notice'));
  }
  el('dismiss').hidden = state.controlling;
});
window.browserBar.onAddressFocus(focusAddress);
for (const action of ['space', 'layout', 'new', 'office', 'back', 'forward', 'reload', 'stop', 'sidekick']) el(action).onclick = () => {
  if (current != null) showTools(false);
  send(action);
};
el('navigate').onsubmit = event => { event.preventDefault(); send('go', el('address').value); };
function setTaskOpen(open) {
  const task = el('task');
  const opening = open && task.hidden;
  task.hidden = !open;
  if (opening) reveal(task);
  el('ask').setAttribute('aria-expanded', String(open));
}
el('ask').onclick = () => {
  setTaskOpen(el('task').hidden);
  if (!el('task').hidden) el('goal').focus();
};
function cancelTask() { setTaskOpen(false); el('ask').focus(); }
el('cancel').onclick = cancelTask;
el('task').onkeydown = event => { if (event.key === 'Escape') cancelTask(); };
el('dismiss').onclick = () => { el('feedback').hidden = true; };
el('task').onsubmit = event => {
  event.preventDefault();
  const goal = el('goal').value.trim();
  if (goal) { setTaskOpen(false); send('agent', goal); }
};
new ResizeObserver(() => send('height', Math.ceil(document.querySelector('header').getBoundingClientRect().height))).observe(document.querySelector('header'));
