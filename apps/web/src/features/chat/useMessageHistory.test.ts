import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, StrictMode, useEffect } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { useMessageHistory } from './useMessageHistory.js';

const page = (sequence: string) => ({ messages: [{ id: sequence, sequence, text: sequence }], older_cursor: sequence, newer_cursor: sequence, event_cursor: sequence, has_older: true, has_newer: false });
afterEach(() => vi.unstubAllGlobals());
it('restarts initial loading during StrictMode effect replay', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => page('50') })));
  const { result } = renderHook(() => {
    const history = useMessageHistory('/channels/one/messages', vi.fn());
    useEffect(() => { void history.load('latest'); }, [history.load]);
    return history;
  }, { wrapper: ({ children }) => createElement(StrictMode, null, children) });
  await waitFor(() => expect(result.current.page?.newer_cursor).toBe('50'));
  expect(result.current.loading).toBeNull();
});
it('coalesces page requests and ignores a response after access is cleared', async () => {
  let finish!: (value: unknown) => void;
  const fetch = vi.fn().mockImplementationOnce(async () => ({ ok: true, json: async () => page('50') }))
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => useMessageHistory('/channels/one/messages', vi.fn()));
  await act(async () => { await result.current.load('latest'); });
  let pending: Promise<unknown>;
  act(() => { pending = result.current.load('older'); void result.current.load('older'); });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[1]?.[0]).toBe('/v1/channels/one/messages?before=50');
  act(() => result.current.clear());
  await act(async () => { finish({ ok: true, json: async () => page('1') }); await pending; });
  expect(result.current.page).toBeNull();
});
it('keeps a live message arriving while the initial thread page is loading', async () => {
  let finish!: (value: unknown) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { finish = resolve; })));
  const { result } = renderHook(() => useMessageHistory('/threads/one/history', vi.fn()));
  let pending: Promise<unknown>;
  act(() => { pending = result.current.load('latest'); });
  act(() => result.current.receive(page('51').messages as any, true));
  await act(async () => { finish({ ok: true, json: async () => page('50') }); await pending; });
  await waitFor(() => expect(result.current.page?.messages.map(m => m.id)).toEqual(['50', '51']));
});
it('keeps a live message arriving while newer history catches up to the present', async () => {
  let finish!: (value: unknown) => void;
  vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(async () => ({ ok: true, json: async () => ({ ...page('50'), has_newer: true }) }))
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })));
  const { result } = renderHook(() => useMessageHistory('/channels/one/messages', vi.fn()));
  await act(async () => { await result.current.load('latest'); });
  let pending: Promise<unknown>;
  act(() => { pending = result.current.load('newer'); });
  act(() => result.current.receive(page('52').messages as any, false));
  await act(async () => { finish({ ok: true, json: async () => page('51') }); await pending; });
  expect(result.current.page?.messages.map(m => m.id)).toEqual(['50', '51', '52']);
});

it('a successful send supersedes an older-page request and ignores its late response', async () => {
  let finishOlder!: (value: unknown) => void;
  const fetch = vi.fn().mockImplementationOnce(async () => ({ok:true,json:async()=>({...page('50'),has_newer:true})}))
    .mockImplementationOnce(() => new Promise(resolve => {finishOlder=resolve;}))
    .mockImplementationOnce(async () => ({ok:true,json:async()=>page('100')}));
  vi.stubGlobal('fetch',fetch);
  const {result,unmount}=renderHook(()=>useMessageHistory('/channels/one/messages',vi.fn()));
  await act(async()=>{await result.current.load('latest');});
  let pending:Promise<unknown>;
  act(()=>{pending=result.current.load('older');});
  act(()=>result.current.sent(page('100').messages[0] as any));
  await waitFor(()=>expect(result.current.page?.messages.map(m=>m.id)).toEqual(['100']));
  await act(async()=>{finishOlder({ok:true,json:async()=>page('1')});await pending;});
  expect(result.current.page?.messages.map(m=>m.id)).toEqual(['100']);
  expect(result.current.loading).toBeNull();
  unmount();
});
it('ignores late send acknowledgments after history is cleared or unmounted',async()=>{
  const fetch=vi.fn(async()=>({ok:true,json:async()=>page('1')}));
  vi.stubGlobal('fetch',fetch);
  const {result,unmount}=renderHook(()=>useMessageHistory('/channels/one/messages',vi.fn()));
  await act(async()=>{await result.current.load('latest');});
  act(()=>result.current.clear());
  act(()=>result.current.sent(page('2').messages[0] as any));
  expect(result.current.page).toBeNull();
  unmount();
  result.current.sent(page('3').messages[0] as any);
  expect(fetch).toHaveBeenCalledOnce();
});

it('replays a deletion received while its thread page is being fetched', async () => {
  let finish!: (value: unknown) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { finish = resolve; })));
  const { result } = renderHook(() => useMessageHistory('/threads/one/history', vi.fn()));
  let pending: Promise<unknown>;
  act(() => { pending = result.current.load('latest'); });
  const deleted = { ...page('1').messages[0], text: '', deleted_at: '2026-11-09T00:00:00Z' };
  act(() => result.current.receive([deleted] as any, false));
  await act(async () => { finish({ ok: true, json: async () => page('1') }); await pending; });
  expect(result.current.page?.messages).toEqual([deleted]);
});

it('refreshes a page snapshot if bounded buffering drops a deletion before the response', async () => {
  let finish!: (value: unknown) => void;
  const deleted = { ...page('1').messages[0], text: '', deleted_at: '2026-11-09T00:00:00Z' };
  const fetch = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockImplementationOnce(async () => ({ ok: true, json: async () => ({ ...page('1'), messages: [deleted], event_cursor: '600' }) }));
  vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => useMessageHistory('/threads/one/history', vi.fn()));
  let pending: Promise<unknown>;
  act(() => { pending = result.current.load('latest'); });
  act(() => result.current.receive([deleted, ...Array.from({ length: 500 }, (_, index) => page(String(index + 2)).messages[0])] as any, false));
  await act(async () => { finish({ ok: true, json: async () => page('1') }); await pending; });
  expect(result.current.page?.messages[0]).toEqual(deleted);
  expect(fetch).toHaveBeenCalledTimes(2);
});
