import { WorkspaceInvitations } from '../invitations/WorkspaceInvitations.js';
import { useEffect, useRef, useState } from 'react';
import { Select, Avatar, Badge, Button, Dialog, Menu } from '@space/ui/primitives';
import { DotsThree, MagnifyingGlass, Robot, UserPlus } from '@phosphor-icons/react';
import type { MemberRole, WorkspaceDirectory, WorkspaceDirectoryMember } from '@space/contracts';
import { request } from '../../../shared/api/request.js';
import { subscribeUpdates } from '../../../shared/realtime/live-updates.js';
import { WorkspaceMembers } from './WorkspaceMembers.js';
import './workspace-administration.css';

const roleNames = {owner:'Workspace Owner',admin:'Workspace Admin',member:'Member'};
const errors: Record<string,string> = {
  transfer_ownership_first:'Transfer primary ownership before changing or deactivating this account.',
  guest_role_conflict:'Guests must become full members before receiving an administrative role.',
  last_owner:'A workspace must have an owner. Make another person an owner before changing this account.',
  account_not_found:'No Space account has that email address. Ask them to create an account first.',
  member_already_exists:'This person is already a member. Use Change account type to update their role.',
  member_management_forbidden:'Your role does not allow this action. The member list has been refreshed.',
  not_found:'This workspace or account is no longer available.',
};
const errorText = (error:unknown) => error instanceof Error ? errors[error.message] ?? error.message.replaceAll('_',' ') : 'Unable to update members. Try again.';
type Props = {workspace:string;viewer:string;open:boolean;onClose:()=>void};
type Action = {kind:'role'|'deactivate'|'reactivate'|'transfer';member:WorkspaceDirectoryMember} | {kind:'add'};

