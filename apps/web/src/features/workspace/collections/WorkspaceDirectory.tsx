import { motionTransition } from '@space/ui/motion';
import {useContext,useEffect,useId,useRef,useState} from 'react';
import {motion,useReducedMotion} from 'motion/react';
import {Buildings,CaretDown,Check,EnvelopeSimple,Hash,Lock,MagnifyingGlass,User,Users,X} from '@phosphor-icons/react';
import {Button,IconButton,ListRowSkeleton,Menu,Tabs} from '@space/ui/primitives';
import type {ChannelSummary,Page,WorkspaceDirectoryMember,WorkspaceInvitation} from '@space/contracts';
import {request} from '../../../shared/api/request.js';
import {subscribeUpdates} from '../../../shared/realtime/live-updates.js';
import {useDestinationPresence} from '../../../shared/ui/useDestinationPresence.js';
import {useMemberProfile} from '../../profile/MemberProfile.js';
import {WorkspaceInvitations} from '../invitations/WorkspaceInvitations.js';
import './workspace-directory.css';

import {DirectoryCreateChannel} from '../../channels/create-channel-context.js';
const icons = {People:User, Channels:Hash, External:Buildings, Invitations:EnvelopeSimple};
type Tab = keyof typeof icons;
type Item = WorkspaceDirectoryMember | ChannelSummary | WorkspaceInvitation;

function useDirectoryPage(workspace:string, path:string, pages:number) {
  const [snapshot,setSnapshot]=useState<{path:string;items:Item[];next:string|null;error?:string}>();
  const [attempt,retry]=useState(0);
  const permitted=useRef(false);
  useEffect(()=>{
    let active=true,version=0,controller:AbortController|undefined;
    const stop=subscribeUpdates('workspace',workspace,async()=>{
      controller?.abort();controller=new AbortController();
      const current=++version;
      try{
        // Refresh the visible pages together so revoked rows disappear from earlier pages too.
        const items:Item[]=[];
        let next:string|null=null;
        for(let index=0;index<pages;index++){
          const url=next?path+'&after='+encodeURIComponent(next):path;
          const result:Page<Item>=await request(url,undefined,undefined,'POST',controller.signal);
          if(!active||current!==version)return;
          items.push(...result.items);
          next=result.next_cursor;
          if(!next)break;
        }
        permitted.current=true;
        setSnapshot({path,items,next});
      }catch(reason){
        if(!active||current!==version)return;
        permitted.current=false;
        setSnapshot({path,items:[],next:null,error:reason instanceof Error?reason.message.replaceAll('_',' '):'Unable to load directory'});
      }
    },code=>{
      active=false;version++;controller?.abort();permitted.current=false;
      setSnapshot({path,items:[],next:null,error:code.replaceAll('_',' ')});
    });
    return ()=>{active=false;version++;permitted.current=false;controller?.abort();stop();};
  },[workspace,path,pages,attempt]);
  return {page:snapshot?.path===path?snapshot:undefined,permitted,retry:()=>retry(n=>n+1)};
}

function Filter({label,value,options,onChange}:{label:string;value:string;options:[string,string][];onChange:(s:string)=>void}){
  const current=options.find(([key])=>key===value)?.[1]||value||label;
  return <Menu floating label={label} trigger={<>{current}<CaretDown size={12}/></>} items={options.map(([key,name])=>({
    label:name,icon:key===value?<Check size={14}/>:undefined,onSelect:()=>onChange(key),
  }))}/>;
}

function DirectoryBanner({tab,workspace,viewer,action}:{tab:'People'|'Channels';workspace:string;viewer:string;action:()=>void}){
  const key='space:directory-intro:'+workspace+':'+viewer+':'+tab;
  const [closed,setClosed]=useState(()=>{try{return localStorage.getItem(key)==='1';}catch{return false;}});
  const people=tab==='People';
  if(closed)return null;
  return <section className="directory-banner">
    <div><h2>{people?'Invite your team to Space':'Organize your team’s conversations'}</h2>
      <p>{people?'Bring your team members into Space to start working together. Invite people by email or share an invitation link.':'Channels bring people, messages, files, and tools together. Create one for a project, team, or topic.'}</p>
      <Button onClick={action}>{people?'Invite people':'Create a channel'}</Button>
    </div>
    <IconButton label={'Dismiss '+tab.toLowerCase()+' introduction'} onClick={()=>{setClosed(true);try{localStorage.setItem(key,'1');}catch{/* session only */}}}><X size={18}/></IconButton>
  </section>;
}

type Props={workspace:string;viewer:string;onOpenChannel:(id:string)=>void;onOpenMembers:()=>void;onNewDirect?:()=>void};
export function WorkspaceDirectory(props:Props){
  const [tab,setTab]=useState<Tab>('People');
  const id=useId();
  return <main className="directory-page" id="chat-messages" tabIndex={-1}>
    <header><h1>Directories</h1><Tabs label="Directory" value={tab} onChange={value=>setTab(value as Tab)} items={(Object.keys(icons) as Tab[]).map(name=>{
      const Icon=icons[name];return {id:name,label:name,icon:<Icon size={14} weight={tab===name?'fill':'regular'}/>,panelId:id};
    })}/></header>
    <DirectoryTab key={tab} {...props} tab={tab} panelId={id}/>
  </main>;
}

