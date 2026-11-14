import { useEffect, useId, useRef, useState } from 'react';
import type { VaultMac, VaultChange, VaultItemDetails } from '@space/contracts';
import { Button, Select, Tabs } from '@space/ui/primitives';
import { Desktop, Fingerprint, Key, Lock, Terminal } from '@phosphor-icons/react';
import { request } from '../../shared/api/request.js';
import {VaultItemEditor} from './VaultItemEditor.js';
import {vaultItemRequest} from './vault-client.js';
import './vault.css';

export function WebVault({actor}: {actor: string}) {
  useEffect(() => {
    document.title = 'Vault — Space';
    return () => { document.title = 'Space — Chat'; };
  }, []);
  const desktop = window.spaceDesktop?.listVaultItems ? window.spaceDesktop : undefined;
  const macPickerId = useId();
  const [macs, setMacs] = useState<VaultMac[]>([]);
  const [selected, setSelected] = useState('');
  const [items, setItems] = useState<VaultItemDetails[]>();
  const [category, setCategory] = useState('all');
  const [editor, setEditor] = useState<VaultItemDetails | 'new'>();
  const [more, setMore] = useState(false);
  const [search, setSearch] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'list' | 'change'>();
  const active = useRef<AbortController | null>(null);
  const mac = macs.find(m => m.id === selected);
  function clearItems() { setEditor(undefined); setItems(undefined); setMore(false); setSearch(''); setCategory('all'); }
  async function refresh() {
    active.current?.abort();
    const controller = active.current = new AbortController();
    setLoading(true); setMessage(''); clearItems();
    try {
      const paired = await request<VaultMac[]>('/me/vault/macs', undefined, undefined, 'POST', controller.signal, actor);
      const devices = !paired.length && desktop ? [{id: 'local', name: 'this Mac', online: true}] : paired;
      if (controller.signal.aborted) return;
      setMacs(devices);
      setSelected(previous => devices.some(d => d.id === previous) ? previous : (devices.find(d => d.online) ?? devices[0])?.id ?? '');
    } catch { if (!controller.signal.aborted) { setMacs([]); setMessage('Could not load your paired Macs. Try refreshing.'); } }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }
  useEffect(() => {
    void refresh();
    const unsubscribe = desktop?.onVaultLocked?.(() => {
      active.current?.abort(); clearItems(); setBusy(undefined); setMessage('');
    });
    return () => { active.current?.abort(); unsubscribe?.(); };
  }, [actor, desktop]);
  async function send(change?:VaultChange) {
    if (!mac?.online || busy || (change && !items)) return;
    const controller = active.current = new AbortController();
    setBusy(change ? 'change' : 'list'); setMessage('');
    if (!change) clearItems();
    try {
      const result = await vaultItemRequest(actor, mac.id, controller.signal, change);
      if (controller.signal.aborted) return;
      if (result.status === 'listed') { setItems(result.items); setMore(result.more); }
      else if (result.status === 'saved') {
        const saved = result.item;
        setItems(previous => previous && [...previous.filter(i => i.id !== saved.id), saved].sort((a,b) => a.title.localeCompare(b.title)));
        setEditor(saved); setMessage('Saved to Keychain on ' + mac.name + '.');
      } else if (result.status === 'deleted' && change?.operation === 'delete') {
        setItems(previous => previous?.filter(i => i.id !== change.id)); setEditor(undefined);
        setMessage('Deleted ' + change.title + ' from Keychain on ' + mac.name + '.');
      } else if (result.status === 'stale') {
        clearItems(); setMessage('The item changed on your Mac. Unlock again to see its current details.');
      } else if (result.status === 'duplicate') setMessage('An item with this title already exists for this website.');
      else if (result.status === 'invalid') setMessage('Check the item fields and try again.');
      else if (result.status === 'cancelled') setMessage('The request was cancelled on your Mac.');
      else if (result.status === 'busy') setMessage('Finish the open Vault request on your Mac and try again.');
      else setMessage('Could not complete the request. Check Space Desktop on your Mac and try again.');
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
  function openEditor(item?:VaultItemDetails | 'new') { setEditor(item); setMessage(''); }
  const categories = [{id:'all', label:'All items'}, {id:'login', label:'Logins'}, {id:'token', label:'API tokens'}];
  const matches = items?.filter(item => (category === 'all' || category === item.kind) &&
    [item.title, item.site, item.username ?? ''].some(value => value.toLowerCase().includes(search.toLowerCase())));
  return <main id="chat-messages" tabIndex={-1} className="space-vault-page" aria-labelledby="vault-page-title">
    <header className="space-vault-header">
      <h1 id="vault-page-title"><Lock size={20} aria-hidden="true"/> Personal Vault</h1>
      {items && <Button size="sm" onClick={() => { clearItems(); setMessage(''); }} disabled={!!busy}><Lock aria-hidden="true"/> Lock Vault</Button>}
    </header>
    <div className={'space-web-vault' + (items ? ' is-unlocked' : '')}>
      {loading ? <p role="status">Finding paired Macs…</p> : macs.length ? <>
        {macs.length > 1 && <div className="sp-field">
          <label htmlFor={macPickerId}><Desktop size={18} aria-hidden="true"/> Paired Mac</label>
          <Select id={macPickerId} aria-label="Paired Mac" value={selected} disabled={!!busy || !!editor} onChange={event => { setSelected(event.target.value); clearItems(); setMessage(''); }}>
            {macs.map(device => <option key={device.id} value={device.id}>{device.name}{device.online ? '' : ' · Offline'}</option>)}
          </Select>
        </div>}
        {items && editor && mac && <VaultItemEditor key={editor === 'new' ? 'new' : editor.id + editor.version}
          item={editor === 'new' ? undefined : editor} busy={!!busy} onBack={() => openEditor()} onChange={change => void send(change)}/>}
        {!items && mac && (mac.online ? <section className="space-web-vault-unlock" aria-label="Unlock your Vault">
          <Fingerprint size={34} aria-hidden="true" />
          <h2>Unlock your Vault</h2>
          <p>Use Touch ID or your Mac password on <strong>{mac.name}</strong> to access your saved logins and API tokens.</p>
          <Button variant="primary" loading={busy === 'list'} onClick={() => void send()}>{busy ? 'Unlocking…' : 'Unlock Vault'}</Button>
        </section> : <p>{mac.name} is offline. Open Space Desktop on this Mac, then refresh.</p>)}
      </> : !message && <p>Pair a local agent in Space Desktop on your Mac, then refresh to see it here.</p>}
      {(busy || message) && <p role="status">{busy ? 'Waiting for approval on ' + mac?.name + '…' : message}</p>}
      {items && !editor && <section className="space-web-vault-list" aria-label="Vault items">
        <div className="space-vault-list-header"><h2>Items</h2><Button variant="primary" onClick={() => openEditor('new')}>Add item</Button></div>
        <Tabs label="Vault categories" value={category} onChange={setCategory} items={categories.map(group => ({
          ...group, label: group.label + ' (' + (group.id === 'all' ? items.length : items.filter(item => item.kind === group.id).length) + ')',
        }))}/>
        <input type="search" aria-label="Search items" placeholder="Search items" value={search} onChange={event => setSearch(event.target.value)}/>
        {matches?.length ? <ul>{matches.map(item => <li key={item.id}><button type="button" className="space-vault-row" onClick={() => openEditor(item)}>
          {item.kind === 'login' ? <Key size={20} aria-label="Login"/> : <Terminal size={20} aria-label="API token"/>}
          <span><strong>{item.title}</strong><small>{item.username || new URL(item.site).hostname}</small></span>
        </button></li>)}</ul> : <p>{!items.length ? 'Your Vault is empty' : search ? 'No matching items' : 'No items in this category'}</p>}
        {more && <small>This Mac shared the first {items.length} items. Open Vault on your Mac to see the rest.</small>}
      </section>}
      {!editor && !loading && !busy && !items && (!mac?.online || macs.length > 1 || message) &&
        <div className="space-web-vault-actions"><Button variant="ghost" size="sm" onClick={() => void refresh()}>Refresh Macs</Button></div>}
    </div>
  </main>;
}
