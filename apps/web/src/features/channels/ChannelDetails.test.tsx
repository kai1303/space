import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { toast } from '@space/ui/primitives';
import userEvent from '@testing-library/user-event';
import { ChannelDetails } from './ChannelDetails.js';
import type { ChannelDetails as Details } from '@space/contracts';

vi.mock('../../shared/realtime/socket-session.js', () => ({
  acquireRealtime: () => ({ socket: { connected: false }, on: vi.fn(), connect: vi.fn(), release: vi.fn() }),
}));

const channel: Details = { id: 'channel', workspace_id: 'workspace', name: 'product', private: false, joined: true, topic: 'Milestone', description: '', archived_at: null, created_by: 'owner', created_at: '2026-11-03T00:00:00Z', creator_name: 'Owner', can_manage: true, member_count: 1 };
const members = [{ id: 'owner', name: 'Owner', title: '', image: null, presence: 'active' }];
const props = { channel, viewer: 'owner', open: true, onClose: vi.fn(), onChange: vi.fn(), onLeft: vi.fn() };
function setup(details = channel) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => ({ ok: true, status: 200, json: async () => url.endsWith('/members?limit=100') ? { items: members, next_cursor: null } : url.includes('/participants') ? { items: [{ id: 'other', kind: 'human', name: 'Teammate' }], next_cursor: null } : init?.method === 'PATCH' ? { ...details, ...JSON.parse(init.body as string) } : details })));
}
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')); };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('edits one field without replacing other metadata and restores focus after cancellation', async () => {
  setup(); render(<ChannelDetails {...props} />);
  const edit = await screen.findByRole('button', { name: 'Edit channel topic' });
  await userEvent.click(edit);
  const dialog = screen.getByRole('dialog', { name: 'Edit topic' });
  const input = within(dialog).getByRole('textbox', { name: 'Topic' });
  expect(document.activeElement).toBe(input);
  await userEvent.clear(input); await userEvent.type(input, 'New milestone');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save', exact: true }));
  await waitFor(() => expect(props.onChange).toHaveBeenCalledWith(expect.objectContaining({ topic: 'New milestone', description: '' })));
  expect(vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'PATCH')?.[1]?.body).toBe('{"topic":"New milestone"}');
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit topic' })).toBeNull());
  await userEvent.click(edit);
  await userEvent.click(within(screen.getByRole('dialog', { name: 'Edit topic' })).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit topic' })).toBeNull());
  expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);
});

it('members can inspect details and leave without seeing manager actions', async () => {
  setup({ ...channel, can_manage: false }); render(<ChannelDetails {...props} viewer="other" />);
  await screen.findByText('Milestone');
  expect(screen.queryByRole('button', { name: 'Edit channel topic' })).toBeNull();
  await userEvent.click(screen.getByRole('tab', { name: 'Members 1' }));
  expect(screen.queryByRole('button', { name: 'Add people' })).toBeNull();
  expect(screen.getByText('Owner', { exact: true })).toBeTruthy();
  await userEvent.click(screen.getByRole('tab', { name: 'Settings' }));
  expect(screen.queryByRole('button', { name: 'Archive channel for everyone' })).toBeNull();
});

it('archiving requires confirmation and keeps server failures visible', async () => {
  setup(); render(<ChannelDetails {...props} initialTab="settings" />);
  await userEvent.click(await screen.findByRole('button', { name: 'Archive channel for everyone' }));
  const dialog = screen.getByRole('dialog', { name: 'Archive #product?' });
  expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(0);
  vi.mocked(fetch).mockImplementationOnce(async () => ({ ok: false, status: 409, json: async () => ({ error: 'channel_has_active_tasks' }) }) as Response);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Archive channel', exact: true }));
  expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', 'Resolve pending or running agent tasks before archiving this channel.');
  expect(props.onChange).not.toHaveBeenCalled();
  expect(toast.getState().toasts.some(item => item.title === '#product archived')).toBe(false);
  vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ ...channel, archived_at: '2026-11-11T00:00:00Z' }) } as Response);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Archive channel', exact: true }));
  await waitFor(() => expect(toast.getState().toasts.at(-1)?.title).toBe('#product archived'));
  await waitFor(() => expect(dialog.isConnected).toBe(false));
  await userEvent.click(screen.getByRole('button', { name: /Restore channel/ }));
  const restore = screen.getByRole('dialog', { name: 'Restore #product?' });
  vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => channel } as Response);
  await userEvent.click(within(restore).getByRole('button', { name: 'Restore channel' }));
  await waitFor(() => expect(toast.getState().toasts.at(-1)?.title).toBe('#product restored'));
});

