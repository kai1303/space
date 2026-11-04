import { beforeAll, afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkspaceCollections } from './WorkspaceCollections.js';

const updates = vi.hoisted(() => ({ read: undefined as undefined | (() => Promise<void>), revoke: undefined as undefined | ((code: string) => void) }));
vi.mock('./live-updates.js', () => ({ subscribeUpdates: (_scope: string, _id: string, read: () => Promise<void>, revoke: (code: string) => void) => { updates.read = read; updates.revoke = revoke; void read(); return () => {}; } }));
vi.mock('./AssetAttachments.js', () => ({ AssetViewer: ({ selectedId, onSelect, onAccessLost }: { selectedId: string; onSelect: (id: string) => void; onAccessLost: (status: number) => void }) => <div>Preview {selectedId}<button onClick={() => onSelect('image')}>Next file</button><button onClick={() => onAccessLost(403)}>Simulate lost file access</button></div> }));
beforeAll(() => { HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); }; HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); }; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const message = { id: 'message', channel_id: 'channel', channel_name: 'general', thread_id: 'thread', text: 'Please review this', author_name: 'Alex', created_at: '2026-11-04T00:00:00Z', reply_count: 3 };
const todo = { id: 'todo', title: 'Review proposal', completed: false, created_at: message.created_at, updated_at: message.created_at };
const file = { id: 'file', channel_id: 'channel', channel_name: 'general', message_id: 'message', filename: 'proposal.pdf', content_type: 'application/pdf', byte_size: 1234, preview_kind: 'pdf', created_at: message.created_at };
function fake(handler: (path: string, init?: RequestInit) => unknown) { vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => ({ ok: true, status: 200, json: async () => handler(path, init) }))); }

it('opens a thread in its source conversation and paginates a bounded collection', async () => {
  fake(path => path.includes('after=older') ? { items: [{ ...message, id: 'old', text: 'Older thread' }], next_cursor: null } : { items: [message], next_cursor: 'older' });
  const open = vi.fn(); render(<WorkspaceCollections view="threads" workspace="workspace" onOpen={open} />);
  await screen.findByText(message.text); await userEvent.click(screen.getByRole('button', { name: 'Open thread in general' }));
  expect(open).toHaveBeenCalledWith({ channel_id: 'channel', thread_id: 'thread' });
  await userEvent.click(screen.getByRole('button', { name: 'Load more' })); await screen.findByText('Older thread');
  expect(screen.getByText(message.text)).toBeTruthy();
  expect(vi.mocked(fetch).mock.calls.some(([path]) => String(path).includes('limit=24') && String(path).includes('after=older'))).toBe(true);
});
it('removes saved messages only after the server accepts the change', async () => {
  let saved = true; fake((_path, init) => { if (init?.method === 'POST') { saved = false; return { active: false }; } return { items: saved ? [message] : [], next_cursor: null }; });
  render(<WorkspaceCollections view="saved" workspace="workspace" onOpen={() => {}} />);
  await userEvent.click(await screen.findByRole('button', { name: 'Remove saved message from Alex' }));
  await screen.findByText('Save something for later');
  expect(vi.mocked(fetch).mock.calls.some(([path, init]) => String(path).endsWith('/saved/message') && init?.body === '{"channel_id":"channel","active":false}')).toBe(true);
});
it('exposes read failures and retries instead of presenting an empty collection', async () => {
  let fail = true; vi.stubGlobal('fetch', vi.fn(async () => ({ ok: !fail, status: fail ? 503 : 200, json: async () => fail ? { error: 'temporarily_unavailable' } : { items: [], next_cursor: null } })));
  render(<WorkspaceCollections view="sent" workspace="workspace" onOpen={() => {}} />);
  await screen.findByRole('alert'); expect(screen.queryByText('No sent messages yet')).toBeNull();
  fail = false; await userEvent.click(screen.getByRole('button', { name: 'Retry' })); await screen.findByText('No sent messages yet');
});
it('filters files on the server, previews them and opens their source messages', async () => {
  fake((path, init) => init?.method === 'POST' ? {} : ({ items: new URL(path, 'http://localhost').searchParams.get('kinds') === 'pdf' ? [file] : [file, { ...file, id: 'image', filename: 'photo.png', preview_kind: 'image' }], next_cursor: null }));
  const open = vi.fn(); render(<WorkspaceCollections view="files" workspace="workspace" onOpen={open} />);
  await screen.findByText('proposal.pdf'); await userEvent.click(screen.getByRole('button', { name: 'File types: 6 Types' })); for (const name of ['Images', 'Text & snippets', 'Audio', 'Videos', 'Other files']) await userEvent.click(screen.getByRole('menuitemcheckbox', { name, exact: true })); await userEvent.keyboard('{Escape}'); await waitFor(() => expect(screen.queryByText('photo.png')).toBeNull());
  await userEvent.click(screen.getByRole('button', { name: 'Preview proposal.pdf' })); expect(screen.getByText('Preview file')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'More actions for proposal.pdf' })); await userEvent.click(screen.getByRole('menuitem', { name: 'View message' })); expect(open).toHaveBeenCalledWith({ channel_id: 'channel', message_id: 'message' });
  expect(screen.queryByRole('button', { name: 'Canvases' })).toBeNull();
});


