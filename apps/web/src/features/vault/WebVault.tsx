import { useEffect, useId, useRef, useState } from 'react';
import type { VaultMac, WebVaultAction, WebVaultItem, WebVaultResult } from '@space/contracts';
import { Button, Dialog, Select, Tabs } from '@space/ui/primitives';
import { Desktop, Key, Lock, Terminal } from '@phosphor-icons/react';
import { request } from '../../shared/api/request.js';
import './vault.css';

export function WebVault({actor, close}: {actor: string; close: () => void}) {
  const macPickerId = useId();
  const [macs, setMacs] = useState<VaultMac[]>([]);
  const [selected, setSelected] = useState('');
  const [items, setItems] = useState<WebVaultItem[]>();
  const [category, setCategory] = useState('all');
  const [more, setMore] = useState(false);
  const [search, setSearch] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<WebVaultAction>();
  const active = useRef<AbortController | null>(null);
  const mac = macs.find(m => m.id === selected);
  function clearItems() { setItems(undefined); setMore(false); setSearch(''); setCategory('all'); }
  async function refresh() {
    active.current?.abort();
    const controller = active.current = new AbortController();
    setLoading(true); setMessage(''); clearItems();
    try {
      const devices = await request<VaultMac[]>('/me/vault/macs', undefined, undefined, 'POST', controller.signal, actor);
      if (controller.signal.aborted) return;
      setMacs(devices);
      setSelected(previous => devices.some(d => d.id === previous) ? previous : (devices.find(d => d.online) ?? devices[0])?.id ?? '');
    } catch { if (!controller.signal.aborted) { setMacs([]); setMessage('Could not load your paired Macs. Try refreshing.'); } }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }
  useEffect(() => { void refresh(); return () => active.current?.abort(); }, [actor]);
  async function send(action: WebVaultAction) {
    if (!mac?.online || busy) return;
    const controller = active.current = new AbortController();
    setBusy(action); setMessage('');
    if (action === 'list') clearItems();
    try {
      const path = '/me/vault/macs/' + mac.id + '/request';
      const fetchResult = (cursor?: string) => request<WebVaultResult>(path, cursor ? {action, cursor} : {action}, undefined, 'POST', controller.signal, actor);
      let result = await fetchResult();
      const entries: WebVaultItem[] = [];
      const seen = new Set<string>();
      let receivedBytes = 0;
      while (!controller.signal.aborted && result.status === 'listed') {
        // Match the native helper’s maximum snapshot size across all relay pages.
        receivedBytes += new TextEncoder().encode(JSON.stringify(result.items)).byteLength;
        if (receivedBytes > 8 * 1024 * 1024) throw new Error('invalid_vault_response');
        entries.push(...result.items);
        if (!result.cursor) break;
        if (seen.has(result.cursor)) throw new Error('invalid_vault_response');
        seen.add(result.cursor);
        result = await fetchResult(result.cursor);
      }
      if (controller.signal.aborted) return;
      if (result.status === 'listed') { setItems(entries); setMore(result.more); }
      else if (result.status === 'opened') setMessage('Vault is open in Space Desktop on your Mac.');
      else if (result.status === 'cancelled') setMessage('The request was cancelled on your Mac.');
      else if (result.status === 'busy') setMessage('Finish the open Vault session on your Mac and try again.');
      else setMessage('Open Space Desktop on your Mac, sign in with this account, and try again.');
    } catch (error) {
      if (controller.signal.aborted) return;
      const code = error instanceof Error ? error.message : '';
      if (['vault_connection_changed','vault_mac_not_found','vault_mac_offline'].includes(code)) {
        clearItems(); setMacs(old => old.map(d => d.id === mac.id ? {...d, online: false} : d));
        setMessage('This connection is unavailable. Refresh the list to reconnect.');
      } else setMessage(code === 'vault_request_expired' ? 'The request expired. Try again when you’re at your Mac.' :
        code === 'vault_busy' ? 'A Vault request is already in progress.' : 'Could not reach your Mac. Try again.');
    } finally { if (!controller.signal.aborted) setBusy(undefined); }
  }
  const categories = [{id:'all', label:'All items'}, {id:'login', label:'Logins'}, {id:'token', label:'API tokens'}];
  const matches = items?.filter(item => (category === 'all' || category === item.kind) &&
    [item.title, item.site].some(value => value.toLowerCase().includes(search.toLowerCase())));
  return <Dialog open title={items ? 'Personal Vault' : 'Vault'} onClose={close}>
    <div className="space-web-vault">
      {loading ? <p role="status">Finding paired Macs…</p> : macs.length ? <>
        {macs.length > 1 && <div className="sp-field">
          <label htmlFor={macPickerId}><Desktop size={18} aria-hidden="true"/> Paired Mac</label>
          <Select id={macPickerId} aria-label="Paired Mac" value={selected} disabled={!!busy} onChange={event => { setSelected(event.target.value); clearItems(); setMessage(''); }}>
            {macs.map(device => <option key={device.id} value={device.id}>{device.name}{device.online ? '' : ' · Offline'}</option>)}
          </Select>
        </div>}
        {!items && mac && (mac.online ? <section className="space-web-vault-unlock" aria-label="Unlock your Vault">
          <Lock size={24} aria-hidden="true" />
          <h3>Unlock your Vault</h3>
          <p>Use Touch ID or your Mac password on <strong>{mac.name}</strong> to access your saved logins and API tokens.</p>
          <Button variant="primary" loading={busy === 'list'} onClick={() => void send('list')}>{busy ? 'Unlocking…' : 'Unlock Vault'}</Button>
        </section> : <p>{mac.name} is offline. Open Space Desktop on this Mac, then refresh.</p>)}
      </> : !message && <p>Pair a local agent in Space Desktop on your Mac, then refresh to see it here.</p>}
      {(busy || message) && <p role="status">{busy === 'list' ? 'Waiting for approval on your Mac…' : busy ? 'Opening Vault on your Mac…' : message}</p>}
      {items && <section className="space-web-vault-list" aria-label="Vault items">
        <Tabs label="Vault categories" value={category} onChange={setCategory} items={categories.map(group => ({
          ...group, label: group.label + ' (' + (group.id === 'all' ? items.length : items.filter(item => item.kind === group.id).length) + ')',
        }))}/>
        <input type="search" aria-label="Search items" placeholder="Search items" value={search} onChange={event => setSearch(event.target.value)}/>
        {matches?.length ? <ul>{matches.map((item, index) => <li key={index}>
          {item.kind === 'login' ? <Key size={20} aria-label="Login"/> : <Terminal size={20} aria-label="API token"/>}
          <div><strong>{item.title}</strong><small>{new URL(item.site).hostname}</small></div>
        </li>)}</ul> : <p>{!items.length ? 'Your Vault is empty' : search ? 'No matching items' : 'No items in this category'}</p>}
        {more && <small>This Mac shared the first {items.length} items. Open Vault on your Mac to see the rest.</small>}
        <div className="space-web-vault-actions">
          <Button disabled={!!busy} onClick={() => void send('manage')}>Manage on Mac</Button>
          <Button variant="ghost" disabled={!!busy} onClick={() => { clearItems(); setMessage(''); }}><Lock aria-hidden="true"/> Lock Vault</Button>
        </div>
      </section>}
      {!loading && !busy && !items && (!mac?.online || macs.length > 1 || message) &&
        <div className="space-web-vault-actions"><Button variant="ghost" size="sm" onClick={() => void refresh()}>Refresh Macs</Button></div>}
    </div>
  </Dialog>;
}
