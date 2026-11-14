import { useEffect, useState } from 'react';
import { Button, Spinner, toast } from '@space/ui/primitives';
import { request } from '../../shared/api/request.js';

type Hook = { id: string; name: string };
export function ChannelWebhooks({ channel }: { channel: string }) {
  const path = `/channels/${channel}/webhooks`;
  const [initialHooks, setInitialHooks] = useState<Hook[]>();
  const [changes, setChanges] = useState<Map<string, Hook | null>>(() => new Map());
  const [readError, setReadError] = useState('');
  // The initial list can arrive after a successful create or revoke.
  const hooks = new Map(initialHooks?.map(hook => [hook.id, hook]));
  for (const [id, hook] of changes) {
    if (hook) hooks.set(id, hook);
    else hooks.delete(id);
  }
  const [name, setName] = useState(''), [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{id: string; url: string}>(), [copied, setCopied] = useState(false);
  const [error, setError] = useState(''), [retry, setRetry] = useState(0);
  const [revoking, setRevoking] = useState<string>();
  const [pendingRevokes, setPendingRevokes] = useState<string[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    request<Hook[]>(path, undefined, undefined, 'POST', controller.signal).then(items => {
      if (!controller.signal.aborted) setInitialHooks(items);
    }).catch(e => {
      if (!controller.signal.aborted) setReadError(e.message);
    });
    return () => controller.abort();
  }, [path, retry]);
  async function create() {
    if (creating || !name.trim()) return;
    const submitted = name;
    setCreating(true); setError('');
    try {
      const hook = await request<Hook & { path: string }>(path, { name: name.trim() });
      setChanges(previous => new Map(previous).set(hook.id, { id: hook.id, name: hook.name }));
      setCreated({id: hook.id, url: new URL(hook.path, window.location.origin).href});
      setCopied(false); setName(current => current === submitted ? '' : current);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not create webhook'); }
    finally { setCreating(false); }
  }
  async function revoke(id: string) {
    if (pendingRevokes.includes(id)) return;
    setPendingRevokes(current => [...current, id]); setError('');
    try {
      await request(path + '/' + id, undefined, undefined, 'DELETE');
      setChanges(previous => new Map(previous).set(id, null));
      setCreated(current => current?.id === id ? undefined : current);
      setRevoking(current => current === id ? undefined : current);
      toast.success('Webhook revoked');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not revoke webhook'); }
    finally { setPendingRevokes(current => current.filter(item => item !== id)); }
  }
  return <div className="space-channel-webhooks">
    {error && <p role="alert">{error.replaceAll('_', ' ')}</p>}
    <form className="chat-form" onSubmit={e => { e.preventDefault(); void create(); }}>
      <label>Integration name<input value={name} maxLength={80} required placeholder="Build Bot" onChange={e => setName(e.target.value)} /></label>
      <Button type="submit" disabled={!name.trim()} loading={creating}>Create incoming webhook</Button>
    </form>
    {created && <div className="chat-form"><label>Webhook URL<input readOnly value={created.url} onFocus={e => e.target.select()} /></label>
      <p>Copy this secret URL now. Send a JSON POST with <code>{'{"text":"Build passed"}'}</code> to publish a message.</p>
      <Button onClick={() => { void navigator.clipboard.writeText(created.url).then(() => setCopied(true)).catch(() => setError('Select and copy the URL manually.')); }}>{copied ? 'Copied' : 'Copy URL'}</Button>
    </div>}
    {readError && <p role="alert">{readError.replaceAll('_', ' ')} <Button onClick={() => { setReadError(''); setRetry(n => n + 1); }}>Retry</Button></p>}
    {!initialHooks && !readError && <p className="space-channel-pending" role="status"><Spinner/>Loading webhooks…</p>}
    {[...hooks.values()].map(hook => <section key={hook.id}><div className="space-channel-field-heading"><h3>{hook.name}</h3>
      {revoking !== hook.id && !pendingRevokes.includes(hook.id) && <Button size="sm" onClick={() => setRevoking(hook.id)}>Revoke</Button>}</div>
      {(revoking === hook.id || pendingRevokes.includes(hook.id)) && <><p>Revoking this URL stops {hook.name} from posting.</p>
        <Button disabled={pendingRevokes.includes(hook.id)} onClick={() => setRevoking(undefined)}>Cancel</Button>
        <Button loading={pendingRevokes.includes(hook.id)} onClick={() => void revoke(hook.id)}>Revoke webhook</Button></>}
    </section>)}
  </div>;
}