it('ignores an old workspace response and clears private data on revocation', async () => {
  let release: (value: unknown) => void = () => {};
  fake(path => path.includes('/old/') ? new Promise(resolve => { release = resolve; }) : { items: [{ ...message, text: 'New workspace message' }], next_cursor: null });
  const { rerender } = render(<WorkspaceCollections view="sent" workspace="old" onOpen={() => {}} />);
  rerender(<WorkspaceCollections view="sent" workspace="new" onOpen={() => {}} />); await screen.findByText('New workspace message');
  await act(async () => { release({ items: [message], next_cursor: null }); }); expect(screen.queryByText(message.text)).toBeNull();
  act(() => updates.revoke!('not_found')); expect(screen.queryByText('New workspace message')).toBeNull(); expect(screen.getByRole('alert')).toBeTruthy();
});
it('refreshes from workspace events without a timer', async () => {
  let text = 'First message'; fake(() => ({ items: [{ ...message, text }], next_cursor: null }));
  render(<WorkspaceCollections view="sent" workspace="workspace" onOpen={() => {}} />); await screen.findByText(text); text = 'Updated message';
  await act(async () => { await updates.read!(); }); await screen.findByText(text); expect(screen.queryByText('First message')).toBeNull();
});

it('keeps a saved message and reports a failed removal', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_path: string, init?: RequestInit) => ({ ok: init?.method !== 'POST', status: init?.method === 'POST' ? 503 : 200, json: async () => init?.method === 'POST' ? { error: 'save_unavailable' } : { items: [message], next_cursor: null } })));
  render(<WorkspaceCollections view="saved" workspace="workspace" onOpen={() => {}} />);
  await userEvent.click(await screen.findByRole('button', { name: 'Remove saved message from Alex' }));
  await screen.findByRole('alert'); expect(screen.getByText(message.text)).toBeTruthy(); expect(screen.queryByText('Save something for later')).toBeNull();
});
it('does not restore a saved message from a read that began before its removal', async () => {
  let saved = true, slow = false, release: (value: unknown) => void = () => {};
  fake((_path, init) => { if (init?.method === 'POST') { saved = false; slow = false; return { active: false }; } return slow ? new Promise(resolve => { release = resolve; }) : { items: saved ? [message] : [], next_cursor: null }; });
  render(<WorkspaceCollections view="saved" workspace="workspace" onOpen={() => {}} />); await screen.findByText(message.text); slow = true; let pending: Promise<void>;
  await act(async () => { pending = updates.read!(); await Promise.resolve(); });
  await userEvent.click(screen.getByRole('button', { name: 'Remove saved message from Alex' })); await screen.findByText('Save something for later');
  await act(async () => { release({ items: [message], next_cursor: null }); await pending!; }); expect(screen.queryByText(message.text)).toBeNull();
});
it('does not restore private items when a read finishes after revocation', async () => {
  let slow = false, release: (value: unknown) => void = () => {};
  fake(() => slow ? new Promise(resolve => { release = resolve; }) : { items: [message], next_cursor: null });
  render(<WorkspaceCollections view="threads" workspace="workspace" onOpen={() => {}} />); await screen.findByText(message.text); slow = true; let pending: Promise<void>;
  await act(async () => { pending = updates.read!(); await Promise.resolve(); }); act(() => updates.revoke!('forbidden'));
  await act(async () => { release({ items: [message], next_cursor: null }); await pending!; }); expect(screen.queryByText(message.text)).toBeNull(); expect(screen.getByRole('alert')).toBeTruthy();
});


