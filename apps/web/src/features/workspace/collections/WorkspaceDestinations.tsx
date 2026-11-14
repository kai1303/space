import {WorkspaceDirectory} from './WorkspaceDirectory.js';
import { SessionDiscovery } from '../../agents/SessionDiscovery.js';
import { Workflows } from './Workflows.js';
import { useMemberProfile } from '../../profile/MemberProfile.js';
import { Connections } from '../../connections/Connections.js';
import { Huddles } from '../../huddles/Huddles.js';
import { WorkspaceMemory } from '../../memory/WorkspaceMemory.js';
import {useDestinationPresence} from '../../../shared/ui/useDestinationPresence.js';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Tabs, Select, Avatar, Badge, Button } from '@space/ui/primitives';
import { NavigationIcon, Spacebot } from '@space/ui/navigation';
import { ArrowRight, BookOpen, Books, Hash, MagnifyingGlass, PuzzlePiece, Robot, Sparkle, Users, TreeStructure } from '@phosphor-icons/react';
import type { AgentInstallation, ChannelSummary, Page, PairedConnector, WorkspaceParticipant, PublishedHelpWorkflow, WorkspaceWorkflow } from '@space/contracts';
import { request } from '../../../shared/api/request.js';
import { subscribeUpdates } from '../../../shared/realtime/live-updates.js';
import type { Snapshot } from '../../../shared/ui/view-state.js';
import type { SpacebotView } from './view-state.js';
import './workspace-destinations.css';

type View = 'directories' | 'agents' | 'spacebot' | 'huddles';
type Mode = 'people' | 'channels' | 'agents' | 'spacebot' | 'huddles' | 'workflows' | 'published-workflows' | 'managed-workflows' | 'none';
type Data = { published: PublishedHelpWorkflow[]; workflows: WorkspaceWorkflow[]; people: WorkspaceParticipant[]; channels: ChannelSummary[]; connectors: PairedConnector[]; installations: AgentInstallation[]; next: string | null };
const empty: Data = { published: [], workflows: [], people: [], channels: [], connectors: [], installations: [], next: null };
const failure = (error: unknown) => error instanceof Error ? error.message.replaceAll('_', ' ') : 'Unable to load this workspace';
const denied = (error: unknown) => error instanceof Error && ['unauthorized', 'not_found', 'forbidden'].includes(error.message);
const initials = (name: string) => name.trim().split(/\s+/).map(word => word[0]).slice(0, 2).join('').toUpperCase();
const statusTone = { online: 'success', offline: 'neutral', auth_required: 'warning', error: 'danger' } as const;
// Short labels so a badge fits beside the avatar on the narrowest agent card.
const statusText = { online: 'Online', offline: 'Offline', auth_required: 'Sign in', error: 'Needs attention' };
const unknownStatus = 'Unknown';

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
        const page = async <T,>(resource: string, extra = ''): Promise<Page<T>> => {
          const result = await request<Page<T>>(`/workspaces/${workspace}/${resource}${params}${extra}`, undefined, undefined, 'POST', signal);
          if (!Array.isArray(result.items)) throw new Error('Invalid directory response');
          return result;
        };
        let next = empty;
        if (mode === 'people') {
          const result = await page<WorkspaceParticipant>('participants');
          next = { ...empty, people: after ? [...current.people, ...result.items] : result.items, next: result.next_cursor };
        } else if (mode === 'workflows' || mode === 'published-workflows' || mode === 'managed-workflows') {
          const templates = after ? current.workflows : (await page<WorkspaceWorkflow>('workflows')).items;
          const result = mode !== 'workflows' && templates.length ? await page<PublishedHelpWorkflow>('workflows/published', mode === 'managed-workflows' ? '&mine=true' : '') : {items:[],next_cursor:null};
          next = { ...empty, workflows: templates, published: after ? [...current.published,...result.items] : result.items, next:result.next_cursor };

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
          next = { ...empty, people: people.items, connectors, installations, channels: channels.items, next: null };
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
  onNewDirect?:()=>void;
  onOpenHuddle?:(item:{channel_id:string;thread_id?:string})=>void;
  onConnectAgent?:(connector?:string)=>void;
  viewState?:Snapshot<SpacebotView>;onOpenConnection?:(id:string)=>void;
  view: View; workspace: string; viewer: string; onOpenChannel: (id: string) => void; onOpenMembers: () => void; onOpenAgents: () => void;
}) {
  if(props.view==='directories') return <WorkspaceDirectory key={props.workspace+':'+props.viewer} {...props}/>;
  if(props.view==='huddles') return <Huddles key={props.workspace} workspace={props.workspace} viewer={props.viewer} onOpenThread={props.onOpenHuddle} onOpenChannel={props.onOpenChannel}/>;
  return <Destination key={`${props.workspace}:${props.view}`} {...props} />;
}

