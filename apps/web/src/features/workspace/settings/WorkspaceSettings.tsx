import { workspacePath } from '@space/contracts';
import { useEffect, useId, useRef, useState } from 'react';
import { Select, Button, Dialog, Spinner, Tabs, toast } from '@space/ui/primitives';
import { workspacePreferenceDefaults, workspaceLanguages, type WorkspaceSettings as Settings, type WorkspaceSettingsUpdate } from '@space/contracts';
import { request } from '../../../shared/api/request.js';
import { subscribeUpdates } from '../../../shared/realtime/live-updates.js';
import '../members/workspace-administration.css';
import './workspace-settings.css';
import '../workspace-dialog-tabs.css';
type Props = {workspaceName?:string;workspace:string;open:boolean;onClose:()=>void;onRenamed:(name:string)=>void;onManageMembers?:()=>void};
const languageNames:Record<string,string> = {en:'English',vi:'Tiếng Việt',fr:'Français',de:'Deutsch',es:'Español',pt:'Português',ja:'日本語',ko:'한국어',zh:'中文'};
export function WorkspaceSettings(props:Props) {return props.open ? <SettingsDialog key={props.workspace} {...props}/> : null;}
function SettingsDialog({workspace,workspaceName,onClose,onRenamed,onManageMembers}:Props) {
  const [settings,setSettings] = useState<Settings>(), [draft,setDraft] = useState<Settings>();
  const [name,setName] = useState(''), [tab,setTab] = useState('settings'), [editing,setEditing] = useState(false);
  const [error,setError] = useState(''), [busy,setBusy] = useState(false), [notice,setNotice] = useState('');
  const [domains,setDomains] = useState('');
  const [pendingRetention,setPendingRetention] = useState<WorkspaceSettingsUpdate>();
  const active = useRef(true), generation = useRef(0), saving = useRef(false), dirty = useRef(false);
  const panelId = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) nameInput.current?.focus(); }, [editing]);
  const manager = settings?.role === 'owner' || settings?.role === 'admin';
  function resetDraft(item:Settings) {setDraft(item);setDomains(item.approved_email_domains.join(', '));setPendingRetention(undefined);dirty.current=false;}
  async function refresh(discard=false) {
    const attempt = ++generation.current;
    setError('');
    try {
      const response = await request<Settings>(`/workspaces/${workspace}/settings`);
      const item = {...workspacePreferenceDefaults,...response};
      if (active.current && attempt === generation.current) {
        setSettings(item);if (discard || !dirty.current || item.role === 'member') resetDraft(item);
        if (item.role === 'member') setEditing(false);setError('');
      }
    } catch(reason) {if (active.current && attempt === generation.current) setError(reason instanceof Error ? reason.message.replaceAll('_',' ') : 'Unable to load settings');}
  }
  useEffect(()=>{
    active.current=true;
    const stop=subscribeUpdates('workspace',workspace,()=>refresh(),()=>{generation.current++;setSettings(undefined);setDraft(undefined);setPendingRetention(undefined);setEditing(false);setError('You no longer have access to this workspace.');});
    return()=>{active.current=false;generation.current++;stop();};
  },[workspace]);
  function change<K extends keyof Settings>(key:K,value:Settings[K]) {dirty.current=true;setNotice('');setDraft(previous=>previous ? {...previous,[key]:value} : previous);}
  async function save(patch:WorkspaceSettingsUpdate, action?: 'rename' | 'retention') {
    if(saving.current || !manager)return;
    saving.current=true;setBusy(true);setError('');generation.current++;
    try {
      const saved=await request<Settings>(`/workspaces/${workspace}/settings`,patch,undefined,'PATCH');
      if (active.current) {
        generation.current++;
        const item = {...settings,...saved} as Settings;
        setSettings(item); resetDraft(item); setEditing(false);
        if (action === 'retention') toast.success('Message retention policy updated');
        else setNotice('Workspace settings saved.');
        if (action === 'rename') onRenamed(item.name);
      }
    } catch(reason){if(active.current)setError(reason instanceof Error?reason.message.replaceAll('_',' '):'Unable to update settings');}
    finally{saving.current=false;if(active.current)setBusy(false);}
  }
  async function uploadIcon(file:File|undefined) {
    if (!file) return;
    if (!['image/png','image/jpeg','image/webp'].includes(file.type) || file.size > 145_000) {setError('Choose a PNG, JPEG or WebP image smaller than 145 KB.');return;}
    try {const value=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=reject;reader.readAsDataURL(file);});if(active.current)change('icon_url',value);}
    catch {if(active.current)setError('Unable to read the workspace icon.');}
  }
  function savePreferences() {
    if (!draft || !settings || !manager || saving.current) return;
    const {revision,icon_url,slug,description,language,display_name_guidelines,email_visibility,invite_permission,create_channel_permission,retention_days}=draft;
    const update:WorkspaceSettingsUpdate = {revision,icon_url,slug,description,language,display_name_guidelines,email_visibility,invite_permission,create_channel_permission,retention_days,approved_email_domains:domains.split(/[,\n]/).map(value=>value.trim()).filter(Boolean)};
    if (draft.retention_days !== null && (settings.retention_days === null || draft.retention_days < settings.retention_days)) {
      setPendingRetention(update);
      return;
    }
    void save(update);
  }
  return <><Dialog open title="Workspace settings" onClose={onClose} onBeforeClose={()=>!saving.current&&!pendingRetention}>
    <section className="workspace-settings workspace-dialog-tabs">
      <Tabs label="Workspace settings sections" value={tab} onChange={setTab} items={[{id:'settings',label:'Settings',panelId},{id:'permissions',label:'Permissions',panelId}]}/>
      <div key={tab} id={panelId} role="tabpanel" aria-label={tab==='settings'?'Settings':'Permissions'}>
      {error&&<p role="alert">{error} <Button size="sm" disabled={busy} onClick={()=>void refresh(true)}>Reload settings</Button></p>}
      {notice&&<p role="status">{notice}</p>}
        {tab==='settings'&&(settings || workspaceName)&&<section className="workspace-settings-row"><header><div><h3>Workspace name</h3><p>Your workspace is called <strong>{settings?.name ?? workspaceName}</strong>.</p></div>{settings&&manager&&!editing&&<Button size="sm" aria-label="Edit workspace name" disabled={busy||dirty.current} onClick={()=>{setName(settings.name);setEditing(true);setNotice('');}}>Edit</Button>}</header>
          {settings&&editing&&manager&&<form onSubmit={event=>{event.preventDefault();void save({revision:settings.revision,name:name.trim()},'rename');}}><label>Workspace name<input ref={nameInput} required maxLength={100} value={name} onChange={event=>setName(event.target.value)} disabled={busy}/></label><div><Button type="submit" variant="primary" loading={busy} disabled={!name.trim()||name.trim()===settings.name}>Save changes</Button><Button disabled={busy} onClick={()=>setEditing(false)}>Cancel</Button></div></form>}
        </section>}
        {!settings && !error && <p className="workspace-settings-pending" role="status"><Spinner/>{tab === 'settings' ? 'Loading workspace settings…' : 'Loading workspace permissions…'}</p>}
        {settings&&draft&&<>
          {!manager&&<p>Only workspace owners and admins can change these settings.</p>}
        <form className="workspace-preferences-form" onSubmit={event=>{event.preventDefault();savePreferences();}}>
          <fieldset disabled={!manager||busy}>
          {tab==='settings'?<>
            <section className="workspace-settings-row"><h3>Workspace icon</h3><div className="workspace-icon-control">{draft.icon_url?<img src={draft.icon_url} width="64" height="64" alt="Workspace icon"/>:<span className="workspace-icon-placeholder" aria-hidden="true">{settings.name.slice(0,1).toUpperCase()}</span>}<label>Upload workspace icon<input type="file" accept="image/png,image/jpeg,image/webp" onChange={event=>void uploadIcon(event.target.files?.[0])}/></label>{draft.icon_url&&<Button size="sm" onClick={()=>change('icon_url',null)}>Remove icon</Button>}</div><p>PNG, JPEG or WebP, up to 145 KB.</p></section>
            <section className="workspace-settings-row"><h3>Workspace address</h3><label>URL slug<input maxLength={63} value={draft.slug??''} onChange={event=>change('slug',event.target.value||null)} placeholder="your-workspace"/></label><p>Use 3–63 letters, numbers and hyphens. Your workspace address: <code>{draft.slug?`/w/${draft.slug}`:workspacePath(workspace)}</code></p></section>
            <section className="workspace-settings-row"><h3>Description</h3><label>Workspace description<textarea maxLength={2000} rows={3} value={draft.description} onChange={event=>change('description',event.target.value)}/></label></section>
            <section className="workspace-settings-row"><h3>Language and names</h3><label>Workspace language<Select aria-label="Workspace language" value={draft.language} onChange={event=>change('language',event.target.value)}>{workspaceLanguages.map(language=><option key={language} value={language}>{languageNames[language]}</option>)}</Select></label><p>The shared language for this workspace. Interface text currently remains in English.</p><label>Display name guidelines<textarea rows={3} maxLength={2000} value={draft.display_name_guidelines} onChange={event=>change('display_name_guidelines',event.target.value)} placeholder="For example, use your first and last name."/></label></section>
            <section className="workspace-settings-row"><h3>Message retention</h3><label>Keep messages<Select aria-label="Keep messages" value={draft.retention_days===null?'forever':'days'} onChange={event=>change('retention_days',event.target.value==='forever'?null:90)}><option value="forever">Forever</option><option value="days">For a set number of days</option></Select></label>{draft.retention_days!==null&&<label>Retention days<input type="number" min={1} max={36500} required value={draft.retention_days} onChange={event=>change('retention_days',Number(event.target.value))}/></label>}<p>Message content and shared files older than this period are removed automatically; task audit records are retained. Changing this setting can permanently delete message history.</p></section>
          </>:<>
            <section className="workspace-settings-row"><h3>Invitations</h3><label>Who can invite people?<Select aria-label="Who can invite people?" value={draft.invite_permission} onChange={event=>change('invite_permission',event.target.value as 'admins'|'members')}><option value="admins">Workspace owners and admins</option><option value="members">All members</option></Select></label></section>
            <section className="workspace-settings-row"><h3>Channel creation</h3><label>Who can create channels?<Select aria-label="Who can create channels?" value={draft.create_channel_permission} onChange={event=>change('create_channel_permission',event.target.value as 'admins'|'members')}><option value="members">All members</option><option value="admins">Workspace owners and admins</option></Select></label></section>
            <section className="workspace-settings-row"><h3>Email addresses</h3><label>Who can see member email addresses?<Select aria-label="Who can see member email addresses?" value={draft.email_visibility} onChange={event=>change('email_visibility',event.target.value as 'admins'|'members')}><option value="admins">Workspace owners and admins</option><option value="members">All members</option></Select></label></section>
            <section className="workspace-settings-row"><h3>Approved email domains</h3><label>Domains allowed to join<textarea rows={3} value={domains} onChange={event=>{dirty.current=true;setDomains(event.target.value);setNotice('');}} placeholder="example.com, company.org"/></label><p>People with a verified email at these exact domains can join using the workspace address. Separate domains with commas. Leave empty to require an invitation.</p></section>

          </>}
          </fieldset>
          {manager&&<div className="workspace-settings-actions"><Button type="submit" variant="primary" loading={busy} disabled={!dirty.current||editing}>Save settings</Button><Button disabled={busy||!dirty.current} onClick={()=>{resetDraft(settings);setError('');}}>Discard changes</Button></div>}
        </form>
      </>}
      {tab==='permissions' && <section className="workspace-settings-row"><h3>Roles and permissions</h3><dl><dt>Workspace Owners</dt><dd>Manage workspace settings, members and account types. A workspace must retain at least one owner.</dd><dt>Workspace Admins</dt><dd>Manage settings and regular members. Only owners can change account types.</dd><dt>Members</dt><dd>Join public channels and participate in conversations. Private channels require membership.</dd></dl></section>}
        {tab==='settings'&&<section className="workspace-settings-row"><header><div><h3>Workspace members</h3><p>View people, account types and membership status.</p></div>{onManageMembers&&<Button size="sm" onClick={onManageMembers}>Manage members</Button>}</header></section>}
      </div>
    </section>
  </Dialog>
  {pendingRetention&&<Dialog open title="Apply retention policy?" onClose={()=>setPendingRetention(undefined)}>
    <p>This will permanently delete message content and shared files older than {pendingRetention.retention_days} days. Deleted content and files cannot be recovered. Task audit records are retained.</p>
    <p>Your other pending workspace settings will also be saved.</p>
    <div className="workspace-settings-actions">
      <Button onClick={()=>setPendingRetention(undefined)}>Cancel</Button>
      <Button variant="primary" onClick={()=>{const patch=pendingRetention;setPendingRetention(undefined);void save(patch,'retention');}}>Apply retention policy</Button>
    </div>
  </Dialog>}
  </>;
}
