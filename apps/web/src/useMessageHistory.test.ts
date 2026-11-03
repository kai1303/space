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