it('adding a workspace person posts their ID and refreshes membership', async () => {
  setup(); render(<ChannelDetails {...props} initialTab="members" />);
  await userEvent.click(await screen.findByRole('button', { name: 'Add people' }));
  const dialog = screen.getByRole('dialog', { name: 'Add people to #product' });
  await userEvent.click(await within(dialog).findByRole('radio', { name: 'Teammate' }));
  await userEvent.click(within(dialog).getByRole('button', { name: 'Add', exact: true }));
  await waitFor(() => expect(props.onChange).toHaveBeenCalled());
  const call = vi.mocked(fetch).mock.calls.find(([url, init]) => url === '/v1/channels/channel/members' && init?.method === 'POST');
  expect(call?.[1]?.body).toBe('{"user_id":"other"}');
});

it('uses separate action capabilities and exposes posting and manager editors', async () => {
  setup();
  const permissions = { revision: '1', posting: 'admins' as const, poster_ids: [], manager_ids: ['owner'], allow_replies: true, allow_broadcast: false, invite: 'members' as const, remove: 'managers' as const, edit_details: 'members' as const, archive: 'managers' as const, capabilities: { post: false, reply: true, broadcast: false, invite: true, remove: false, edit_details: true, archive: false, manage: true } };
  render(<ChannelDetails {...props} viewer="other" permissions={permissions} />);
  await screen.findByRole('button', { name: 'Edit channel topic' });
  expect(screen.getByRole('button', { name: 'Edit channel managers' })).toBeTruthy();
  await userEvent.click(screen.getByRole('tab', { name: 'Members 1' }));
  expect(screen.getByRole('button', { name: 'Add people' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Remove Owner from channel' })).toBeNull();
  await userEvent.click(screen.getByRole('tab', { name: 'Settings' }));
  expect(screen.queryByRole('button', { name: 'Archive channel for everyone' })).toBeNull();
  expect(screen.queryByRole('switch', { name: /cross-channel/i })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Edit posting permissions' }));
  expect(screen.getByRole('dialog', { name: 'Posting permissions' })).toBeTruthy();
});

it('fails closed for individual actions while production permissions are unavailable', async () => {
  setup(); render(<ChannelDetails {...props} permissionsPending />);
  await screen.findByText('Milestone');
  expect(screen.queryByRole('button', { name: 'Edit channel topic' })).toBeNull();
  await userEvent.click(screen.getByRole('tab', { name: 'Members 1' }));
  expect(screen.queryByRole('button', { name: 'Add people' })).toBeNull();
  await userEvent.click(screen.getByRole('tab', { name: 'Settings' }));
  expect(screen.queryByRole('button', { name: 'Archive channel for everyone' })).toBeNull();
});
it('preserves an open permission draft during refresh and disables save on capability loss', async () => {
  setup();
  const permissions = { revision: '1', posting: 'everyone' as const, poster_ids: [], manager_ids: ['owner'], allow_replies: true, allow_broadcast: true, invite: 'managers' as const, remove: 'managers' as const, edit_details: 'managers' as const, archive: 'managers' as const, capabilities: { post: true, reply: true, broadcast: true, invite: true, remove: true, edit_details: true, archive: true, manage: true } };
  const { rerender } = render(<ChannelDetails {...props} initialTab="settings" permissions={permissions} />);
  await userEvent.click(await screen.findByRole('button', { name: 'Edit posting permissions' }));
  await userEvent.click(screen.getByRole('radio', { name: 'Admins only' }));
  rerender(<ChannelDetails {...props} initialTab="settings" permissionsPending />);
  expect(screen.getByRole('dialog', { name: 'Posting permissions' })).toBeTruthy();
  expect(screen.getByRole('radio', { name: 'Admins only' })).toHaveProperty('checked', true);
  expect(screen.getByRole('button', { name: 'Save', exact: true })).toHaveProperty('disabled', true);
  rerender(<ChannelDetails {...props} initialTab="settings" permissions={{ ...permissions, capabilities: { ...permissions.capabilities, manage: false } }} />);
  expect(screen.getByRole('button', { name: 'Save', exact: true })).toHaveProperty('disabled', true);
});
it('updates Managed by and member manager badges from the live snapshot after revocation', async () => {
  setup();
  const permissions = { revision: '1', posting: 'everyone' as const, poster_ids: [], manager_ids: ['owner'], allow_replies: true, allow_broadcast: true, invite: 'managers' as const, remove: 'managers' as const, edit_details: 'managers' as const, archive: 'managers' as const, capabilities: { post: true, reply: true, broadcast: true, invite: true, remove: true, edit_details: true, archive: true, manage: true } };
  const baseFetch = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (url, init) => String(url).includes('/members?') ? { ok: true, status: 200, json: async () => ({ items: [{ ...members[0], is_manager: true }], next_cursor: null }) } as Response : baseFetch(url, init));
  const { rerender } = render(<ChannelDetails {...props} permissions={permissions} />);
  await screen.findByText('Managed by');
  expect(screen.getByText('Managed by').parentElement?.parentElement?.textContent).toContain('Owner');
  await userEvent.click(screen.getByRole('tab', { name: 'Members 1' }));
  expect(screen.getByText('Channel manager')).toBeTruthy();
  rerender(<ChannelDetails {...props} permissions={{ ...permissions, revision: '2', manager_ids: [] }} />);
  expect(screen.queryByText('Channel manager')).toBeNull();
  await userEvent.click(screen.getByRole('tab', { name: 'About' }));
  expect(screen.getByText('Managed by').parentElement?.parentElement?.textContent).not.toContain('Owner');
});

it('creates, copies and revokes a webhook from the selected channel', async () => {
  const user = userEvent.setup();
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const payload = url.endsWith('/webhooks') ? init?.method === 'POST'
      ? {id:'hook', name:'Build Bot', path:'/v1/hooks/incoming/test'} : []
      : url.endsWith('/agents') ? [] : url.endsWith('/navigator') ? {candidates:[]} : url.includes('/members?') ? {items:members, next_cursor:null} : channel;
    return {ok:true, status:init?.method === 'DELETE' ? 204 : 200, json:async () => payload};
  });
  vi.stubGlobal('fetch', fetch);
  render(<ChannelDetails {...props} />);
  await user.click(await screen.findByRole('tab', {name:'Agents & apps'}));
  expect(screen.queryByLabelText('Integration name')).toBeNull();
  await user.click(screen.getByRole('button', {name:'Manage'}));
  await user.type(await screen.findByLabelText('Integration name'), 'Build Bot');
  await user.click(screen.getByRole('button', {name:'Create incoming webhook'}));
  await user.click(await screen.findByRole('button', {name:'Copy URL'}));
  expect(await navigator.clipboard.readText()).toBe(location.origin + '/v1/hooks/incoming/test');
  await user.click(screen.getByRole('button', {name:'Revoke'}));
  await user.click(screen.getByRole('button', {name:'Revoke webhook'}));
  await waitFor(() => expect(screen.queryByLabelText('Webhook URL')).toBeNull());
  expect(toast.getState().toasts.at(-1)).toMatchObject({ type: 'success', title: 'Webhook revoked' });
  expect(fetch).toHaveBeenCalledWith('/v1/channels/channel/webhooks/hook', expect.objectContaining({method:'DELETE'}));
});

it('lets a member add one owned skill, then shows the shared agent once in the channel', async () => {
  const user = userEvent.setup();
  let added = false;
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/connections/research/channels/channel')) {
      expect(JSON.parse(String(init?.body))).toEqual({enabled:true, skill:'review'});
      added = true;
    }
    const payload = url.endsWith('/navigator') ? {candidates: added ? [{installation_id:'research',name:'Research',skill:'review'}] : []}
      : url.endsWith('/agents') ? [{id:'research',name:'Research',skills:['review','edit'],granted_skills:added ? ['review'] : []}]
      : url.includes('/members?') ? {items:members,next_cursor:null} : {...channel,can_manage:false};
    return {ok:true,status:200,json:async () => payload};
  });
  vi.stubGlobal('fetch',mock);
  render(<ChannelDetails {...props} initialTab="integrations" />);
  await user.click(await screen.findByRole('button',{name:'Add Agent or App'}));
  const picker = screen.getByRole('dialog',{name:'Add agents & apps'});
  await user.type(within(picker).getByRole('searchbox'),'review');
  expect(within(picker).queryByRole('button',{name:'Add Research · edit'})).toBeNull();
  await user.click(within(picker).getByRole('button',{name:'Add Research · review'}));
  await waitFor(() => expect(within(picker).queryByRole('button',{name:'Add Research · review'})).toBeNull());
  expect(within(picker).queryByRole('button',{name:'Connect a new agent'})).toBeNull();
  await user.clear(within(picker).getByRole('searchbox'));
  expect(await within(picker).findByText('Research', {exact:true})).toBeTruthy();
  expect(within(picker).getByRole('button',{name:'Add Research · edit'})).toBeTruthy();
  await user.click(within(picker).getByRole('button',{name:'Close dialog'}));
  await waitFor(() => expect(screen.queryByRole('dialog',{name:'Add agents & apps'})).toBeNull());
  expect(await screen.findByRole('button',{name:'Add more'})).toBeTruthy();
  expect(screen.getAllByText('Research')).toHaveLength(1);
  expect(mock.mock.calls.some(([url]) => url.endsWith('/webhooks'))).toBe(false);
});

