import {useDestinationPresence} from '../../../shared/ui/useDestinationPresence.js';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Avatar, Button } from '@space/ui/primitives';
import { NavigationIcon, type NavigationIconName } from '@space/ui/navigation';
import { ArrowRight, Books, Headphones, Hash, MagnifyingGlass, Microphone, PuzzlePiece, Robot, Sparkle, Users, VideoCamera, TreeStructure } from '@phosphor-icons/react';
import type { AgentInstallation, ChannelSummary, Page, PairedConnector, WorkspaceParticipant } from '@space/contracts';
import { request } from '../../../shared/api/request.js';
import { subscribeUpdates } from '../../../shared/realtime/live-updates.js';
import type { Snapshot } from '../../../shared/ui/view-state.js';
import type { SpacebotView } from './view-state.js';
import './workspace-destinations.css';

type View = 'directories' | 'agents' | 'spacebot' | 'huddles';
type Mode = 'people' | 'channels' | 'agents' | 'spacebot' | 'huddles' | 'none';
type Data = { people: WorkspaceParticipant[]; channels: ChannelSummary[]; connectors: PairedConnector[]; installations: AgentInstallation[]; next: string | null };
const empty: Data = { people: [], channels: [], connectors: [], installations: [], next: null };
const failure = (error: unknown) => error instanceof Error ? error.message.replaceAll('_', ' ') : 'Unable to load this workspace';
const denied = (error: unknown) => error instanceof Error && ['unauthorized', 'not_found', 'forbidden'].includes(error.message);
const initials = (name: string) => name.trim().split(/\s+/).map(word => word[0]).slice(0, 2).join('').toUpperCase();
const statusText = { online: 'Online', offline: 'Offline', auth_required: 'Sign-in required', error: 'Connection needs attention' };

function useDestinationData(workspace: string, mode: Mode) {
  const key = `${workspace}:${mode}`;
  const [state, setState] = useState({ key, data: empty, loading: mode !== 'none', more: false, error: '' });
  const access = useRef(true);
  const retry = useRef<() => Promise<void>>(async () => {});
  const more = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    let active = true, revision = 0, controller: AbortController | undefined;
    let current = empty;
    access.current = true;
    setState({ key, data: empty, loading: mode !== 'none', more: false, error: '' });
    const read = async (after?: string) => {
      if (!active || mode === 'none') return;
      const version = ++revision;
      controller?.abort(); controller = new AbortController();
      const signal = controller.signal;
      setState(old => ({ ...old, error: '', more: Boolean(after) }));
      try {
        const params = `?limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`;
        const page = async <T,>(resource: string): Promise<Page<T>> => {
          const result = await request<Page<T>>(`/workspaces/${workspace}/${resource}${params}`, undefined, undefined, 'POST', signal);
          if (!Array.isArray(result.items)) throw new Error('Invalid directory response');
          return result;
        };
        let next = empty;
        if (mode === 'people') {
          const result = await page<WorkspaceParticipant>('participants');
          next = { ...empty, people: after ? [...current.people, ...result.items] : result.items, next: result.next_cursor };
        } else if (mode === 'channels' || mode === 'huddles') {
          const result = await page<ChannelSummary>('channels');
          next = { ...empty, channels: after ? [...current.channels, ...result.items] : result.items, next: result.next_cursor };
        } else {
          const [people, connectors, installations, channels] = await Promise.all([
            page<WorkspaceParticipant>('participants'),
            request<PairedConnector[]>('/agents/connectors', undefined, undefined, 'POST', signal),
            request<AgentInstallation[]>(`/agents/installations?workspace_id=${encodeURIComponent(workspace)}`, undefined, undefined, 'POST', signal),
            mode === 'spacebot' ? page<ChannelSummary>('channels') : Promise.resolve({ items: [], next_cursor: null }),
          ]);
          if (!Array.isArray(connectors) || !Array.isArray(installations)) throw new Error('Invalid agent response');
          next = { people: people.items, connectors, installations, channels: channels.items, next: null };
        }
        if (active && version === revision) {
          current = next; access.current = true;
          setState({ key, data: next, loading: false, more: false, error: '' });
        }
      } catch (error) {
        if (active && version === revision && !(error instanceof Error && error.name === 'AbortError')) {
          if (denied(error)) { current = empty; access.current = false; }
          setState({ key, data: current, loading: false, more: false, error: failure(error) });
        }
      }
    };
    retry.current = () => read();
    more.current = () => current.next ? read(current.next) : Promise.resolve();
    const stop = mode === 'none' ? () => {} : subscribeUpdates('workspace', workspace, () => read(), code => {
      active = false; access.current = false; revision++; controller?.abort(); current = empty;
      setState({ key, data: empty, loading: false, more: false, error: failure(new Error(code)) });
    });
    return () => { active = false; access.current = false; revision++; controller?.abort(); stop(); };
  }, [key, workspace, mode]);
  return { ...(state.key === key ? state : { key, data: empty, loading: mode !== 'none', more: false, error: '' }), access, retry: () => void retry.current(), loadMore: () => void more.current() };
}

