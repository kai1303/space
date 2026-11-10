import { useRef, useState, type FormEvent } from 'react';
import { Button, Dialog, IconButton } from '@space/ui/primitives';
import { CaretDown, Check, FileText, Headset, PencilSimple, TreeStructure, X } from '@phosphor-icons/react';
import type { PublishedHelpWorkflow, WorkspaceWorkflow } from '@space/contracts';
import { request } from '../../../shared/api/request.js';

type Form = { kind: 'setup' } | {kind:'edit';workflow:PublishedHelpWorkflow} | { kind: 'request'; workflow: PublishedHelpWorkflow };

export function Workflows({ workspace, viewer, templates, published, managed, templatesTab, newWorkflow, onCloseNew, onPublished, onOpenChannel, more, loadMore }: {
  viewer:string; templatesTab:boolean; newWorkflow:boolean; onCloseNew:()=>void;
  workspace: string; templates: WorkspaceWorkflow[]; published: PublishedHelpWorkflow[]; managed: boolean;
  onPublished: () => void; onOpenChannel: (id: string) => void; more: boolean; loadMore?: () => void;
}) {
  const [form, setForm] = useState<Form | null>(null);
  const [started, setStarted] = useState<{ channel_id: string } | null>(null);
  const template = templates[0];
  const routes = template?.destinations.filter(route => route.channel.joined) ?? [];
  const [preview,setPreview] = useState(false);
  const [featured,setFeatured] = useState(true);
  const bannerKey = `space.workflow-banner.${workspace}.${viewer}`;
  const [banner,setBanner] = useState(() => { try {return localStorage.getItem(bannerKey) !== 'dismissed';} catch {return true;} });
  const card = <button type="button" className="wf-template" aria-label="Preview IT Help Request" onClick={() => setPreview(true)}>
    <span className="wf-template-icon"><Headset weight="bold" size={21}/></span><strong>IT Help Request</strong>
    <span className="wf-template-description">Route IT requests by urgency and notify the requester when someone claims one.</span>
  </button>;
  const closePreview = () => {setPreview(false); onCloseNew();};
  return <>
    {templatesTab && <>
      {banner && <section className="wf-banner" aria-labelledby="wf-banner-title">
        <div><h2 id="wf-banner-title">Start with a workflow template</h2>
          <p>Choose a template, set where requests go, and publish it for your team.</p></div>
        <div className="wf-banner-art" aria-hidden="true">
          <span><FileText weight="fill"/></span><span><TreeStructure weight="bold"/></span><span><Check weight="bold"/></span>
        </div>
        <button type="button" className="wf-dismiss" aria-label="Dismiss template introduction" onClick={() => {
          setBanner(false); try {localStorage.setItem(bannerKey,'dismissed');} catch { /* Session-only dismissal. */ }
        }}><X size={18}/></button>
      </section>}
      <section aria-label="Featured templates" className="wf-gallery">
        <h2><button type="button" className="wf-toggle" aria-expanded={featured} onClick={() => setFeatured(!featured)}>
          <CaretDown size={14}/> Featured templates</button></h2>
        {featured && <div className="wf-template-grid">{card}</div>}
      </section>
      <section aria-label="All templates" className="wf-gallery"><h2>All templates</h2><div className="wf-template-grid">{card}</div></section>
    </>}
    {!templatesTab && <section aria-label={managed ? 'Workflows managed by you' : 'Published workflows'} className="wf-gallery">
      <h2>{managed ? 'Workflows managed by you' : 'Published workflows'}</h2>
      {published.length ? <ul className="wf-list">{published.map(item => <li key={item.id}>
        <TreeStructure size={20}/><div><strong>{item.name}</strong><small>Published</small></div>
        {managed && item.settings && <IconButton label={`Edit ${item.name}`} onClick={() => setForm({kind:'edit',workflow:item})}><PencilSimple size={18}/></IconButton>}
        <Button size="sm" onClick={() => { setStarted(null); setForm({kind:'request',workflow:item}); }}>Start request</Button>
      </li>)}</ul> : <p>{managed ? 'Workflows you publish will appear here.' : 'Set up a template to publish the first workflow.'}</p>}
      {loadMore && <Button size="sm" loading={more} onClick={loadMore}>Load more workflows</Button>}
    </section>}
    {(preview || newWorkflow) && <Dialog open title="IT Help Request" onClose={closePreview}>
      <div className="wf-preview"><h3>Workflow steps</h3><ol>
        <li>Collect a description and urgency from the requester.</li>
        <li>Post the request in the channel for that urgency.</li>
        <li>Wait for someone to claim it, then send the requester a confirmation DM.</li>
      </ol>
      {!routes.length && <p>{template ? 'Join a configured request channel to set up this template.' : 'Connect the workflow service to publish this template.'}</p>}
      <Button variant="primary" disabled={!routes.length} onClick={() => {closePreview(); setForm({kind:'setup'});}}>Set up</Button></div>
    </Dialog>}
    {started && <div className="wf-receipt" role="status">Request started. <Button size="sm" onClick={() => onOpenChannel(started.channel_id)}>Open request channel</Button></div>}
    {form && <WorkflowForm workspace={workspace} form={form} routes={routes} onClose={() => setForm(null)}
      onPublished={() => {setForm(null); onPublished();}} onStarted={result => {setForm(null); setStarted(result);}}/>}
  </>;
}