export function WorkspaceAdministration(props:Props) {
  return props.open ? <MemberAdministration key={props.workspace} {...props}/> : null;
}
function MemberAdministration({workspace,viewer,onClose}:Props) {
  const [invitations,setInvitations]=useState(false),[agents,setAgents]=useState(false),[query,setQuery]=useState(''),[search,setSearch]=useState('');
  const [role,setRole]=useState('all'),[status,setStatus]=useState('active'),[sort,setSort]=useState('name'),[guest,setGuest]=useState('all');
  const [data,setData]=useState<WorkspaceDirectory>(),[cursor,setCursor]=useState<string>();
  const [history,setHistory]=useState<(string|undefined)[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState('');
  const [action,setAction]=useState<Action>(),[nextRole,setNextRole]=useState<MemberRole>('member'),[email,setEmail]=useState('');
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  const generation=useRef(0), alive=useRef(true), mutation=useRef(false);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++;};},[]);
  useEffect(()=>{const timer=setTimeout(()=>{setSearch(query.trim());setCursor(undefined);setHistory([]);},250);return()=>clearTimeout(timer);},[query]);
  const params=new URLSearchParams({limit:'25',q:search,role,status,sort,guest,...(cursor?{after:cursor}:{})}).toString();
  async function refresh() {
    const attempt=++generation.current;
    setLoading(true);
    try {
      const result=await request<WorkspaceDirectory>(`/workspaces/${workspace}/directory?${params}`);
      if(alive.current&&attempt===generation.current){setData(result);setError('');}
    } catch(reason) {
      if(alive.current&&attempt===generation.current){setError(errorText(reason));setData(undefined);}
    } finally {if(alive.current&&attempt===generation.current)setLoading(false);}
  }
  useEffect(()=>{
    setAction(undefined);
    const stop=subscribeUpdates('workspace',workspace,refresh,code=>{generation.current++;setData(undefined);setLoading(false);setAction(undefined);setError(errorText(new Error(code)));});
    return()=>{generation.current++;stop();};
  },[workspace,params]);
  const manager=data?.role==='owner'||data?.role==='admin';
  function begin(value:Action) {setError('');setNotice('');setNextRole(value.kind==='role'?value.member.role:'member');setEmail('');setAction(value);}
  async function save() {
    if(!action||mutation.current)return;
    mutation.current=true;setBusy(true);setError('');
    try {
      const base=`/workspaces/${workspace}/members`;
      if(action.kind==='add')await request(base,{email:email.trim(),role:'member'});
      else if(action.kind==='role')await request(`${base}/${action.member.user_id}`,{role:nextRole},undefined,'PATCH');
      else if(action.kind==='transfer')await request(`/workspaces/${workspace}/transfer-ownership`,{user_id:action.member.user_id});
      else if(action.kind==='deactivate')await request(`${base}/${action.member.user_id}`,undefined,undefined,'DELETE');
      else await request(base,{user_id:action.member.user_id,role:'member'});
      if(alive.current){setAction(undefined);setNotice(action.kind==='add'?'Person added to the workspace.':'Member updated.');await refresh();}
    } catch(reason) {if(alive.current){await refresh();if(alive.current)setError(errorText(reason));}}
    finally {mutation.current=false;if(alive.current)setBusy(false);}
  }
  async function exportMembers(){setError('');try{const response=await fetch(`/v1/workspaces/${workspace}/members.csv`,{credentials:'same-origin'});if(!response.ok){const result=await response.json();throw new Error(result.error);}const url=URL.createObjectURL(await response.blob());const link=document.createElement('a');link.href=url;link.download='workspace-members.csv';link.click();URL.revokeObjectURL(url);}catch(reason){if(alive.current)setError(errorText(reason));}}
  if(invitations)return <WorkspaceInvitations workspace={workspace} onClose={()=>setInvitations(false)}/>;
  if(agents)return <WorkspaceMembers workspace={workspace} viewer={viewer} open onClose={()=>setAgents(false)}/>;
  return <><Dialog open title="Manage members" description="Manage who belongs to your workspace and what they can do." onClose={onClose} onBeforeClose={()=>!mutation.current}>
    <section className="workspace-admin">
      <div className="workspace-admin-toolbar"><Button onClick={()=>setInvitations(true)}>Invitations</Button><Button onClick={()=>setAgents(true)}><Robot size={18}/> Agents & connections</Button>{manager&&<Button onClick={()=>void exportMembers()}>Export members</Button>}{manager&&<Button variant="primary" onClick={()=>begin({kind:'add'})}><UserPlus size={18}/> Add people</Button>}</div>
      <div className="workspace-admin-filters">
        <label className="workspace-admin-search"><MagnifyingGlass size={18}/><input type="search" aria-label="Find members" placeholder={manager?'Find by name, email or ID':'Find by name or ID'} maxLength={100} value={query} onChange={event=>setQuery(event.target.value)}/></label>
        <label>Account type<Select value={role} aria-label="Filter account type" onChange={event=>{setRole(event.target.value);setCursor(undefined);setHistory([]);}}><option value="all">All account types</option>{Object.entries(roleNames).map(([value,label])=><option key={value} value={value}>{label}</option>)}</Select></label>
        {manager&&<label>Status<Select aria-label="Status" value={status} onChange={event=>{setStatus(event.target.value);setCursor(undefined);setHistory([]);}}><option value="active">Active accounts</option><option value="deactivated">Deactivated accounts</option><option value="all">All accounts</option></Select></label>}
        <label>Sort by<Select aria-label="Sort members" value={sort} onChange={event=>{setSort(event.target.value);setCursor(undefined);setHistory([]);}}><option value="name">Name</option><option value="joined">Date joined</option><option value="id">Member ID</option></Select></label>
        <label>Guest access<Select aria-label="Filter guest access" value={guest} onChange={event=>{setGuest(event.target.value);setCursor(undefined);setHistory([]);}}><option value="all">Everyone</option><option value="none">Full members</option><option value="single">Single-channel guests</option><option value="multi">Multi-channel guests</option></Select></label>
      </div>
      {error&&<div role="alert" className="workspace-admin-feedback">{error}{!action&&<Button size="sm" onClick={()=>void refresh()}>Retry</Button>}</div>}
      {notice&&<p role="status">{notice}</p>}
      {loading&&<p role="status">Loading members…</p>}
      {!loading&&data&&<>
        <div className="workspace-admin-table"><table aria-label="Workspace members"><thead><tr><th>Name</th>{(manager||data.email_visible)&&<th>Email address</th>}<th>Account type</th><th>Status</th><th>Date joined</th><th><span className="workspace-admin-sr">Actions</span></th></tr></thead><tbody>
          {data.items.map(member=>{
            const canManage=data.role==='owner'||(data.role==='admin'&&member.role==='member');
            const primary=member.user_id===data.primary_owner_id;
            const items=member.active?[...(data.primary_owner_id===viewer&&member.user_id!==viewer&&(!member.guest_type||member.guest_type==='none')?[{label:'Transfer primary ownership',onSelect:()=>begin({kind:'transfer',member})}]:[]),...(data.role==='owner'&&!primary?[{label:'Change account type',onSelect:()=>begin({kind:'role',member})}]:[]),...(canManage&&!primary&&member.user_id!==viewer?[{label:'Deactivate account',danger:true,onSelect:()=>begin({kind:'deactivate',member})}]:[])]:manager?[{label:'Reactivate account',onSelect:()=>begin({kind:'reactivate',member})}]:[];
            return <tr key={member.user_id}><td><div className="workspace-admin-person"><Avatar name={member.display_name} initials={member.display_name.slice(0,2).toUpperCase()} size="sm"/><span><strong>{member.display_name}{member.user_id===viewer?' (you)':''}</strong><small>{member.user_id}</small></span></div></td>{(manager||data.email_visible)&&<td>{member.email||'—'}</td>}<td>{primary?'Primary Owner':member.guest_type==='single'?'Single-channel Guest':member.guest_type==='multi'?'Multi-channel Guest':roleNames[member.role]}</td><td><Badge tone={member.active?'success':'neutral'}>{member.active?'Active':'Deactivated'}</Badge></td><td>{new Date(member.joined_at).toLocaleDateString()}</td><td>{items.length>0&&<Menu floating label={`Actions for ${member.display_name}`} trigger={<DotsThree size={22}/>} items={items}/>}</td></tr>;
          })}
        </tbody></table></div>
        {data.items.length===0&&<div className="workspace-admin-empty"><strong>No members found</strong><p>Try a different name or adjust the filters.</p></div>}
        <footer className="workspace-admin-footer"><span>{data.items.length} {data.items.length===1?'person':'people'} on this page</span><div><Button size="sm" disabled={!history.length} onClick={()=>{setCursor(history.at(-1));setHistory(old=>old.slice(0,-1));}}>Previous</Button><Button size="sm" disabled={!data.next_cursor} onClick={()=>{setHistory(old=>[...old,cursor]);setCursor(data.next_cursor!);}}>Next</Button></div></footer>
      </>}
    </section>
  </Dialog>
    {action&&<Dialog open title={action.kind==='add'?'Add people':action.kind==='transfer'?`Transfer ownership to ${action.member.display_name}?`:action.kind==='role'?`Change account type for ${action.member.display_name}`:action.kind==='deactivate'?`Deactivate ${action.member.display_name}?`:`Reactivate ${action.member.display_name}?`} onClose={()=>setAction(undefined)} onBeforeClose={()=>!mutation.current}>
      <form className="workspace-admin-action" onSubmit={event=>{event.preventDefault();void save();}}>
        {action.kind==='add'?<><p>Add someone who already has a Space account. They’ll join as a member and can access this workspace’s public channels.</p><label>Email address<input type="email" required maxLength={254} autoFocus value={email} onChange={event=>setEmail(event.target.value)} disabled={busy}/></label></>:action.kind==='transfer'?<p>They will become the primary owner and can transfer ownership again. You will remain a workspace owner. This takes effect immediately.</p>:action.kind==='role'?<><label>Account type<Select aria-label="Account type" value={nextRole} onChange={event=>setNextRole(event.target.value as MemberRole)} disabled={busy}>{Object.entries(roleNames).map(([value,label])=><option key={value} value={value}>{label}</option>)}</Select></label><p>{nextRole==='owner'?'Owners can manage workspace settings, members and other owners.':nextRole==='admin'?'Admins can edit workspace settings and manage regular members.':'Members can participate in conversations. They cannot manage workspace settings or other accounts.'}</p></>:<p>{action.kind==='deactivate'?'They will lose workspace access. Their messages remain, their agents are disabled, and their channel memberships are removed.':'They will return with their existing guest restrictions, if any. Previous channel memberships and agent access are not restored.'}</p>}
        {error&&<p role="alert">{error}</p>}
        <div className="workspace-admin-action-buttons"><Button disabled={busy} onClick={()=>setAction(undefined)}>Cancel</Button><Button type="submit" variant={action.kind==='deactivate'?'danger':'primary'} loading={busy} disabled={action.kind==='role'&&nextRole===action.member.role}>{action.kind==='add'?'Add person':action.kind==='transfer'?'Transfer ownership':action.kind==='role'?'Save account type':action.kind==='deactivate'?'Deactivate':'Reactivate'}</Button></div>
      </form>
    </Dialog>}
  </>;
}
