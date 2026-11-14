import { useEffect, useRef, useState } from 'react';
import type { AgentSessionDetail, SidekickAgent, SidekickSession } from '@space/contracts';
import { Button, Select } from '@space/ui/primitives';
import { request } from '../../shared/api/request.js';
import { Connections } from '../connections/Connections.js';
import { AgentSessions } from './AgentSessions.js';
import './sidekick.css';

type BrowserTab = { tab: string; page: string; actor: string };
type Session = Pick<SidekickSession, 'id' | 'channel_id' | 'origin_thread_id'>;

export function BrowserSidekick({ workspace, viewer }: { workspace: string; viewer: string }) {
  const [tab, setTab] = useState<BrowserTab | null>(null);
  useEffect(() => window.spaceDesktop?.onBrowserSidekick?.(next => setTab(next?.actor === viewer ? next : null)), [viewer]);
  const [setup, setSetup] = useState<{ name: string; url: string; showGuide?: boolean; actor: string }>();
  useEffect(() => window.spaceDesktop?.onBrowserMcpSetup?.(site => {
    if (site.actor === viewer) setSetup(site);
  }), [viewer]);
  if (setup?.actor === viewer) return <Connections key={viewer} userId={viewer} suggested={setup} onClose={() => setSetup(undefined)} />;
  if (!tab) return null;
  function close() {
    if (tab) window.spaceDesktop?.dismissBrowserSidekick?.(tab.tab);
    setTab(null);
  }
  return <section aria-label="Private browser session" className="browser-sidekick">
    <BrowserDiscussion key={tab.tab} tab={tab} workspace={workspace} viewer={viewer} close={close}/>
  </section>;
}

function BrowserDiscussion({ tab, workspace, viewer, close }: {tab: BrowserTab; workspace: string; viewer: string; close: () => void}) {
  const [session, setSession] = useState<Session>();
  const [options, setOptions] = useState<{id: string; skill: string; label: string}[]>([]);
  const [choice, setChoice] = useState('');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(true);
  const [start, setStart] = useState('');
  const initialPage = useRef(tab.page).current;
  useEffect(() => {
    const controller = new AbortController();
    const signal = controller.signal;
    async function open() {
      setBusy(true); setError('');
      const id = await window.spaceDesktop?.browserSessionId?.(tab.tab, workspace);
      if (!id) throw new Error('Reopen Ask my agent from the browser tab.');
      try {
        const detail = await request<AgentSessionDetail>(`/agent-sessions/${id}`, undefined, undefined, 'POST', signal, viewer);
        if (!detail.context?.browser_url || detail.session.owner_id !== viewer || detail.session.workspace_id !== workspace)
          throw new Error('This browser session is unavailable.');
        if (!signal.aborted) setSession({ ...detail.session, channel_id: detail.context.channel_id });
        return;
      } catch (reason) {
        if (!(reason instanceof Error && reason.message === 'not_found')) throw reason;
      }
      const agents = await request<SidekickAgent[]>(`/workspaces/${workspace}/sidekick-agents?paired=true`, undefined, undefined, 'POST', signal, viewer);
      const available = agents.flatMap(agent => agent.capabilities.skills.map(skill => ({
        id: agent.id, skill, label: agent.capabilities.skills.length === 1 ? agent.name : agent.name + ' · ' + skill,
      })));
      if (signal.aborted) return;
      setOptions(available);
      const picked = available.length === 1 ? available[0] : available.find(a => a.id + '|' + a.skill === start);
      if (!picked) return;
      const created = await request<SidekickSession>(`/workspaces/${workspace}/sidekick-sessions`, {
        installation_id: picked.id, skill: picked.skill, client_session_id: id, source: { browser_url: initialPage },
      }, undefined, 'POST', signal, viewer);
      if (!signal.aborted) setSession(created);
    }
    void open().catch(reason => {
      if (!signal.aborted) setError(reason instanceof Error ? reason.message.replaceAll('_', ' ') : 'Could not open your browser session.');
    }).finally(() => { if (!signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [workspace, viewer, tab.tab, initialPage, start, retry]);

  if (session) return <AgentSessions key={session.id} initialSessionId={session.id} thread={session.origin_thread_id}
    channel={session.channel_id} viewerId={viewer} browserPage={tab.page} onAccessLost={close} onClose={close}/>;
  return <div className="sidekick-content">
    <h3>Ask my agent</h3>
    {busy ? <p role="status">Opening your private session…</p> : error ? <p role="alert">{error} <Button onClick={() => setRetry(n => n + 1)}>Retry</Button></p>
      : options.length ? <form onSubmit={event => { event.preventDefault(); setStart(choice); }}>
        <label>Paired agent<Select aria-label="Paired agent" required value={choice} onChange={event => setChoice(event.target.value)}>
          <option value="" disabled>Select your agent</option>
          {options.map(a => <option key={a.id + '|' + a.skill} value={a.id + '|' + a.skill}>{a.label}</option>)}
        </Select></label><Button type="submit" disabled={!choice}>Start private session</Button>
      </form> : <p>Pair an agent in Apps &amp; agents to ask about this tab. <Button onClick={() => setRetry(n => n + 1)}>Refresh</Button></p>}
    <Button variant="ghost" onClick={close}>Close</Button>
  </div>;
}