function DirectoryTab({workspace,viewer,onOpenChannel,onOpenMembers,onNewDirect,tab,panelId}:Props&{tab:Tab;panelId:string}){
  const profiles=useMemberProfile(),createChannel=useContext(DirectoryCreateChannel);
  const present=useDestinationPresence(),reduced=useReducedMotion();
  const [query,setQuery]=useState(''),[sort,setSort]=useState('id'),[role,setRole]=useState('all');
  const [title,setTitle]=useState(''),[zone,setZone]=useState(''),[membership,setMembership]=useState('all'),[type,setType]=useState('all');
  const [inviteKind,setInviteKind]=useState('email'),[manager,showManager]=useState(false),[joining,setJoining]=useState(''),[writeError,setWriteError]=useState('');
  const busy=useRef(false);
  const [search,setSearch]=useState('');
  useEffect(()=>{const timer=setTimeout(()=>setSearch(query.trim()),150);return()=>clearTimeout(timer);},[query]);
  const people=tab==='People',channels=tab==='Channels',external=tab==='External',invitations=tab==='Invitations';
  const params=new URLSearchParams({limit:'100'});
  if(search)params.set('q',search);
  if(channels){params.set('directory','1');params.set('membership',membership);params.set('type',type);params.set('sort',sort);}
  if(people||external){params.set('sort',sort);if(role!=='all')params.set('role',role);if(title)params.set('title',title);if(zone)params.set('time_zone',zone);if(external)params.set('guest','any_guest');}
  if(invitations){params.set('status','all');params.set('kind',inviteKind);}
  const path='/workspaces/'+workspace+'/'+(channels?'channels':invitations?'invitations':'directory')+'?'+params;
  const [windowSize,setWindowSize]=useState({path,pages:1});
  const pages=windowSize.path===path?windowSize.pages:1;
  const {page,permitted,retry}=useDirectoryPage(workspace,path,pages);
  const peopleRows=people||external?(page?.items??[]) as WorkspaceDirectoryMember[]:[];
  const filtersFor=(field:'title'|'time_zone',value:string,label:string):[string,string][]=>[
    ['',label], ...[...new Set([...peopleRows.map(row=>row[field]),value].filter((v):v is string=>!!v))].sort().map((v):[string,string]=>[v,v]),
  ];
  async function open(channel:ChannelSummary){
    if(busy.current || !permitted.current)return;
    busy.current=true;setJoining(channel.id);setWriteError('');
    try{
      if(!channel.joined)await request('/channels/'+channel.id+'/join',{});
      if(permitted.current && present.current)onOpenChannel(channel.id);
    }catch(e){if(permitted.current)setWriteError(e instanceof Error?e.message.replaceAll('_',' '):'Could not join channel');}
    finally{busy.current=false;setJoining('');}
  }
  const primary=channels?createChannel:()=>showManager(true);
  const searchLabel=channels?'Search channels':external?'Search external connections':'Search people';
  return <section id={panelId} role="tabpanel" aria-label={tab} className="directory-panel">
    {!invitations && <div className="directory-searchbar"><label><MagnifyingGlass size={20}/><input type="search" aria-label={searchLabel} autoFocus maxLength={100} placeholder={external?'Search guests by name or email address':'Search for '+tab.toLowerCase()} value={query} onChange={e=>setQuery(e.target.value)}/></label>
      {external && createChannel && <Button onClick={createChannel}>Create Channel</Button>}{external && onNewDirect?<Button onClick={onNewDirect}>Start a DM</Button>:primary && <Button onClick={primary}>{channels?'Create Channel':external?'Invite guests':'Invite People'}</Button>}</div>}
    <div className={'directory-scroll directory-scroll--'+tab.toLowerCase()}>
      {external && !search && <section className="directory-external">
        <header><div><h2>Work with people outside your workspace in Space</h2>
          <p>Collaborate with clients, vendors, and partners by inviting them as guests to the channels they need.</p></div>
          <img src="/illustrations/directory-external.svg" alt=""/></header>
        <div className="directory-external-actions"><article><h3>Invite people to a channel</h3>
          <p>Give a guest access to selected channels in your workspace.</p><Button onClick={()=>showManager(true)}>Invite guests</Button></article>
          {onNewDirect && <article><h3>Talk one-on-one</h3><p>Start a direct message with someone in your workspace.</p><Button onClick={onNewDirect}>Start a DM</Button></article>}</div>
      </section>}
      {(people||channels) && primary && <DirectoryBanner workspace={workspace} viewer={viewer} tab={channels?'Channels':'People'} action={primary}/>}
      <div className="directory-body">
        <div className="directory-filters" aria-label="Filter by">
          {people && <><Filter label="Title" value={title} options={filtersFor('title',title,'Title')} onChange={setTitle}/><Filter label="Time zone" value={zone} options={filtersFor('time_zone',zone,'Time zone')} onChange={setZone}/>
            <Filter label="Account type" value={role} options={[[ 'all','More'],['owner','Owner'],['admin','Admin'],['member','Member']]} onChange={setRole}/></>}
          {channels && <><Filter label="Filter channels" value={membership} options={[[ 'all','All channels'],['joined','Channels you’ve joined'],['other','Other channels']]} onChange={setMembership}/>
            <Filter label="Filter by channel type" value={type} options={[[ 'all','Any channel type'],['public','Public'],['private','Private'],['archived','Archived']]} onChange={setType}/></>}
          {invitations ? <><Filter label="Invitation type" value={inviteKind} options={[[ 'email','Email invitations'],['link','Invite links']]} onChange={setInviteKind}/><Button size="sm" onClick={()=>showManager(true)}>Manage invitations</Button></>
          :<span className="directory-sort"><Filter label="Sort" value={sort} options={[[ 'id','Default order'],['name','A to Z'],['name_desc','Z to A']]} onChange={setSort}/></span>}
        </div>
        {!page && <ListRowSkeleton label={`Loading ${tab.toLowerCase()}…`} />}
        {(page?.error||writeError) && <div role="alert" className="wd-error"><span>{invitations && ['invite forbidden','invitation forbidden'].includes(page?.error??'')?'Contact a workspace admin to manage invitations.':page?.error||writeError}</span>{page?.error&&<Button size="sm" onClick={retry}>Retry</Button>}</div>}
        {page && !page.error && <motion.div initial={{opacity:reduced?1:0}} animate={{opacity:1}} transition={motionTransition(reduced)}>
          {(people||external) && !!peopleRows.length && <ul className="directory-people" aria-label="People results">{peopleRows.map(person=><li key={person.user_id}>
            <button aria-label={'View '+person.display_name+'’s profile'} onClick={()=>profiles?.open({kind:'user',id:person.user_id})}>
              {person.image?<img alt="" src={person.image}/>:<span className="directory-avatar" data-color={person.user_id.charCodeAt(0)%4}><User size="90%" weight="fill"/></span>}
              <span className="directory-person-copy"><strong>{person.display_name}</strong>{person.user_id===viewer&&' (you)'} <i aria-label={person.presence==='active'?'Active':'Away'} data-active={person.presence==='active'}/>{person.title&&<small>{person.title}</small>}</span>
            </button></li>)}</ul>}
          {channels && !!page.items.length && <ul className="directory-channels" aria-label="Channel results">{(page.items as ChannelSummary[]).map(channel=><li key={channel.id}>
            <button disabled={!!joining||(!channel.joined&&!!channel.archived_at)} aria-label={(channel.joined?'Open ':'Join ')+channel.name} onClick={()=>void open(channel)}>
              <strong>{channel.private?<Lock size={16}/>:<Hash size={16}/>} {channel.name}</strong>
              <span>{channel.joined&&<b>✓ Joined</b>}{channel.archived_at&&<em>Archived</em>}{channel.member_count!=null&&<em>{channel.member_count} {channel.member_count===1?'member':'members'}</em>}{(channel.description||channel.topic)&&<em>{channel.description||channel.topic}</em>}</span>
              <small>{joining===channel.id?'Opening…':channel.joined?'Open':'Join channel'}</small>
            </button></li>)}</ul>}
          {invitations && !!page.items.length && <ul className="directory-invites">{(page.items as WorkspaceInvitation[]).map(i=><li key={i.id}><EnvelopeSimple/><strong>{i.email||'Invite link'}</strong><span>{i.status}</span><time>{new Date(i.created_at).toLocaleDateString()}</time></li>)}</ul>}
          {!page.items.length && <section className="directory-empty">
            {external?<Buildings size={40}/>:invitations?<img src="/illustrations/directory-invitations.png" width={120} height={120} alt=""/>:channels?<Hash size={40}/>:<Users size={40}/>}
            <h2>{invitations?'Track your invitations':external&&!query?'No guests in this directory yet':channels?'No channels match your search':'No people match your search'}</h2>
            <p>{invitations?'Invitations you can manage and their status appear here.':external&&!query?'Invite guests to collaborate in selected workspace channels.':'Try another search or change your filters.'}</p>
            {invitations&&<Button onClick={()=>showManager(true)}>{external?'Invite guests to a channel':'Invite people'}</Button>}
          </section>}
        </motion.div>}
        {page?.next && (pages<5?<Button onClick={()=>setWindowSize({path,pages:pages+1})}>Load more {tab.toLowerCase()}</Button>:<p>Showing 500 results. Use search or filters to narrow the list.</p>)}
        {people && <button className="directory-manage" onClick={onOpenMembers}>Manage members</button>}
      </div>
    </div>
    {manager&&<WorkspaceInvitations workspace={workspace} onClose={()=>showManager(false)}/>}
  </section>;
}
