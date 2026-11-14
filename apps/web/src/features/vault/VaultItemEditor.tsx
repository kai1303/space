import {useState} from 'react';
import type {VaultChange, VaultItemDetails} from '@space/contracts';
import {Button, TextField} from '@space/ui/primitives';
import {Key, Terminal} from '@phosphor-icons/react';

type Props = {item?:VaultItemDetails; busy:boolean; onBack:()=>void; onChange:(change:VaultChange)=>void};

export function VaultItemEditor({item, busy, onBack, onChange}: Props) {
  const [kind, setKind] = useState(item?.kind);
  const [mode, setMode] = useState<'view'|'edit'|'delete'>(item ? 'view' : 'edit');
  const [title, setTitle] = useState(item?.title ?? '');
  const [site, setSite] = useState(item?.site ?? '');
  const [endpoint, setEndpoint] = useState(item?.endpoint ?? '');
  const [error, setError] = useState('');
  const back = <Button size="sm" disabled={busy} onClick={onBack}>Back to items</Button>;
  if (!kind) return <section className="space-vault-editor">
    {back}<h2>Add item</h2>
    <Button onClick={() => setKind('login')}><Key/> Login</Button>
    <Button onClick={() => setKind('token')}><Terminal/> API token</Button>
  </section>;

  if (mode === 'view' && item) return <section className="space-vault-editor">
    {back}<h2>{item.title}</h2>
    <dl><dt>Type</dt><dd>{kind === 'login' ? 'Login' : 'API token'}</dd><dt>Website</dt><dd>{item.site}</dd>
      {kind === 'login' && <><dt>Username</dt><dd>{item.username}</dd></>}
      {item.endpoint && <><dt>MCP endpoint</dt><dd>{item.endpoint}</dd></>}
      <dt>{kind === 'login' ? 'Password' : 'API token'}</dt><dd aria-label="Hidden value">••••••••</dd>
    </dl>
    <div className="space-web-vault-actions"><Button variant="primary" onClick={() => setMode('edit')}>Edit</Button>
      <Button onClick={() => setMode('delete')}>Delete…</Button></div>
  </section>;

  if (mode === 'delete' && item) return <section className="space-vault-editor">
    <h2>Delete {item.title}?</h2><p>This permanently removes the item from your Mac’s Keychain.</p>
    <div className="space-web-vault-actions">
      <Button disabled={busy} onClick={() => setMode('view')}>Cancel</Button>
      <Button variant="danger" loading={busy} onClick={() => onChange({operation:'delete', id:item.id, version:item.version, site:item.site, title:item.title})}>Delete item</Button>
    </div>
  </section>;

  const token = kind === 'token';
  function save(form:HTMLFormElement) {
    const values = new FormData(form);
    const secret = String(values.get('secret') ?? '');
    try {
      const url = new URL(site);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
      if (token && endpoint) {
        const server = new URL(endpoint);
        if (server.protocol !== 'https:' || server.username || server.password || server.search || server.hash) throw new Error();
      }
    } catch { setError('Enter an HTTPS website origin and a valid HTTPS endpoint if supplied.'); return; }
    if (token && item && endpoint !== (item.endpoint ?? '') && !secret) { setError('Enter a new token to change the MCP endpoint.'); return; }
    setError('');
    onChange({operation:item ? 'edit' : 'create', ...(item && {id:item.id, version:item.version}), kind:token ? 'token' : 'login',
      title:title.trim(), site:new URL(site).origin, secret, ...(token ? {endpoint} : {username:String(values.get('username'))})});
  }
  return <form className="space-vault-editor" autoComplete="off" onSubmit={event => {event.preventDefault(); save(event.currentTarget);}}>
    <h2>{item ? 'Edit item' : token ? 'New API token' : 'New login'}</h2>
    {!item && token && <Button size="sm" disabled={busy} onClick={() => {setTitle('Linear'); setSite('https://linear.app'); setEndpoint('https://mcp.linear.app/mcp');}}>Use Linear settings</Button>}
    <TextField label="Title" value={title} onChange={e=>setTitle(e.target.value)} maxLength={100} required autoFocus disabled={busy}/>
    <TextField label="Website" type="url" value={site} onChange={e=>setSite(e.target.value)} placeholder="https://example.com" maxLength={2000} readOnly={!!item} required disabled={busy}/>
    {token ? <TextField label="MCP endpoint (optional)" type="url" value={endpoint} onChange={e=>setEndpoint(e.target.value)} maxLength={2000} disabled={busy}/>
      : <TextField label="Username" name="username" defaultValue={item?.username} maxLength={1024} required disabled={busy}/>}
    <TextField label={token ? 'API token' : 'Password'} type="password" name="secret" autoComplete="new-password"
      hint={item ? 'Leave blank to keep the current value.' : undefined} maxLength={4096} required={!item} disabled={busy}/>
    {error && <p role="alert">{error}</p>}
    <div className="space-web-vault-actions"><Button variant="primary" type="submit" loading={busy}>Save</Button>
      <Button disabled={busy} onClick={onBack}>Cancel</Button></div>
  </form>;
}