it('shows inherited and teammate agents once and returns from connection setup to the refreshed picker', async () => {
  const user = userEvent.setup();
  const candidates = [
    {installation_id:'mine',name:'My Codex',skill:'review'},
    {installation_id:'mine',name:'My Codex',skill:'edit'},
    {installation_id:'other',name:'Team agent',skill:'review'},
  ];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const payload = url.endsWith('/navigator') ? {candidates}
      : url.endsWith('/agents') ? [{id:'mine',name:'My Codex',skills:['review','edit'],inherits_owner_access:true}]
      : url.includes('/members?') ? {items:members,next_cursor:null}
      : url.includes('/participants?') ? {items:[],next_cursor:null}
      : url.endsWith('/connectors') ? [] : channel;
    return {ok:true,status:200,json:async () => payload};
  }));
  render(<ChannelDetails {...props} initialTab="integrations"/>);
  await user.click(await screen.findByRole('button',{name:'Add more'}));
  const picker = within(screen.getByRole('dialog',{name:'Add agents & apps'}));
  expect(await picker.findAllByText('My Codex')).toHaveLength(1);
  expect(picker.getByText('Team agent')).toBeTruthy();
  await user.click(await picker.findByRole('button',{name:'Connect a new agent'}));
  const setup = await screen.findByRole('dialog',{name:'Connect an agent'});
  candidates.push({installation_id:'new',name:'New agent',skill:'review'});
  await user.click(within(setup).getByRole('button',{name:'Close dialog'}));
  const refreshed = within(await screen.findByRole('dialog',{name:'Add agents & apps'}));
  expect(await refreshed.findByText('New agent')).toBeTruthy();
});