it('keeps sent and saved source navigation focused on the message', async () => {
  fake(() => ({ items: [message], next_cursor: null }));
  const open = vi.fn(); const { rerender } = render(<WorkspaceCollections view="sent" workspace="workspace" onOpen={open} />);
  await userEvent.click(await screen.findByRole('button', { name: 'View message in general' }));
  expect(open).toHaveBeenLastCalledWith({ channel_id: 'channel', message_id: 'message' });
  rerender(<WorkspaceCollections view="saved" workspace="workspace" onOpen={open} />);
  await userEvent.click(await screen.findByRole('button', { name: 'View message in general' }));
  expect(open).toHaveBeenLastCalledWith({ channel_id: 'channel', message_id: 'message' });
});
it('discards a pending older page when a workspace event replaces the collection', async () => {
  let fresh = false, release: (value: unknown) => void = () => {};
  fake(path => path.includes('after=older') ? new Promise(resolve => { release = resolve; }) : { items: fresh ? [{ ...message, text: 'Current authorized message' }] : [message], next_cursor: 'older' });
  render(<WorkspaceCollections view="sent" workspace="workspace" onOpen={() => {}} />);
  await userEvent.click(await screen.findByRole('button', { name: 'Load more' })); fresh = true;
  await act(async () => { await updates.read!(); }); await screen.findByText('Current authorized message');
  await act(async () => { release({ items: [{ ...message, id: 'old', text: 'Stale older page' }], next_cursor: null }); });
  expect(screen.queryByText('Stale older page')).toBeNull(); expect(screen.queryByText(message.text)).toBeNull();
});
it('clears all loaded pages when authorization fails on pagination', async () => {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => ({ ok: !path.includes('after='), status: path.includes('after=') ? 403 : 200, json: async () => path.includes('after=') ? { error: 'forbidden' } : { items: [message], next_cursor: 'older' } })));
  render(<WorkspaceCollections view="sent" workspace="workspace" onOpen={() => {}} />);
  await userEvent.click(await screen.findByRole('button', { name: 'Load more' })); await screen.findByRole('alert');
  expect(screen.queryByText(message.text)).toBeNull();
});


it('clears loaded private files immediately when the viewer reports lost access', async () => {
  let pending = false, release: (value: unknown) => void = () => {};
  fake(() => pending ? new Promise(resolve => { release = resolve; }) : { items: [file], next_cursor: 'older' });
  render(<WorkspaceCollections view="files" workspace="workspace" onOpen={() => {}} />);
  await userEvent.click(await screen.findByRole('button', { name: 'Preview proposal.pdf' })); pending = true;
  await userEvent.click(screen.getByRole('button', { name: 'Simulate lost file access' }));
  expect(screen.queryByText('proposal.pdf')).toBeNull(); expect(screen.queryByText('Preview file')).toBeNull();
  const paths = vi.mocked(fetch).mock.calls.map(([path]) => String(path)); expect(paths.at(-1)).not.toContain('after=');
  await act(async () => { release({ items: [], next_cursor: null }); }); await screen.findByText('No files shared yet');
});