function WorkflowForm({ workspace, form, routes, onClose, onPublished, onStarted }: {
  workspace: string; form: Form; routes: WorkspaceWorkflow['destinations']; onClose: () => void;
  onPublished: () => void; onStarted: (result: {channel_id: string}) => void;
}) {
  const setup = form.kind !== 'request';
  const edit = form.kind === 'edit' ? form.workflow : undefined;
  const channels = [...new Map(routes.map(({ channel }) => [channel.id, channel])).values()];
  const initial = (urgency: string) => routes.find(route => route.urgency === urgency)?.channel.id ?? channels[0]?.id ?? '';
  const [name,setName] = useState(edit?.name ?? 'IT Help Request'), [normal,setNormal] = useState(edit?.settings?.normal_channel ?? initial('normal')), [urgent,setUrgent] = useState(edit?.settings?.urgent_channel ?? initial('urgent'));
  const [urgency,setUrgency] = useState('normal'), [description,setDescription] = useState('');
  const [busy,setBusy] = useState(false), [error,setError] = useState('');
  const submission = useRef({fingerprint:'',id:''}), sending = useRef(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (sending.current) return;
    sending.current = true; setBusy(true); setError('');
    const base = '/workspaces/' + workspace + '/workflows/published';
    const fingerprint = JSON.stringify(setup ? [name,normal,urgent] : [urgency,description]);
    if (submission.current.fingerprint !== fingerprint) submission.current = {fingerprint,id:crypto.randomUUID()};
    try {
      if (form.kind === 'edit') {
        await request(base + '/' + form.workflow.id,{revision:form.workflow.settings?.revision,name,normal_channel:normal,urgent_channel:urgent},undefined,'PATCH');
        onPublished();
      } else if (form.kind === 'setup') {
        await request(base, {id:submission.current.id,name,normal_channel:normal,urgent_channel:urgent});
        onPublished();
      } else {
        const result = await request<{channel_id:string}>(base + '/' + form.workflow.id + '/requests',
          {request_id:submission.current.id,urgency,description});
        onStarted(result);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message.replaceAll('_',' ') : 'Unable to submit workflow');
    } finally { sending.current = false; setBusy(false); }
  }
  const available = (id:string) => channels.some(channel => channel.id === id);
  const options = channels.map(channel => <option key={channel.id} value={channel.id}>#{channel.name}</option>);
  return <Dialog open title={form.kind === 'setup' ? 'Set up IT Help Request' : form.kind === 'edit' ? 'Edit workflow' : form.workflow.name} onClose={onClose} onBeforeClose={() => !sending.current}>
    <form className="wf-form" onSubmit={submit}><fieldset disabled={busy}>
      {setup ? <>
        <label>Workflow name<input required maxLength={80} value={name} onChange={e=>setName(e.target.value)}/></label>
        <label>Normal requests<select required value={available(normal) ? normal : ''} onChange={e=>setNormal(e.target.value)}>{!available(normal) && <option value="">Choose a channel</option>}{options}</select></label>
        <label>Urgent requests<select required value={available(urgent) ? urgent : ''} onChange={e=>setUrgent(e.target.value)}>{!available(urgent) && <option value="">Choose a channel</option>}{options}</select></label>
        <p>When someone claims a request, the requester receives a confirmation DM.</p>
      </> : <>
        <label>Urgency<select value={urgency} onChange={e=>setUrgency(e.target.value)}><option value="normal">Normal</option><option value="urgent">Urgent</option></select></label>
        <label>What do you need help with?<textarea required maxLength={4000} rows={4} value={description} onChange={e=>setDescription(e.target.value)}/></label>
      </>}
      {error && <p role="alert">{error}</p>}
      <footer><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" loading={busy} disabled={setup ? !name.trim() || !available(normal) || !available(urgent) : !description.trim()}>{edit ? 'Publish changes' : setup ? 'Publish workflow' : 'Submit request'}</Button></footer>
    </fieldset></form>
  </Dialog>;
}
