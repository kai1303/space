const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const { join } = require('node:path');

function vaultScope(platform, actor) {
  return createHash('sha256').update(JSON.stringify([platform, actor])).digest('hex');
}

function presentVault(resources, { platform, actor, origin, endpoint, action }, signal, win, theme, presented) {
  const native = require(join(resources, 'space-vault.node'));
  return new Promise(resolve => {
    signal.throwIfAborted();
    const handle = native.open(win.getNativeWindowHandle(), vaultScope(platform, actor), origin, endpoint ?? '',
      action === 'add-token', theme === 'dark', saved => {
        signal.removeEventListener('abort', close);
        native.close(handle);
        resolve({ status: saved ? 'saved' : action === 'add-token' ? 'cancelled' : 'closed' });
      });
    function close() { native.close(handle); }
    signal.addEventListener('abort', close, { once: true });
    presented?.();
  });
}

function openVault(resources, { platform, actor, ...request }, signal) {
  const scope = vaultScope(platform, actor);
  return new Promise((resolve, reject) => {
    const child = execFile(join(resources, 'space-vault'), [], {
      signal, timeout: 90000, maxBuffer: request.action === 'web-list' ? 8 * 1024 * 1024 : 32768, env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME },
    }, (error, output) => {
      if (!error) try { return resolve(JSON.parse(output)); } catch {}
      reject(new Error('Vault unavailable.'));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ ...request, scope }));
  });
}

// Runs in the top frame's isolated world. All checks and assignments are synchronous.
function fillLogin(origin, address, marker, username, password) {
  if (globalThis.spaceVaultDocument !== marker || location.href !== address) return false;
  delete globalThis.spaceVaultDocument;
  if (window !== window.top || location.origin !== origin || location.protocol !== 'https:') return false;
  const visible = input => !input.disabled && !input.readOnly && input.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && input.getBoundingClientRect().height > 0;
  const passwords = [...document.querySelectorAll('input[type=password]')].filter(visible);
  if (passwords.length !== 1) return false;
  const pass = passwords[0], form = pass.form;
  if (!form || form.method.toLowerCase() !== 'post' || new URL(form.action, location.href).origin !== origin ||
      pass.autocomplete.includes('new-password') || [...form.elements].some(el => (el.hasAttribute('formaction') && new URL(el.formAction, location.href).origin !== origin) || (el.hasAttribute('formmethod') && el.formMethod !== 'post'))) return false;
  const users = [...form.elements].filter(el => el instanceof HTMLInputElement && ['text', 'email'].includes(el.type) && visible(el));
  const named = users.filter(el => el.autocomplete.split(' ').includes('username') || el.type === 'email');
  const matches = named.length ? named : users;
  if (matches.length !== 1) return false;
  const user = matches[0];
  user.value = username;
  pass.value = password;
  for (const el of [user, pass]) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return true;
}

module.exports = { openVault, fillLogin, presentVault };