it('shows known channel fields and searchable members while details are pending', async () => {
  vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('/members?')
    ? Promise.resolve({ ok: true, json: async () => ({ items: members, next_cursor: null }) })
    : new Promise(() => {})));
  render(<ChannelDetails {...props}/>);
  expect(screen.getByText('Milestone')).toBeTruthy();
  expect(screen.getByText('Loading creator…')).toBeTruthy();
  await userEvent.click(screen.getByRole('tab', { name: 'Members 1' }));
  await userEvent.type(screen.getByRole('searchbox'), 'own');
  expect(await screen.findByRole('button', { name: 'View Owner’s profile' })).toBeTruthy();
});

it('accepts a people search while membership loads and excludes existing members when it arrives', async () => {
  let finishMembers!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/members?')) return new Promise<Response>(resolve => { finishMembers = resolve; });
    if (url.includes('/participants?')) return Response.json({ items: [
      { id: 'owner', kind: 'human', name: 'Team owner' }, { id: 'other', kind: 'human', name: 'Team member' },
    ] });
    return Response.json(channel);
  }));
  render(<ChannelDetails {...props} initialTab="members"/>);
  await userEvent.click(await screen.findByRole('button', { name: 'Add people' }));
  const picker = within(screen.getByRole('dialog', { name: 'Add people to #product' }));
  await userEvent.type(picker.getByRole('searchbox'), 'team');
  expect(picker.getByText('Loading workspace people…')).toBeTruthy();
  expect(picker.queryByRole('radio')).toBeNull();
  await act(async () => finishMembers(Response.json({ items: members })));
  expect(picker.getByRole('searchbox')).toHaveProperty('value', 'team');
  expect(picker.getAllByRole('radio')).toHaveLength(1);
  await userEvent.click(picker.getByRole('radio', { name: 'Team member' }));
  expect(picker.getByRole('button', { name: 'Add' })).toHaveProperty('disabled', false);
});