it('searches the complete file library on the server and resets pagination when filters change', async () => {
  fake(path => ({ items: path.includes('q=needle') ? [{ ...file, id: 'needle', filename: 'needle.pdf' }] : [file], next_cursor: 'older' }));
  render(<WorkspaceCollections view="files" workspace="workspace" onOpen={() => {}} />);
  await screen.findByText('proposal.pdf'); await userEvent.type(screen.getByRole('searchbox', { name: 'Search files' }), 'needle');
  await screen.findByText('needle.pdf'); expect(screen.queryByText('proposal.pdf')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
  expect(vi.mocked(fetch).mock.calls.some(([p]) => String(p).includes('q=needle') && String(p).includes('after=older'))).toBe(true);
  await userEvent.click(screen.getByRole('radio', { name: 'Created by you' }));
  await waitFor(() => expect(String(vi.mocked(fetch).mock.calls.at(-1)?.[0])).toContain('ownership=created'));
  expect(String(vi.mocked(fetch).mock.calls.at(-1)?.[0])).not.toContain('after=');
});
it('persists file stars and offers a real starred collection', async () => {
  let starred = false;
  fake((path, init) => { if (path.endsWith('/star')) { starred = JSON.parse(String(init?.body)).active; return { starred }; } return { items: [{ ...file, starred }], next_cursor: null }; });
  render(<WorkspaceCollections view="files" workspace="workspace" onOpen={() => {}} />);
  await userEvent.click(await screen.findByRole('button', { name: 'Star proposal.pdf' }));
  await screen.findByRole('button', { name: 'Unstar proposal.pdf' });
  await userEvent.click(screen.getByRole('button', { name: 'Starred' }));
  await waitFor(() => expect(String(vi.mocked(fetch).mock.calls.at(-1)?.[0])).toContain('starred=true'));
  expect(screen.queryByText('File starring is not available yet')).toBeNull();
});

it('applies sender, conversation and inclusive date filters only after Done', async () => {
  fake(path => path.includes('/participants?') ? { items: [{ id: 'person', name: 'Alex', kind: 'human' }], next_cursor: null } : path.includes('/channels?') ? { items: [{ id: 'channel', name: 'general' }], next_cursor: null } : { items: [file], next_cursor: null });
  render(<WorkspaceCollections view="files" workspace="workspace" onOpen={() => {}} />);
  await screen.findByText('proposal.pdf'); await userEvent.click(screen.getByRole('button', { name: 'Filters' }));
  await screen.findByRole('option', { name: 'Alex' }); await userEvent.selectOptions(screen.getByRole('combobox', { name: 'From' }), 'person'); await userEvent.selectOptions(screen.getByRole('combobox', { name: 'In' }), 'channel');
  const { fireEvent } = await import('@testing-library/react');
  fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2026-11-04' } }); fireEvent.change(screen.getByLabelText('Through date'), { target: { value: '2026-11-04' } });
  expect(vi.mocked(fetch).mock.calls.some(([p]) => String(p).includes('from=person'))).toBe(false);
  await userEvent.click(screen.getByRole('button', { name: 'Done' }));
  await waitFor(() => expect(String(vi.mocked(fetch).mock.calls.at(-1)?.[0])).toContain('from=person'));
  const params = new URL(String(vi.mocked(fetch).mock.calls.at(-1)?.[0]), 'http://test').searchParams;
  expect(params.get('channel')).toBe('channel'); expect(Date.parse(params.get('before')!) - Date.parse(params.get('since')!)).toBe(86400000);
});
it('ignores delayed file results after search changes and reports star write failures', async () => {
  let release: (value: unknown) => void = () => {};
  vi.stubGlobal('fetch',vi.fn(async (path:string,init?:RequestInit) => ({ ok:init?.method !== 'POST', status:init?.method === 'POST' ? 503 : 200, json:async () => init?.method === 'POST' ? {error:'star_unavailable'} : path.includes('q=latest') ? {items:[{...file,filename:'latest.pdf'}],next_cursor:null} : new Promise(resolve=>{release=resolve;}) })));
  render(<WorkspaceCollections view="files" workspace="workspace" onOpen={() => {}} />);
  await userEvent.type(screen.getByRole('searchbox',{name:'Search files'}),'latest'); await screen.findByText('latest.pdf');
  await act(async()=>{release({items:[file],next_cursor:null});}); expect(screen.queryByText('proposal.pdf')).toBeNull();
  await userEvent.click(screen.getByRole('button',{name:'Star latest.pdf'})); await screen.findByRole('alert'); expect(screen.getByRole('button',{name:'Star latest.pdf'})).toBeTruthy(); expect(screen.queryByRole('button',{name:'Unstar latest.pdf'})).toBeNull();
});

it('closes file filters and clears directory data when workspace access is revoked', async () => {
  fake(path => path.includes('/participants?') ? { items: [{ id: 'person', name: 'Private colleague', kind: 'human' }], next_cursor: null } : path.includes('/channels?') ? { items: [{ id: 'private', name: 'private-channel' }], next_cursor: null } : { items: [file], next_cursor: null });
  render(<WorkspaceCollections view="files" workspace="workspace" onOpen={() => {}} />);
  await screen.findByText('proposal.pdf'); await userEvent.click(screen.getByRole('button',{name:'Filters'})); await screen.findByRole('option',{name:'Private colleague'});
  act(()=>updates.revoke!('not_found'));
  expect(screen.queryByRole('dialog',{name:'Filter by'})).toBeNull(); expect(screen.queryByText('Private colleague')).toBeNull(); expect(screen.queryByText('proposal.pdf')).toBeNull();
});

it('records the next preview after an earlier view write finishes', async () => {
  let release: (value: unknown) => void = () => {};
  const viewed: string[] = [];
  fake((path, init) => {
    if (init?.method === 'POST') {
      viewed.push(path);
      return path.endsWith('/files/file/view') ? new Promise(resolve => { release = resolve; }) : {};
    }
    return { items: [file, { ...file, id: 'image', filename: 'photo.png', preview_kind: 'image' }], next_cursor: null };
  });
  render(<WorkspaceCollections view="files" workspace="workspace" onOpen={() => {}} />);
  await userEvent.click(await screen.findByRole('button', { name: 'Preview proposal.pdf' }));
  await userEvent.click(screen.getByRole('button', { name: 'Next file' }));
  expect(screen.getByText('Preview image')).toBeTruthy();
  await act(async () => { release({}); });
  await waitFor(() => expect(viewed.some(path => path.endsWith('/files/image/view'))).toBe(true));
});

it('keeps the type menu open while combining types, supports none, and resets without clearing search', async () => {
  fake(path => {
    const kinds = new URL(path, 'http://localhost').searchParams.get('kinds');
    const selected = kinds === null ? ['image','pdf','text','audio','video','other'] : kinds.split(',');
    return { items: [file, { ...file, id: 'image', filename: 'photo.png', preview_kind: 'image' }].filter(item => selected.includes(item.preview_kind)), next_cursor: null };
  });
  render(<WorkspaceCollections view="files" workspace="workspace" onOpen={() => {}} />);
  await screen.findByText('proposal.pdf');
  await userEvent.type(screen.getByRole('searchbox', { name: 'Search files' }), 'pro');
  await userEvent.click(screen.getByRole('button', { name: 'File types: 6 Types' }));
  for (const name of ['Text & snippets','Audio','Videos','Other files']) await userEvent.click(screen.getByRole('menuitemcheckbox', { name, exact: true }));
  expect(screen.getByRole('button', { name: 'File types: 2 Types' }).getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByText('proposal.pdf')).toBeTruthy(); expect(screen.getByText('photo.png')).toBeTruthy();
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([path]) => new URL(String(path),'http://localhost').searchParams.get('kinds') === 'image,pdf')).toBe(true));
  for (const name of ['Images','PDFs']) await userEvent.click(screen.getByRole('menuitemcheckbox', { name, exact: true }));
  await screen.findByText('No files match your filters'); expect(screen.getByRole('button', { name: 'File types: 0 Types' })).toBeTruthy();
  await userEvent.click(screen.getByRole('menuitem', { name: 'Reset Filters' }));
  expect(screen.getByRole('button', { name: 'File types: 6 Types' }).getAttribute('aria-expanded')).toBe('true');
  expect((screen.getByRole('searchbox', { name: 'Search files' }) as HTMLInputElement).value).toBe('pro');
  expect(screen.queryByRole('menuitem', { name: 'Reset Filters' })).toBeNull();
});