export function WorkspaceDestinations(props: {
  viewState?:Snapshot<SpacebotView>;onOpenConnection?:(id:string)=>void;
  view: View; workspace: string; viewer: string; onOpenChannel: (id: string) => void; onOpenMembers: () => void; onOpenAgents: () => void;
}) {
  return <Destination key={`${props.workspace}:${props.view}`} {...props} />;
}

function Destination({ viewState, onOpenConnection, view, workspace, viewer, onOpenChannel, onOpenMembers, onOpenAgents }: Parameters<typeof WorkspaceDestinations>[0]) {
  const present=useDestinationPresence();
  const [directory, setDirectory] = useState('People');
  const [agentSection, setAgentSection] = useState('All agents');
  const [agentTab, setAgentTab] = useState('Installed agents');
  const [search, setSearch] = useState('');
  const [selectedAgent, setSelectedAgent] = useState(viewState?.current.agent??'');
  const [selectedChannel, setSelectedChannel] = useState(viewState?.current.channel??'');
  useLayoutEffect(()=>{if(viewState)viewState.current={agent:selectedAgent,channel:selectedChannel};},[viewState,selectedAgent,selectedChannel]);
  const [joining, setJoining] = useState(''), [actionError, setActionError] = useState('');
  const alive = useRef(true), opening = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const mode: Mode = view === 'directories' ? directory === 'People' ? 'people' : directory === 'Channels' ? 'channels' : 'none' : view === 'agents' ? 'agents' : view;
  const { data, loading, more, error, access, retry, loadMore } = useDestinationData(workspace, mode);
  const query = search.trim().toLocaleLowerCase();
  const matches = (...values: string[]) => values.join(' ').toLocaleLowerCase().includes(query);
  const people = data.people.filter(person => person.kind === 'human' && matches(person.name));
  const channels = data.channels.filter(channel => matches(channel.name, channel.topic, channel.description));
  const usableChannels = data.channels.filter(channel => !channel.archived_at);
  const agentInfo = (installation: AgentInstallation) => {
    const connector = data.connectors.find(item => item.id === installation.connector_id);
    const participant = data.people.find(item => item.kind === 'agent' && item.id === installation.id);
    return { name: participant?.name ?? connector?.name ?? 'Workspace agent', connector, participant };
  };
  const installed = data.installations.filter(item => { const info = agentInfo(item); return matches(info.name, info.connector?.name ?? '', ...item.capabilities.skills); });
  const available = data.connectors.filter(item => matches(item.name, ...item.capabilities.skills));
  const currentAgent = data.installations.find(item => item.id === selectedAgent && item.enabled) ?? data.installations.find(item => item.enabled);
  const currentAgentStatus = currentAgent ? agentInfo(currentAgent).participant?.status : undefined;
  const agentUnavailable = currentAgentStatus !== 'online';
  const currentChannel = usableChannels.find(item => item.id === selectedChannel) ?? usableChannels.find(item => item.joined) ?? usableChannels[0];
  async function openChannel(channel: ChannelSummary) {
    if (opening.current) return;
    opening.current = true; setJoining(channel.id); setActionError('');
    try {
      if (!channel.joined) await request(`/channels/${channel.id}/join`, {});
      if (alive.current && access.current && present.current) onOpenChannel(channel.id);
    } catch (reason) { if (alive.current) setActionError(failure(reason)); }
    finally { opening.current = false; if (alive.current) setJoining(''); }
  }
  const switchDirectory = (tab: string) => { setDirectory(tab); setSearch(''); setActionError(''); };
  const heading = view === 'directories' ? 'Directories' : view === 'agents' ? agentSection : view === 'spacebot' ? 'Spacebot' : 'Huddles';
  const channelChoices = <div className="wd-channel-choices">
    {usableChannels.length ? <><label>Channel<select value={currentChannel?.id ?? ''} onChange={event => setSelectedChannel(event.target.value)}>{usableChannels.map(channel => <option key={channel.id} value={channel.id}># {channel.name}{channel.joined ? '' : ' · Join channel'}</option>)}</select></label><Button variant={view === 'spacebot' && agentUnavailable ? 'secondary' : 'primary'} disabled={!currentChannel || Boolean(joining)} loading={Boolean(joining)} onClick={() => currentChannel && void openChannel(currentChannel)}>Open channel <NavigationIcon name="forward" size={16}/></Button></> : <p>No active channels are available. Create a channel from Home to start a discussion.</p>}
  </div>;
  return <div className={`workspace-destinations wd-${view}`}>
    {view === 'agents' && <aside className="wd-sidebar" aria-label="Agents and tools"><h2>Agents &amp; tools</h2>{([{ title: 'All agents', icon: 'agents' }, { title: 'Workflows', icon: 'workflow' }, { title: 'Apps', icon: 'apps' }] as const).map(({ title, icon }) => <button key={title} type="button" aria-current={agentSection === title ? 'page' : undefined} onClick={() => { setAgentSection(title); setSearch(''); }}><NavigationIcon name={icon} size={19}/>{title}</button>)}</aside>}
    <main className="wd-main" id="chat-messages" tabIndex={-1}>
      <header className="wd-header"><h1>{view === 'directories' && <NavigationIcon name="directories" size={21}/>}{view === 'spacebot' && <NavigationIcon name="spacebot" size={21}/>}{view === 'huddles' && <NavigationIcon name="huddles" size={21}/>}{heading}</h1>{view === 'directories' && <Button size="sm" onClick={onOpenMembers}><Users size={16} /> Manage members</Button>}{view === 'agents' && <Button size="sm" onClick={onOpenMembers}>Connect an agent</Button>}</header>
      {view === 'directories' && <Tabs label="Directory" items={['People', 'Channels', 'External', 'Invitations']} selected={directory} onSelect={switchDirectory} />}
      {view === 'agents' && agentSection === 'All agents' && <Tabs label="Agent catalog" items={['Installed agents', 'Available connectors']} selected={agentTab} onSelect={tab => { setAgentTab(tab); setSearch(''); }} />}
      <div className="wd-content">
        {(view === 'directories' && ['People', 'Channels'].includes(directory) || view === 'agents' && agentSection === 'All agents') && <label className="wd-search"><NavigationIcon name="search" size={19}/><input type="search" aria-label={`Search ${view === 'directories' ? directory.toLowerCase() : 'agents'}`} placeholder={view === 'directories' ? `Search ${directory.toLowerCase()}` : 'Search agents by name or skill'} value={search} onChange={event => setSearch(event.target.value)} /></label>}
        {(error || actionError) && <div className="wd-error" role="alert"><span>{actionError || error}</span>{error && <Button size="sm" onClick={retry}>Retry</Button>}</div>}
        {loading ? <p role="status" className="wd-loading">Loading {view === 'directories' ? directory.toLowerCase() : view === 'huddles' ? 'channels' : 'agents'}…</p> : <>
          {view === 'directories' && directory === 'People' && <><div className="wd-section-heading"><h2>People in your workspace</h2><span>{people.length} people{data.next ? ' loaded' : ''}</span></div>{people.length ? <ul className="wd-people">{people.map(person => <li key={person.id}><Avatar name={person.name} initials={initials(person.name)} size="lg" tone="blue" /><strong>{person.name}</strong><span>{person.id === viewer ? 'You' : 'Workspace member'}</span></li>)}</ul> : !error && <Empty icon={<Users size={30} />} title={query ? 'No people match your search' : 'No people to show'} description={query ? 'Try another name.' : 'Workspace members will appear here.'} />}</>}
          {view === 'directories' && directory === 'Channels' && <><div className="wd-section-heading"><h2>Explore channels</h2><span>{channels.length} channels{data.next ? ' loaded' : ''}</span></div>{channels.length ? <ul className="wd-channels">{channels.map(channel => <li key={channel.id}><span className="wd-channel-icon"><NavigationIcon name="channel" size={22}/></span><div><strong>{channel.name}</strong><p>{channel.topic || channel.description || 'A place for your team’s conversations.'}</p><small>{channel.private ? 'Private channel' : 'Public channel'}{channel.archived_at ? ' · Archived' : ''}{channel.joined ? ' · Joined' : ''}</small></div><Button size="sm" aria-label={`${channel.joined ? 'Open' : 'Join'} ${channel.name}`} disabled={Boolean(joining)} loading={joining === channel.id} onClick={() => void openChannel(channel)}>{channel.joined ? 'Open' : 'Join channel'}</Button></li>)}</ul> : !error && <Empty icon={<Hash size={30} />} title={query ? 'No channels match your search' : 'No channels yet'} description={query ? 'Try another channel name or topic.' : 'Create your first channel from Home.'} />}</>}
          {view === 'directories' && directory === 'External' && <Empty icon={<Users size={34} />} title="Your team, together in Space" description="Shared channels with external organizations are not available in Space. This directory contains members of your workspace."><Button onClick={() => switchDirectory('People')}>Browse workspace members</Button></Empty>}
          {view === 'directories' && directory === 'Invitations' && <Empty icon={<Users size={34} />} title="Workspace invitations" description="An invitation directory is not available in Space. You can view current members and pair a local agent in workspace members."><Button onClick={onOpenMembers}>Open workspace members</Button></Empty>}
          {view === 'agents' && agentSection === 'All agents' && <><div className="wd-section-heading"><div><h2>{agentTab === 'Installed agents' ? 'Your workspace agents' : 'Connect an agent to Space'}</h2><p>{agentTab === 'Installed agents' ? 'Bring your own agents into your team’s conversations.' : 'Available connectors registered with this Space server.'}</p></div></div><div className="wd-agent-grid">{agentTab === 'Installed agents' ? installed.map(installation => { const info = agentInfo(installation); return <article key={installation.id} className="wd-agent-card"><Avatar name={info.name} initials={initials(info.name)} tone="purple" size="lg" /><h3>{info.name}</h3><span className="wd-agent-status">{!installation.enabled ? 'Disabled' : info.participant?.status ? statusText[info.participant.status] : 'Installed'}{installation.owner_id === viewer ? ' · Owned by you' : ''}</span><p>{installation.capabilities.skills.join(' · ') || 'No skills advertised'}</p><Button size="sm" onClick={onOpenMembers}>View connection</Button></article>; }) : available.map(connector => <article key={connector.id} className="wd-agent-card"><span className="wd-connector-icon"><NavigationIcon name="spacebot" size={28}/></span><h3>{connector.name}</h3><span className="wd-agent-status">{data.installations.some(item => item.connector_id === connector.id) ? 'Installed in this workspace' : 'Available connector'}</span><p>{connector.capabilities.skills.join(' · ') || 'No skills advertised'}</p><Button size="sm" onClick={onOpenMembers}>Connect {connector.name}</Button></article>)}</div>{!(agentTab === 'Installed agents' ? installed : available).length && !error && <Empty icon={<NavigationIcon name="agents" size={32}/>} title={query ? 'No agents match your search' : agentTab === 'Installed agents' ? 'Make room for your first agent' : 'No connectors available'} description={query ? 'Try another name or skill.' : agentTab === 'Installed agents' ? 'Pair a local agent to bring it into this workspace.' : 'This server has no registered connectors.'}>{agentTab === 'Installed agents' && !query && <Button onClick={onOpenMembers}>Connect an agent</Button>}</Empty>}</>}
          {view === 'agents' && agentSection === 'Workflows' && <Empty icon={<NavigationIcon name="workflow" size={38}/>} title="Build momentum with your agents" description="A workflow builder and third-party workflow automations are not available in Space. Installed agents can run their advertised skills in channel discussions."><Button onClick={() => { setAgentSection('All agents'); setAgentTab('Installed agents'); }}>View installed agents</Button></Empty>}
          {view === 'agents' && agentSection === 'Apps' && <Empty icon={<NavigationIcon name="apps" size={38}/>} title="Tools that join the conversation" description="Space currently supports registered agent connectors. A third-party app marketplace is not available."><Button onClick={() => { setAgentSection('All agents'); setAgentTab('Available connectors'); }}>Browse connectors</Button></Empty>}
          {view === 'spacebot' && <section className="wd-bot-welcome" aria-labelledby="spacebot-greeting">
            <div className="wd-bot-greeting"><span className="wd-bot-mark"><NavigationIcon name="spacebot" size={30} active/></span><h2 id="spacebot-greeting">What would you like to work on?</h2></div>
            {currentAgent ? <div className="wd-bot-panel">
              <div className="wd-bot-options" role="group" aria-label="Choose an agent">
                {data.installations.filter(item => item.enabled).map(installation => {
                  const info = agentInfo(installation), selected = currentAgent.id === installation.id;
                  return <button type="button" key={installation.id} aria-pressed={selected} onClick={() => setSelectedAgent(installation.id)}>
                    <Avatar name={info.name} initials={initials(info.name)} tone="purple" />
                    <span><strong>{info.name}</strong><small>{info.participant?.status ? statusText[info.participant.status] : 'Status unavailable'}</small></span>
                    <span className="wd-bot-selection" aria-hidden="true">{selected ? '✓' : ''}</span>
                  </button>;
                })}
              </div>
              <div className="wd-bot-guidance" role="status">
                <p>{agentUnavailable
                  ? currentAgentStatus === 'offline' ? 'This agent is offline. Check its connection, or open a channel to continue with your team.'
                    : currentAgentStatus === 'auth_required' ? 'Sign in to this agent before starting a session.'
                    : currentAgentStatus === 'error' ? 'This agent’s connection needs attention before it can respond.'
                    : 'This agent’s availability could not be confirmed. Check its connection before starting a session.'
                  : 'Open a channel and mention this agent to start a session. The agent must be enabled in that channel.'}</p>
                {agentUnavailable && <Button variant="primary" size="sm" onClick={()=>onOpenConnection?onOpenConnection(currentAgent.id):onOpenMembers()}>View connection</Button>}
              </div>
              {channelChoices}
            </div> : !error && <div className="wd-bot-panel wd-bot-connect"><h3>Connect your first agent</h3><p>Bring an agent into your workspace to start a conversation.</p><Button variant="primary" onClick={onOpenMembers}>Connect an agent</Button></div>}
            <Button className="wd-bot-explore" variant="ghost" onClick={onOpenAgents}>Explore agents &amp; tools <NavigationIcon name="forward" size={16}/></Button>
          </section>}
          {view === 'huddles' && <section className="wd-huddles"><div className="wd-huddle-scene" aria-hidden="true"><span className="wd-huddle-person"><Avatar name="Audio conversation" initials="" size="lg" tone="blue" /><Microphone size={30} /></span><span className="wd-huddle-wave"><i /><i /><i /><i /><i /></span><span className="wd-huddle-person"><Avatar name="Video conversation" initials="" size="lg" tone="purple" /><VideoCamera size={30} /></span><span className="wd-huddle-headphones"><Headphones size={32} /></span></div><h2>A little conversation goes a long way</h2><p>Huddles bring people together for quick audio and video conversations.</p><div className="wd-huddle-note"><strong>Audio and video calling are not available in Space.</strong><p>Keep the conversation going in a channel. Open a channel and start a discussion with your team.</p></div>{channelChoices}</section>}
          {view === 'directories' && data.next && <Button className="wd-load-more" loading={more} onClick={loadMore}>Load more {directory.toLowerCase()}</Button>}
        </>}
      </div>
    </main>
  </div>;
}
function Tabs({ label, items, selected, onSelect }: { label: string; items: string[]; selected: string; onSelect: (item: string) => void }) {
  return <nav className="wd-tabs" aria-label={label}>{items.map(item => <button type="button" key={item} aria-current={selected === item ? 'page' : undefined} onClick={() => onSelect(item)}>{({People:'people',Channels:'channel-search',External:'external',Invitations:'invitations'} as Record<string,NavigationIconName>)[item] && <NavigationIcon name={({People:'people',Channels:'channel-search',External:'external',Invitations:'invitations'} as Record<string,NavigationIconName>)[item]!} size={17} active={selected===item}/>} {item}</button>)}</nav>;
}
function Empty({ icon, title, description, children }: { icon: ReactNode; title: string; description: string; children?: ReactNode }) {
  return <section className="wd-empty"><span className="wd-empty-icon">{icon}</span><h2>{title}</h2><p>{description}</p>{children}</section>;
}
