import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MessageSearch, type MessageSearchResult } from './MessageSearch.js';

const item = (id: string): MessageSearchResult => ({ id, channel_id: 'channel', channel_name: 'general', channel_kind: 'channel', thread_id: 'thread', text: `Result ${id}`, created_at: '2026-11-04T00:00:00Z', author: { id: 'user', name: 'Kai' }, is_reply: false });
const response = (items: MessageSearchResult[], next_cursor: string | null = null) => ({ ok: true, status: 200, json: async () => ({ items, next_cursor }) });
const props = { workspace: 'workspace', open: true, onClose: vi.fn(), onSelect: vi.fn() };
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')); };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
function submit(){ fireEvent.submit(screen.getByRole('searchbox').closest('form')!); }

it('searches remote history with fixed channel scope and selects complete result metadata', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response([item('old')])));
  render(<MessageSearch {...props} channel={{ id: 'channel', name: 'general' }} />);
  expect(fetch).not.toHaveBeenCalled();
  const field = screen.getByRole('searchbox', { name: 'Search messages' });
  expect(document.getElementById(field.getAttribute('aria-describedby')!)?.textContent).toBe('in:general');
  expect(field.getAttribute('maxlength')).toBe('500');
  fireEvent.change(field, { target: { value: '"old phrase" from:me' } });
  submit();
  await screen.findByText('Result old');
  const url = new URL(vi.mocked(fetch).mock.calls[0]![0] as string, 'http://localhost');
  expect(url.pathname).toBe('/v1/workspaces/workspace/search');
  expect(url.searchParams.get('q')).toBe('"old phrase" from:me');
  expect(url.searchParams.get('channel_id')).toBe('channel');
  await userEvent.click(screen.getByRole('button', { name: /Result old/ }));
  expect(props.onSelect).toHaveBeenCalledWith(item('old'));
  expect(props.onClose).not.toHaveBeenCalled();
  expect(screen.getByRole('complementary', {name:'Search results in general'})).toBeTruthy();
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('aborts pending queries and ignores late results when query, scope or visibility changes', async () => {
  let finish!: (result: unknown) => void;
  vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('q=old') ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(response([item('new')]))));
  const view = render(<MessageSearch {...props} />);
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'old' } });
  submit();
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('status').textContent).toContain('Searching');
  const signal = vi.mocked(fetch).mock.calls[0]![1]!.signal!;
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'new' } });
  submit();
  expect(signal.aborted).toBe(true);
  await screen.findByRole('button',{name:/Result new/});
  await act(async () => { finish(response([item('stale')])); });
  expect(screen.queryByText('Result stale')).toBeNull();
  view.rerender(<MessageSearch {...props} workspace="other" />);
  expect(screen.queryByRole('button',{name:/Result new/})).toBeNull();
  expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('');
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'old' } });
  submit();
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  const lastSignal = vi.mocked(fetch).mock.calls.at(-1)![1]!.signal!;
  view.rerender(<MessageSearch {...props} open={false} />);
  expect(lastSignal.aborted).toBe(true);
});

it('shows unavailable and invalid-query errors, retries, and distinguishes empty results', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ error: 'search_unavailable' }) }).mockResolvedValueOnce(response([])).mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: 'invalid_search' }) });
  vi.stubGlobal('fetch', fetcher);
  render(<MessageSearch {...props} />);
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'hello' } });
  submit();
  expect((await screen.findByRole('alert')).textContent).toContain('temporarily unavailable');
  await userEvent.click(screen.getByRole('button', { name: 'Retry search' }));
  await screen.findByText('No messages found');
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'before:bad' } });
  submit();
  expect((await screen.findByRole('alert')).textContent).toContain('Check your search');
});

it('appends cursor pages without duplicates and resets pagination for a new query', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('cursor=') ? response([item('a'), item('b')]) : response([item('a')], 'next')));
  render(<MessageSearch {...props} />);
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'hello' } });
  submit();
  await screen.findByText('Result a');
  await userEvent.click(screen.getByRole('button', { name: 'Load more results' }));
  await screen.findByText('Result b');
  expect(screen.getAllByText('Result a')).toHaveLength(1);
  expect(vi.mocked(fetch).mock.calls[1]![0]).toContain('cursor=next');
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'different' } });
  submit();
  expect(screen.queryByText('Result b')).toBeNull();
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  expect(vi.mocked(fetch).mock.calls[2]![0]).not.toContain('cursor=');
});

