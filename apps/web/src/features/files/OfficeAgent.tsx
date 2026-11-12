import { useEffect, useRef, useState } from 'react';
import { Button } from '@space/ui/primitives';

type Reply = { id: string; status: 'selected' | 'empty' | 'changed' | 'applied' | 'error'; text?: string };

export function OfficeAgent({ serverUrl, editorId, sessionKey }: { serverUrl: string; editorId: string; sessionKey: string }) {
  const port = useRef<MessagePort | null>(null);
  const pending = useRef<((result: Reply | null) => void) | null>(null);
  const generation = useRef(0);
  const [connected, setConnected] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [open, setOpen] = useState(false);
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [proposal, setProposal] = useState('');
  const currentRequest = useRef('');
  useEffect(() => {
    const origin = new URL(serverUrl).origin;
    const timeout = setTimeout(() => setUnavailable(true), 15000);
    const connect = (event: MessageEvent) => {
      if (event.origin !== origin || event.data?.type !== 'space-office-selection-ready' || event.ports.length !== 1) return;
      // Match the editor containing this plugin, even with multiple previews mounted.
      const frame = document.querySelector<HTMLIFrameElement>(`[data-office-editor="${CSS.escape(editorId)}"] iframe`);
      if (!frame?.contentWindow || !(event.source && 'parent' in event.source) || event.source.parent !== frame.contentWindow) return;
      if (port.current) return;
      clearTimeout(timeout);
      const channel = event.ports[0]!;
      port.current = channel;
      channel.onmessage = e => {
        if (e.data?.id === currentRequest.current) pending.current?.(e.data);
      };
      setConnected(true);
    };
    window.addEventListener('message', connect);
    return () => {
      clearTimeout(timeout);
      window.removeEventListener('message', connect);
      ++generation.current;
      pending.current?.(null);
      port.current?.close();
      port.current = null;
      window.spaceOffice?.cancel?.();
    };
  }, [serverUrl, editorId]);

  function send(action: 'read' | 'apply', text?: string) {
    return new Promise<Reply | null>(resolve => {
      if (!port.current) return resolve(null);
      const id = crypto.randomUUID();
      currentRequest.current = id;
      const timer = setTimeout(() => pending.current?.(null), 6000);
      pending.current = reply => { clearTimeout(timer); pending.current = null; resolve(reply); };
      port.current.postMessage({ id, action, text });
    });
  }
  function cancel() {
    ++generation.current;
    pending.current?.(null);
    window.spaceOffice?.cancel?.();
    setBusy(false);
    setStatus('');
    setProposal('');
    setOpen(false);
  }
  async function ask() {
    if (busy || !goal.trim() || !window.spaceOffice?.ask) return;
    const run = ++generation.current;
    setBusy(true); setProposal(''); setStatus('Reading selection…');
    try {
      const selected = await send('read');
      if (run !== generation.current) return;
      if (selected?.status !== 'selected' || !selected.text) {
        setStatus('Select up to 16,000 characters in the document, then ask again.'); return;
      }
      setStatus('Drafting…');
      const result = await window.spaceOffice.ask(goal, selected.text, sessionKey);
      if (run !== generation.current) return;
      if (result.replacement === undefined) { setStatus(result.message); return; }
      setStatus('Applying edit…');
      const done = await send('apply', result.replacement);
      if (run !== generation.current) return;
      if (done?.status === 'applied') { setStatus('Edited the selection.'); return; }
      setProposal(result.replacement);
      setStatus(done?.status === 'changed' || done?.status === 'empty'
        ? 'The selection changed. Review the proposed text below.' : 'Could not confirm the edit. Check the document before retrying.');
    } catch (error) {
      if (run === generation.current) setStatus(error instanceof Error && error.message.includes('sign-in') ? 'Sign in to the Codex CLI on this Mac, then retry.' : 'Space AI could not complete the request. Check the document and retry.');
    } finally { if (run === generation.current) setBusy(false); }
  }
  if (!open) return <Button variant="ghost" onClick={() => setOpen(true)}>Ask Space AI</Button>;
  return <form className="office-agent-form" onSubmit={e => { e.preventDefault(); void ask(); }}>
    <input aria-label="Ask Space AI about the selection" maxLength={1000} value={goal} disabled={busy}
      placeholder="Ask about or rewrite selected text…" onChange={e => setGoal(e.target.value)}/>
    <Button type="submit" disabled={busy || !connected || !goal.trim()}>Send</Button>
    <Button type="button" variant="ghost" onClick={cancel}>{busy ? 'Cancel' : 'Close'}</Button>
    <output aria-live="polite">{connected ? status : unavailable ? 'The Space AI plugin is unavailable on this document server.' : 'Waiting for the Space AI editor plugin…'}</output>
    {proposal && <textarea aria-label="Proposed replacement" readOnly value={proposal}/>}
  </form>;
}