function Destination({ onConnectAgent, viewState, onOpenConnection, view, workspace, viewer, onOpenChannel, onOpenMembers, onOpenAgents }: Parameters<typeof WorkspaceDestinations>[0]) {
  const present=useDestinationPresence();
  const profiles = useMemberProfile();
  const connectAgent = (connector?: string) => onConnectAgent ? onConnectAgent(connector) : onOpenMembers();
  const [newWorkflow,setNewWorkflow] = useState(false);
  const [workflowTab,setWorkflowTab] = useState('Templates');
  const [agentSection, setAgentSection] = useState('All agents');
  const [search, setSearch] = useState('');
  const [selectedAgent, setSelectedAgent] = useState(viewState?.current.agent??'');
  const [selectedChannel, setSelectedChannel] = useState(viewState?.current.channel??'');
  useLayoutEffect(()=>{if(viewState)viewState.current={agent:selectedAgent,channel:selectedChannel};},[viewState,selectedAgent,selectedChannel]);
  const [joining, setJoining] = useState(''), [actionError, setActionError] = useState('');
  const alive = useRef(true), opening = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const mode: Mode = view === 'agents' && ['Apps','Agent Sessions'].includes(agentSection) ? 'none' : view === 'agents' && agentSection === 'Memory' ? 'channels' : view === 'agents' && agentSection === 'Workflows' ? (workflowTab === 'Templates' ? 'workflows' : workflowTab === 'All' ? 'published-workflows' : 'managed-workflows') : view==='directories'?'none':view;
  const { data, loading, more, error, access, retry, loadMore } = useDestinationData(workspace, mode);
  const query = search.trim().toLocaleLowerCase();
  const matches = (...values: string[]) => values.join(' ').toLocaleLowerCase().includes(query);
  const usableChannels = data.channels.filter(channel => !channel.archived_at);
  const agentInfo = (installation: AgentInstallation) => {
    const connector = data.connectors.find(item => item.id === installation.connector_id);
    const participant = data.people.find(item => item.kind === 'agent' && item.id === installation.id);
    return { name: participant?.name ?? connector?.name ?? 'Workspace agent', connector, participant };
  };
  const installed = data.installations.filter(item => { const info = agentInfo(item); return matches(info.name, info.connector?.name ?? '', ...item.capabilities.skills); });
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
  const heading = view === 'directories' ? 'Directories' : view === 'agents' ? agentSection : view === 'spacebot' ? 'Spacebot' : 'Huddles';
  const channelChoices = <div className="wd-channel-choices">
    {usableChannels.length ? <><label>Channel<Select searchable aria-label="Channel" value={currentChannel?.id ?? ''} onChange={event => setSelectedChannel(event.target.value)}>{usableChannels.map(channel => <option key={channel.id} value={channel.id}># {channel.name}{channel.joined ? '' : ' · Join channel'}</option>)}</Select></label><Button variant={view === 'spacebot' && agentUnavailable ? 'secondary' : 'primary'} disabled={!currentChannel || Boolean(joining)} loading={Boolean(joining)} onClick={() => currentChannel && void openChannel(currentChannel)}>Open channel <NavigationIcon name="forward" size={16}/></Button></> : <p>No active channels are available. Create a channel from Home to start a discussion.</p>}
  </div>;
  return <div className={`workspace-destinations wd-${view}`}>
    {view === 'agents' && <aside className="wd-sidebar" aria-label="Agents and tools"><h2>Agents &amp; tools</h2>{([{ title: 'All agents', icon: <NavigationIcon name="agents" size={19}/> }, { title: 'Agent Sessions', icon: <Robot size={19}/> }, { title: 'Workflows', icon: <NavigationIcon name="workflow" size={19}/> }, { title: 'Apps', icon: <NavigationIcon name="apps" size={19}/> }, { title: 'Memory', icon: <BookOpen size={19} aria-hidden="true"/> }] as const).map(({ title, icon }) => <button key={title} type="button" aria-current={agentSection === title ? 'page' : undefined} onClick={() => { setAgentSection(title); setNewWorkflow(false); setSearch(''); }}>{icon}{title}</button>)}</aside>}
    <main className={`wd-main${view === 'agents' && agentSection === 'Workflows' ? ' wd-workflows' : ''}`} id="chat-messages" tabIndex={-1}>
      {view !== 'spacebot' && <header className="wd-header"><h1>{view === 'huddles' && <NavigationIcon name="huddles" size={21}/>}{heading}</h1>{view === 'agents' && agentSection === 'Workflows' && <Button size="sm" onClick={() => {setWorkflowTab('Templates'); setNewWorkflow(true);}}>New workflow</Button>}{view === 'agents' && agentSection === 'All agents' && <Button size="sm" onClick={() => connectAgent()}>Connect an agent</Button>}</header>}
      {view === 'agents' && agentSection === 'Workflows' && <Tabs className="wd-tabs" label="Workflows" value={workflowTab} onChange={setWorkflowTab}
        items={['All','Templates','Managed by you'].map(label=>({id:label,label}))}/>}
      <div className="wd-content">
        {(view === 'agents' && agentSection === 'All agents') && <label className="wd-search"><NavigationIcon name="search" size={19}/><input type="search" aria-label={'Search agents'} placeholder={'Search agents by name or skill'} value={search} onChange={event => setSearch(event.target.value)} /></label>}
        {(error || actionError) && <div className="wd-error" role="alert"><span>{actionError || error}</span>{error && <Button size="sm" onClick={retry}>Retry</Button>}</div>}
        {loading ? <p role="status" className="wd-loading">Loading {view === 'huddles' || agentSection === 'Memory' ? 'channels' : agentSection === 'Workflows' ? 'workflows' : 'agents'}…</p> : <>
          {view === 'agents' && agentSection === 'All agents' && <><div className="wd-section-heading"><div><h2>Your workspace agents</h2><p>Bring your own agents into your team’s conversations.</p></div></div><div className="wd-agent-grid">{installed.map(installation => { const info = agentInfo(installation); return <article key={installation.id} className="wd-agent-card"><div className="wd-agent-identity"><button type="button" className="space-profile-trigger" aria-label={`View ${info.name}’s profile`} onClick={() => profiles?.open({kind:'agent',id:installation.id})}><Avatar name={info.name} initials={initials(info.name)} tone="purple" size="lg" /></button><span role="status" data-state={!installation.enabled ? 'disabled' : info.participant?.status ?? 'unknown'}><Badge dot={installation.enabled} tone={installation.enabled && info.participant?.status ? statusTone[info.participant.status] : 'neutral'}>{!installation.enabled ? 'Disabled' : info.participant?.status ? statusText[info.participant.status] : unknownStatus}</Badge></span></div><h3 title={info.name}><button type="button" className="space-profile-trigger" aria-label={`View ${info.name}’s profile`} onClick={() => profiles?.open({kind:'agent',id:installation.id})}><span className="wd-agent-name">{info.name}</span></button></h3><span className="wd-agent-owner">{installation.owner_id === viewer ? 'Owned by you' : `Owned by ${data.people.find(person => person.id === installation.owner_id)?.name ?? 'a workspace member'}`}</span><Button size="sm" onClick={() => onOpenConnection ? onOpenConnection(installation.id) : onOpenMembers()}>View connection</Button></article>; })}</div>{!installed.length && !error && <Empty icon={<NavigationIcon name="agents" size={32}/>} title={query ? 'No agents match your search' : 'Make room for your first agent'} description={query ? 'Try another name or skill.' : 'Connect an agent to bring it into this workspace.'}>{!query && <Button onClick={() => connectAgent()}>Connect an agent</Button>}</Empty>}</>}
          {(mode === 'workflows' || mode === 'published-workflows' || mode === 'managed-workflows') && !error && <Workflows key={mode} workspace={workspace} templates={data.workflows} viewer={viewer} templatesTab={mode === 'workflows'} newWorkflow={newWorkflow} onCloseNew={() => setNewWorkflow(false)}
            published={data.published} managed={mode === 'managed-workflows'} onPublished={() => {setNewWorkflow(false); if (mode === 'managed-workflows') retry(); else setWorkflowTab('Managed by you');}}
            onOpenChannel={onOpenChannel} more={more} loadMore={data.next ? loadMore : undefined}/>}
          {view === 'agents' && agentSection === 'Agent Sessions' && <SessionDiscovery workspace={workspace} viewer={viewer}/>}
          {view === 'agents' && agentSection === 'Apps' && <Connections key={viewer} workspaceId={workspace} />}
          {view === 'agents' && agentSection === 'Memory' && !error && <WorkspaceMemory channels={data.channels} onOpenChannel={id => { const channel = data.channels.find(item => item.id === id); if (channel) void openChannel(channel); }}
            loadMore={data.next ? loadMore : undefined} loadingMore={more} />}
          {view === 'spacebot' && <section className="wd-bot-welcome" aria-labelledby="spacebot-greeting">
            <div className="wd-bot-greeting"><span className="wd-bot-mark"><Spacebot size={140}/></span><h2 id="spacebot-greeting">What would you like to work on?</h2></div>
            {currentAgent ? <div className="wd-bot-panel">
              <div className="wd-bot-options" role="group" aria-label="Choose an agent">
                {data.installations.filter(item => item.enabled).map(installation => {
                  const info = agentInfo(installation), selected = currentAgent.id === installation.id;
                  return <button type="button" key={installation.id} aria-pressed={selected} onClick={() => setSelectedAgent(installation.id)}>
                    <Avatar name={info.name} initials={initials(info.name)} tone="purple" />
                    <span><strong>{info.name}</strong><small>{info.participant?.status ? statusText[info.participant.status] : unknownStatus}</small></span>
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
            </div> : !error && <div className="wd-bot-panel wd-bot-connect"><h3>Connect your first agent</h3><p>Bring an agent into your workspace to start a conversation.</p><Button variant="primary" onClick={() => connectAgent()}>Connect an agent</Button></div>}
            <Button className="wd-bot-explore" variant="ghost" onClick={onOpenAgents}>Explore agents &amp; tools <NavigationIcon name="forward" size={16}/></Button>
          </section>}
        </>}
      </div>
    </main>
  </div>;
}

function Empty({ icon, title, description, children }: { icon: ReactNode; title: string; description: string; children?: ReactNode }) {
  return <section className="wd-empty"><span className="wd-empty-icon">{icon}</span><h2>{title}</h2><p>{description}</p>{children}</section>;
}