it('bounds displayed results and stops requesting pages at the limit', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response(Array.from({ length: 500 }, (_, index) => item(String(index))), 'next')));
  render(<MessageSearch {...props} />);
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'common' } });
  submit();
  await screen.findByText('Showing the first 500 results. Refine your search to find more.');
  expect(screen.queryByRole('button', { name: 'Load more results' })).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('closes on the first Escape from a nonempty search field', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response([])));
  render(<MessageSearch {...props} />);
  const field=screen.getByRole('searchbox');
  fireEvent.change(field,{target:{value:'private'}});
  submit();
  await screen.findByText('No messages found');
  fireEvent.keyDown(screen.getByRole('searchbox'),{key:'Escape'});
  expect(props.onClose).toHaveBeenCalledTimes(1);
});


it('waits for submission and presents a wide results surface with safe highlighted text', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response([{...item('one'),text:'Hello <script>example</script> world'}])));
  render(<MessageSearch {...props} />);
  fireEvent.change(screen.getByRole('searchbox'),{target:{value:'hello'}});
  expect(fetch).not.toHaveBeenCalled();
  expect(screen.getByRole('button',{name:'Show results for: hello'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Show results for: hello'}));
  const result=await screen.findByRole('button',{name:/Hello <script>example/});
  expect(result.querySelector('mark')?.textContent).toBe('Hello');
  expect(result.querySelector('script')).toBeNull();
  expect(screen.getByText('Results for:')).toBeTruthy();
  expect(screen.getByText('Newest first')).toBeTruthy();
  expect(screen.getByText('1 message shown')).toBeTruthy();
});

it('combines and removes filters without changing quoted literal text or channel scope', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response([item('one')],'next')));
  render(<MessageSearch {...props} channel={{id:'channel',name:'general'}} />);
  fireEvent.change(screen.getByRole('searchbox'),{target:{value:'"has:link" release'}});submit();
  await screen.findByText('Result one');
  await userEvent.click(screen.getByRole('button',{name:'Has a link',exact:true}));
  await waitFor(()=>expect(fetch).toHaveBeenCalledTimes(2));
  let url=new URL(String(vi.mocked(fetch).mock.calls.at(-1)![0]),'http://localhost');
  expect(url.searchParams.get('q')).toBe('"has:link" release has:link');
  expect(url.searchParams.get('channel_id')).toBe('channel');
  await userEvent.click(screen.getByRole('button',{name:'Threads only',exact:true}));
  await waitFor(()=>expect(fetch).toHaveBeenCalledTimes(3));
  await userEvent.click(screen.getByRole('button',{name:'Has a link',exact:true}));
  await waitFor(()=>expect(fetch).toHaveBeenCalledTimes(4));
  url=new URL(String(vi.mocked(fetch).mock.calls.at(-1)![0]),'http://localhost');
  expect(url.searchParams.get('q')).toBe('"has:link" release is:thread');
  expect(url.searchParams.has('cursor')).toBe(false);
});

it('applies author and UTC date filters while preserving search text', async () => {
  vi.stubGlobal('fetch',vi.fn(async()=>response([item('one')])));
  render(<MessageSearch {...props}/>);
  fireEvent.change(screen.getByRole('searchbox'),{target:{value:'release from:old'}});submit();
  await screen.findByText('Result one');
  await userEvent.click(screen.getByText('From: old',{exact:true}));
  fireEvent.change(screen.getByLabelText('Search author'),{target:{value:'Jamie Chen'}});
  await userEvent.click(screen.getByRole('button',{name:'Apply author',exact:true}));
  await waitFor(()=>expect(fetch).toHaveBeenCalledTimes(2));
  expect(new URL(String(vi.mocked(fetch).mock.calls.at(-1)![0]),'http://localhost').searchParams.get('q')).toBe('release from:"Jamie Chen"');
  await userEvent.click(screen.getByText('Date',{exact:true}));
  fireEvent.change(screen.getByLabelText('On or after'),{target:{value:'2026-11-01'}});
  fireEvent.change(screen.getByLabelText('Before'),{target:{value:'2026-11-05'}});
  await userEvent.click(screen.getByRole('button',{name:'Apply dates',exact:true}));
  await waitFor(()=>expect(fetch).toHaveBeenCalledTimes(3));
  expect(new URL(String(vi.mocked(fetch).mock.calls.at(-1)![0]),'http://localhost').searchParams.get('q')).toBe('release from:"Jamie Chen" after:2026-11-01 before:2026-11-05');
});
