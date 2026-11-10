import { useEffect, useState } from 'react';
import { Button } from '@space/ui/primitives';
import { request } from '../../shared/api/request.js';

type Hook = { id: string; name: string };
export function ChannelWebhooks({ channel }: { channel: string }) {
  const path = `/channels/${channel}/webhooks`;
  const [hooks, setHooks] = useState<Hook[]>();
  const [name, setName] = useState(''), [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{id: string; url: string}>(), [copied, setCopied] = useState(false);
  const [error, setError] = useState(''), [retry, setRetry] = useState(0);
  const [revoking, setRevoking] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    request<Hook[]>(path, undefined, undefined, 'POST', controller.signal).then(setHooks).catch(e => {
      if (!controller.signal.aborted) setError(e.message);
    });
    return () => controller.abort();
  }, [path, retry]);
  async function create() {
    setBusy(true); setError('');
    try {
      const hook = await request<Hook & { path: string }>(path, { name: name.trim() });
      setHooks(items => [...(items ?? []), {id: hook.id, name: hook.name}]);
      setCreated({id: hook.id, url: new URL(hook.path, window.location.origin).href});
      setCopied(false); setName('');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not create webhook'); }
    finally { setBusy(false); }
  }
  async function revoke(id: string) {
    setBusy(true); setError('');
    try {
      await request(path + '/' + id, undefined, undefined, 'DELETE');
      setHooks(items => items?.filter(item => item.id !== id));
      if (created?.id === id) setCreated(undefined);
      setRevoking(undefined);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not revoke webhook'); }
    finally { setBusy(false); }
  }
  return <div className="space-channel-card"><section><h3>Incoming webhooks</h3>
    <p>Give an external service a URL to post messages in this channel.</p>
    {error && <p role="alert">{error.replaceAll('_', ' ')} {!hooks && <Button onClick={() => { setError(''); setRetry(n => n+1); }}>Retry</Button>}</p>}
    {hooks ? <form className="chat-form" onSubmit={e => { e.preventDefault(); if (!busy && name.trim()) void create(); }}>
      <label>Integration name<input value={name} maxLength={80} required placeholder="Build Bot" onChange={e => setName(e.target.value)} /></label>
      <Button type="submit" disabled={!name.trim() || busy}>Create incoming webhook</Button>
    </form> : !error && <p role="status">Loading webhooks…</p>}
    {created && <div className="chat-form"><label>Webhook URL<input readOnly value={created.url} onFocus={e => e.target.select()} /></label>
      <p>Copy this secret URL now. Send a JSON POST with <code>{'{"text":"Build passed"}'}</code> to publish a message.</p>
      <Button onClick={() => { void navigator.clipboard.writeText(created.url).then(() => setCopied(true)).catch(() => setError('Select and copy the URL manually.')); }}>{copied ? 'Copied' : 'Copy URL'}</Button>
    </div>}
  </section>
    {hooks?.map(hook => <section key={hook.id}><div className="space-channel-field-heading"><h3>{hook.name}</h3>
      {revoking !== hook.id && <Button size="sm" disabled={busy} onClick={() => setRevoking(hook.id)}>Revoke</Button>}</div>
      {revoking === hook.id && <><p>Revoking this URL stops {hook.name} from posting.</p>
        <Button disabled={busy} onClick={() => setRevoking(undefined)}>Cancel</Button>
        <Button disabled={busy} onClick={() => void revoke(hook.id)}>Revoke webhook</Button></>}
    </section>)}
  </div>;
}
