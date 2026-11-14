import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useChannelRead } from './useChannelRead.js';

beforeEach(() => {
  const channel = document.createElement('main'); channel.id = 'chat-messages';
  const timeline = document.createElement('div'); timeline.className = 'chat-timeline'; channel.append(timeline); document.body.append(channel);
});
afterEach(() => { cleanup(); document.getElementById('chat-messages')?.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it('keeps background tabs unread and cancels a pending read when the view stops showing latest messages', async () => {
  vi.useFakeTimers();
  let hidden = true;
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ last_read_sequence: '5' }) }));
  vi.stubGlobal('fetch', fetch);
  const hook = renderHook(({ enabled }) => useChannelRead('channel', '5', '0', enabled), { initialProps: { enabled: true } });
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(fetch).not.toHaveBeenCalled();
  hidden = false;
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
  hook.rerender({ enabled: false });
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(fetch).not.toHaveBeenCalled();
  hook.rerender({ enabled: true });
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(fetch).toHaveBeenCalledTimes(1);
  act(() => { window.dispatchEvent(new Event('focus')); });
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('preserves unread after a failed save and retries on focus with the displayed message sequence', async () => {
  vi.useFakeTimers();
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  const fetch = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue({ ok: true, json: async () => ({ last_read_sequence: '9007199254740993' }) });
  vi.stubGlobal('fetch', fetch);
  const hook = renderHook(() => useChannelRead('channel', '9007199254740993', '0', true));
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(hook.result.current).toContain('Couldn’t update');
  act(() => { window.dispatchEvent(new Event('focus')); });
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({ sequence: '9007199254740993' });
  expect(hook.result.current).toBe('');
});
it('does not read messages behind a modal and resumes after focus returns to the conversation', async () => {
  vi.useFakeTimers();
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ last_read_sequence: '5' }) }));
  vi.stubGlobal('fetch', fetch);
  const modal = document.createElement('dialog'); modal.open = true; document.body.append(modal);
  try {
    renderHook(() => useChannelRead('channel', '5', '0', true));
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(fetch).not.toHaveBeenCalled();
    modal.remove();
    act(() => { document.dispatchEvent(new FocusEvent('focusin')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally { modal.remove(); }
});
it('keeps a channel hidden by responsive panels unread and resumes when it becomes visible', async () => {
  vi.useFakeTimers(); vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ last_read_sequence: '5' }) })); vi.stubGlobal('fetch', fetch);
  const channel = document.getElementById('chat-messages')!;
  channel.style.display = 'none';
  renderHook(() => useChannelRead('channel', '5', '0', true));
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(fetch).not.toHaveBeenCalled();
  channel.style.display = ''; channel.style.visibility = 'hidden';
  act(() => { window.dispatchEvent(new Event('resize')); });
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(fetch).not.toHaveBeenCalled();
  channel.style.visibility = '';
  act(() => { window.dispatchEvent(new Event('resize')); });
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('acknowledges only the displayed thread when the reply panel is visible', async () => {
  vi.useFakeTimers();
  vi.spyOn(document,'hasFocus').mockReturnValue(true);
  const fetch=vi.fn(async (_path:string,_init:RequestInit)=>({ok:true,json:async()=>({sequence:'42'})}));
  vi.stubGlobal('fetch',fetch);
  const panel=document.createElement('aside');
  panel.className='chat-thread'; panel.setAttribute('aria-label','Thread');
  panel.innerHTML='<div class="chat-timeline"></div>';
  panel.hidden=true; document.body.append(panel);
  try {
    renderHook(()=>useChannelRead('room','42','0',true,{workspace:'workspace',id:'thread',actor:'viewer'}));
    await act(async()=>{await vi.advanceTimersByTimeAsync(300);});
    expect(fetch).not.toHaveBeenCalled();
    panel.hidden=false;
    act(()=>window.dispatchEvent(new Event('focus')));
    await act(async()=>{await vi.advanceTimersByTimeAsync(300);});
    expect(fetch.mock.calls[0]?.[0]).toBe('/v1/workspaces/workspace/hub/threads/thread/read');
    expect(fetch.mock.calls[0]?.[1].body).toBe('{"sequence":"42"}');
  } finally {panel.remove();}
});