it('shows available agents while the channel agent list is pending', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/navigator')) return new Promise<Response>(() => {});
    if (url.endsWith('/agents')) return Response.json([{ id: 'research', name: 'Research', skills: ['review'], granted_skills: [] }]);
    return Response.json(url.includes('/members?') ? { items: members } : channel);
  }));
  render(<ChannelDetails {...props} initialTab="integrations"/>);
  await userEvent.click(await screen.findByRole('button', { name: 'Add Agent or App' }));
  const picker = within(screen.getByRole('dialog', { name: 'Add agents & apps' }));
  expect(await picker.findByRole('button', { name: 'Add Research' })).toHaveProperty('disabled', false);
  expect(picker.getByText('Loading agents in this channel…')).toBeTruthy();
  expect(picker.queryByText('Loading available agents and apps…')).toBeNull();
});

it('keeps webhook changes when the initial list arrives after creation and revocation', async () => {
  let finishList!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/webhooks') && init?.method === 'GET') return new Promise<Response>(resolve => { finishList = resolve; });
    if (init?.method === 'POST') {
      const { name } = JSON.parse(String(init.body));
      return Response.json({ id: name, name, path: '/v1/hooks/incoming/test' });
    }
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    return Response.json(url.endsWith('/navigator') ? { candidates: [] } : url.includes('/members?') ? { items: members } : channel);
  }));
  render(<ChannelDetails {...props} initialTab="integrations"/>);
  await userEvent.click(await screen.findByRole('button', { name: 'Manage' }));
  for (const name of ['First', 'Second']) {
    await userEvent.type(screen.getByLabelText('Integration name'), name);
    await userEvent.click(screen.getByRole('button', { name: 'Create incoming webhook' }));
    if (name === 'First') {
      await userEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
      await userEvent.click(screen.getByRole('button', { name: 'Revoke webhook' }));
    }
  }
  expect(screen.getByText('Loading webhooks…')).toBeTruthy();
  await act(async () => finishList(Response.json([{ id: 'First', name: 'First' }, { id: 'Older', name: 'Older' }])));
  expect(screen.queryByRole('heading', { name: 'First' })).toBeNull();
  expect(screen.getByRole('heading', { name: 'Second' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Older' })).toBeTruthy();
  expect(screen.queryByText('Loading webhooks…')).toBeNull();
});

it('preserves the next webhook draft and lets another webhook be revoked during creation', async () => {
  let finishCreate!: (result:Response) => void;
  vi.stubGlobal('fetch',vi.fn(async (url:string, init?:RequestInit) => {
    if (url.endsWith('/webhooks') && init?.method === 'POST') return new Promise<Response>(resolve => { finishCreate = resolve; });
    if (url.endsWith('/webhooks')) return Response.json([{id:'older', name:'Older'}]);
    if (init?.method === 'DELETE') return new Response(null,{status:204});
    return Response.json(url.endsWith('/navigator') ? {candidates:[]} : url.includes('/members?') ? {items:members} : channel);
  }));
  render(<ChannelDetails {...props} initialTab="integrations"/>);
  await userEvent.click(await screen.findByRole('button',{name:'Manage'}));
  const name = screen.getByLabelText('Integration name');
  await userEvent.type(name,'First draft');
  await userEvent.click(screen.getByRole('button',{name:'Create incoming webhook'}));
  await userEvent.clear(name);
  await userEvent.type(name,'Next draft');
  await userEvent.click(screen.getByRole('button',{name:'Revoke'}));
  await userEvent.click(screen.getByRole('button',{name:'Revoke webhook'}));
  await waitFor(()=>expect(screen.queryByRole('heading',{name:'Older'})).toBeNull());
  await act(async()=>finishCreate(Response.json({id:'first',name:'First draft',path:'/v1/hooks/incoming/test'})));
  expect(screen.getByRole('heading',{name:'First draft'})).toBeTruthy();
  expect(name).toHaveProperty('value','Next draft');
});

it('shows Messages while managed tabs are pending and allows switching away', async () => {
  vi.stubGlobal('fetch',vi.fn(async (url:string) => {
    if (url.endsWith('/tabs')) return new Promise<Response>(()=>{});
    return Response.json(url.includes('/members?') ? {items:members} : channel);
  }));
  render(<ChannelDetails {...props} initialTab="tabs"/>);
  expect(await screen.findByText('Loading tabs…')).toBeTruthy();
  expect(within(screen.getByRole('list',{name:'Channel tabs'})).getByText('Messages')).toBeTruthy();
  expect(screen.queryByRole('button',{name:/move .* up/i})).toBeNull();
  await userEvent.click(screen.getByRole('tab',{name:'About'}));
  expect(screen.getByText('Milestone')).toBeTruthy();
});

it('keeps other tab visibility controls available while one tab is saving', async () => {
  let finishSave!: () => void;
  let filesVisible = true;
  vi.stubGlobal('fetch',vi.fn(async (url:string, init?:RequestInit) => {
    if (url.endsWith('/tabs/files') && init?.method === 'PUT') {
      await new Promise<void>(resolve=>{finishSave=resolve;});
      filesVisible=false;
      return Response.json({});
    }
    if (url.endsWith('/tabs')) return Response.json({visibility:{files:filesVisible,pins:true}});
    return Response.json(url.includes('/members?') ? {items:members} : channel);
  }));
  render(<ChannelDetails {...props} initialTab="tabs"/>);
  await userEvent.click(await screen.findByRole('button',{name:'Hide Files & links tab'}));
  expect(screen.getByRole('button',{name:'Show Files & links tab'})).toHaveProperty('disabled',true);
  expect(screen.getByRole('button',{name:'Hide Pins tab'})).toHaveProperty('disabled',false);
  await act(async()=>finishSave());
  await waitFor(()=>expect(screen.getByRole('button',{name:'Show Files & links tab'})).toHaveProperty('disabled',false));
});

it('keeps other agent choices available while a grant is saving', async () => {
  let finishGrant!: () => void;
  vi.stubGlobal('fetch',vi.fn(async (url:string, init?:RequestInit) => {
    if (url.includes('/connections/') && init?.method === 'POST') {
      await new Promise<void>(resolve=>{finishGrant=resolve;});
      return Response.json({});
    }
    if (url.endsWith('/agents')) return Response.json([
      {id:'review',name:'Reviewer',skills:['review'],granted_skills:[]},
      {id:'design',name:'Designer',skills:['design'],granted_skills:[]},
    ]);
    return Response.json(url.endsWith('/navigator') ? {candidates:[]} : url.includes('/members?') ? {items:members} : channel);
  }));
  render(<ChannelDetails {...props} initialTab="integrations"/>);
  await userEvent.click(await screen.findByRole('button',{name:'Add Agent or App'}));
  await userEvent.click(await screen.findByRole('button',{name:'Add Reviewer'}));
  expect(screen.getByRole('button',{name:'Add Reviewer'})).toHaveProperty('disabled',true);
  expect(screen.getByRole('button',{name:'Add Designer'})).toHaveProperty('disabled',false);
  await act(async()=>finishGrant());
  await waitFor(()=>expect(screen.queryByRole('button',{name:'Add Reviewer'})).toBeNull());
});

it('keeps topic edits made during a save available for a second save', async () => {
  setup(); render(<ChannelDetails {...props} />);
  await userEvent.click(await screen.findByRole('button', { name: 'Edit channel topic' }));
  const dialog = within(screen.getByRole('dialog', { name: 'Edit topic' }));
  const topic = dialog.getByLabelText('Topic');
  let finish!: (response: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await userEvent.type(topic, ' one');
  await userEvent.click(dialog.getByRole('button', { name: 'Save', exact: true }));
  expect(dialog.getByRole('button', { name: 'Saving topic…' })).toHaveProperty('disabled', true);
  expect(dialog.getByRole('button', { name: 'Close', exact: true })).toHaveProperty('disabled', false);
  await userEvent.type(topic, ' two');
  await act(async () => finish(Response.json({ ...channel, topic: 'Milestone one' })));
  expect(topic).toHaveProperty('value', 'Milestone one two');
  await userEvent.click(dialog.getByRole('button', { name: 'Save', exact: true }));
  await waitFor(() => expect(props.onChange).toHaveBeenLastCalledWith(expect.objectContaining({ topic: 'Milestone one two' })));
});

it('reopens a pending topic without duplicating the save and displays the acknowledged topic', async () => {
  setup(); render(<ChannelDetails {...props} />);
  const edit = await screen.findByRole('button', { name: 'Edit channel topic' });
  await userEvent.click(edit);
  const dialog = within(screen.getByRole('dialog', { name: 'Edit topic' }));
  await userEvent.type(dialog.getByLabelText('Topic'), ' update');
  let finish!: (response: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await userEvent.click(dialog.getByRole('button', { name: 'Save', exact: true }));
  await userEvent.click(dialog.getByRole('button', { name: 'Close', exact: true }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit topic' })).toBeNull());
  await userEvent.click(edit);
  const reopened = within(screen.getByRole('dialog', { name: 'Edit topic' }));
  expect(reopened.getByRole('button', { name: 'Saving topic…' })).toHaveProperty('disabled', true);
  await act(async () => finish(Response.json({ ...channel, topic: 'Milestone update' })));
  expect(reopened.getByLabelText('Topic')).toHaveProperty('value', 'Milestone update');
  expect(reopened.getByRole('button', { name: 'Save', exact: true })).toHaveProperty('disabled', true);
});

it.each([
  ['settings', 'Archive channel for everyone', 'Archive #product?', 'Archive channel', 'Archiving channel…'],
  ['settings', 'Restore channel', 'Restore #product?', 'Restore channel', 'Restoring channel…'],
  ['about', 'Leave channel', 'Leave #product?', 'Leave channel', 'Leaving channel…'],
  ['members', 'Remove Owner from channel', 'Remove Owner?', 'Remove member', 'Removing member…'],
])('can dismiss and reopen %s / %s without submitting twice', async (tab, opener, title, label, progress) => {
  const detail = label === 'Restore channel' ? { ...channel, archived_at: '2026-11-01' } : channel;
  setup(detail);
  render(<ChannelDetails {...props} viewer="viewer" channel={detail} initialTab={tab} />);
  const trigger = await screen.findByRole('button', { name: opener, exact: true });
  await userEvent.click(trigger);
  const dialog = within(screen.getByRole('dialog', { name: title, exact: true }));
  let finish!: (response: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await userEvent.click(dialog.getByRole('button', { name: label, exact: true }));
  expect(dialog.getByRole('button', { name: progress })).toHaveProperty('disabled', true);
  await userEvent.click(dialog.getByRole('button', { name: 'Close', exact: true }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: title })).toBeNull());
  await userEvent.click(trigger);
  const reopened = within(screen.getByRole('dialog', { name: title }));
  const button = reopened.getByRole('button', { name: progress });
  expect(button).toHaveProperty('disabled', true);
  await userEvent.click(button);
  expect(vi.mocked(fetch).mock.calls.filter(([, init]) => ['DELETE', 'PATCH'].includes(init?.method ?? ''))).toHaveLength(1);
  await act(async () => finish(tab === 'settings' ? Response.json({ ...detail, archived_at: label === 'Archive channel' ? '2026-11-02' : null }) : new Response(null, { status: 204 })));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: title })).toBeNull());
  if (label === 'Leave channel') expect(props.onLeft).toHaveBeenCalledOnce();
  else expect(props.onChange).toHaveBeenCalledOnce();
});

