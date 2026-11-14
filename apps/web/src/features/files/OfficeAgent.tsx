import { useEffect, useRef, useState } from 'react';
import type { DocumentEditBlock } from '@space/contracts';
import { AgentResponse } from '@space/ui/agents';
import { Button } from '@space/ui/primitives';

type Reply = { id: string; status: 'selected' | 'empty' | 'changed' | 'applied' | 'error'; text?: string };

export function OfficeAgent({ serverUrl, editorId, sessionKey, title }: { title: string; serverUrl: string; editorId: string; sessionKey: string }) {
  const port = useRef<MessagePort | null>(null);
  const pending = useRef<((result: Reply | null) => void) | null>(null);
  const generation = useRef(0);
  const [connected, setConnected] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [open, setOpen] = useState(false);
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [proposal, setProposal] = useState<DocumentEditBlock>();
  const [review, setReview] = useState<'ready' | 'revising' | 'applying' | 'applied' | 'blocked'>('ready');
  const [feedback, setFeedback] = useState('');
  const feedbackInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (review === 'revising') feedbackInput.current?.focus(); }, [review]);
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
    setProposal(undefined);
    setReview('ready');
    setFeedback('');
    setOpen(false);
  }
  async function ask(revision?: DocumentEditBlock) {
    const request = revision ? feedback.trim() : goal.trim();
    if (busy || !request || !window.spaceOffice?.ask) return;
    const run = ++generation.current;
    setBusy(true);
    try {
      let original: string;
      if (revision) {
        original = revision.original;
      } else {
        setProposal(undefined);
        setReview('ready');
        setStatus('Reading selection…');
        const selected = await send('read');
        if (run !== generation.current) return;
        if (selected?.status !== 'selected' || !selected.text) {
          setStatus('Select up to 16,000 characters in the document, then ask again.'); return;
        }
        original = selected.text;
      }
      setStatus('Drafting…');
      const result = await window.spaceOffice.ask(request, original, sessionKey, revision?.replacement);
      if (run !== generation.current) return;
      if (result.replacement === undefined) { setStatus(result.message); return; }
      setProposal({ id: crypto.randomUUID(), type: 'document_edit', title, original, replacement: result.replacement });
      setReview('ready');
      setFeedback('');
      setStatus('Edit ready for review.');
    } catch (error) {
      if (run === generation.current) setStatus(error instanceof Error && error.message.includes('sign-in') ? 'Sign in to the Codex CLI on this Mac, then retry.' : 'Space AI could not complete the request. Check the document and retry.');
    } finally { if (run === generation.current) setBusy(false); }
  }
  async function apply(edit: DocumentEditBlock) {
    if (busy || review !== 'ready' || edit !== proposal) return;
    const run = ++generation.current;
    setBusy(true);
    setReview('applying');
    setStatus('Applying edit…');
    try {
      await window.spaceOffice!.checkEditAccess(sessionKey);
      if (run !== generation.current) return;
      const done = await send('apply', edit.replacement);
      if (run !== generation.current) return;
      setReview(done?.status === 'applied' ? 'applied' : 'blocked');
      if (done?.status === 'applied') setStatus('Edited the selection.');
      else if (done?.status === 'changed' || done?.status === 'empty') setStatus('The selection changed. Select the passage and send a new request.');
      else setStatus('Could not confirm the edit. Check the document before trying again.');
    } catch {
      if (run === generation.current) {
        setReview('blocked');
        setStatus('Could not verify editing access. Reopen the document to try again.');
      }
    } finally { if (run === generation.current) setBusy(false); }
  }
  if (!open) return <Button variant="ghost" onClick={() => setOpen(true)}>Ask Space AI</Button>;
  return <div className="office-agent-panel">
    <form className="office-agent-form" onSubmit={e => { e.preventDefault(); void ask(); }}>
      <input aria-label="Ask Space AI about the selection" maxLength={1000} value={goal} disabled={busy || review === 'revising'}
        placeholder="Ask about or rewrite selected text…" onChange={e => setGoal(e.target.value)}/>
      <Button type="submit" disabled={busy || review === 'revising' || !connected || !goal.trim()}>Send</Button>
      <Button type="button" variant="ghost" disabled={review === 'applying'} onClick={cancel}>{busy ? 'Cancel' : 'Close'}</Button>
    </form>
    <output aria-live="polite">{connected ? status : unavailable ? 'The Space AI plugin is unavailable on this document server.' : 'Waiting for the Space AI editor plugin…'}</output>
    {proposal && <AgentResponse response={{ messages: [], tools: [], components: [proposal] }}
      documentEditActions={edit => {
        if (review === 'revising') return <form className="office-agent-form" onSubmit={e => { e.preventDefault(); void ask(edit); }}>
          <input ref={feedbackInput} aria-label="Requested changes" placeholder="What should change?" maxLength={1000}
            value={feedback} disabled={busy} onChange={e => setFeedback(e.target.value)}/>
          <Button type="submit" size="sm" disabled={busy || !feedback.trim()}>Revise draft</Button>
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setReview('ready')}>Back</Button>
        </form>;
        if (review !== 'ready') return null;
        return <>
          <Button type="button" size="sm" variant="primary" onClick={() => void apply(edit)}>Apply edit</Button>
          <Button type="button" size="sm" variant="secondary" onClick={() => setReview('revising')}>Request changes</Button>
        </>;
      }}/>}
  </div>;
}