it('reports a failure after dismissal and permits retry', async () => {
  setup(); render(<ChannelDetails {...props} />);
  const leave = screen.getByRole('button', { name: 'Leave channel' });
  await userEvent.click(leave);
  const confirm = within(screen.getByRole('dialog', { name: 'Leave #product?' }));
  let fail!: (error: Error) => void;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
  await userEvent.click(confirm.getByRole('button', { name: 'Leave channel' }));
  await userEvent.click(confirm.getByRole('button', { name: 'Close dialog' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Leave #product?' })).toBeNull());
  await act(async () => fail(new Error('offline')));
  expect(toast.getState().toasts.at(-1)?.title).toContain('offline');
  expect(props.onLeft).not.toHaveBeenCalled();
  await userEvent.click(leave);
  expect(within(screen.getByRole('dialog', { name: 'Leave #product?' })).getByRole('button', { name: 'Leave channel' })).toHaveProperty('disabled', false);
});

it('keeps member search available and removes the acknowledged row before the membership refresh finishes', async () => {
  let finishDelete!: (response: Response) => void, finishList!: (response: Response) => void;
  let memberReads = 0;
  const teammate = { ...members[0], id: 'teammate', name: 'Teammate' };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') return new Promise<Response>(resolve => { finishDelete = resolve; });
    if (url.includes('/members?')) {
      if (++memberReads > 1) return new Promise<Response>(resolve => { finishList = resolve; });
      return Response.json({ items: [...members, teammate], next_cursor: null });
    }
    return Response.json(channel);
  }));
  render(<ChannelDetails {...props} initialTab="members" />);
  await userEvent.click(await screen.findByRole('button', { name: 'Remove Teammate from channel' }));
  const dialog = within(screen.getByRole('dialog', { name: 'Remove Teammate?' }));
  await userEvent.click(dialog.getByRole('button', { name: 'Remove member' }));
  await userEvent.click(dialog.getByRole('button', { name: 'Close', exact: true }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Remove Teammate?' })).toBeNull());
  const search = screen.getByRole('searchbox', { name: 'Find channel members' });
  await userEvent.type(search, 'Owner');
  expect(screen.getByRole('button', { name: 'View Owner’s profile' })).toBeTruthy();
  await userEvent.clear(search);
  await act(async () => finishDelete(new Response(null, { status: 204 })));
  expect(screen.queryByRole('button', { name: 'Remove Teammate from channel' })).toBeNull();
  expect(toast.getState().toasts.at(-1)?.title).toBe('Teammate removed from #product');
  await act(async () => finishList(Response.json({ items: members, next_cursor: null })));
});
