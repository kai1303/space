import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@space/contracts';
import type { Socket } from 'socket.io-client';
import 'fake-indexeddb/auto';
import { getMessageOutbox } from './message-outbox.js';

const viewer = 'me', channelId = 'channel', threadId = 'thread';
const document = { ops: [{ insert: 'Hello', attributes: { bold: true } }, { insert: '\n' }] };
const attachment = { id: 'asset', name: 'note.txt', size: 5, type: 'text/plain', description: '  a note  ', file: new File(['Hello'], 'note.txt'), draftId: 'local' };
const socketWith = (emitWithAck: ReturnType<typeof vi.fn>) =>
  ({ connected: true, timeout: () => ({ emitWithAck }) }) as unknown as Socket;
const saved = (clientId: string): ChatMessage => ({
  id: 'server', client_message_id: clientId, channel_id: channelId, thread_id: threadId,
  thread_root_id: 'server', text: 'Hello', task_id: null, created_at: new Date().toISOString(),
  author: { kind: 'human', id: viewer, name: 'Me' },
});

beforeEach(() => sessionStorage.clear());
afterEach(() => vi.unstubAllGlobals());
describe('sender outbox', () => {
  it('recovers an interrupted send on reload and retries its normalized payload under the original ID', async () => {
    const workspace = crypto.randomUUID();
    const box = getMessageOutbox(viewer, workspace);
    const row = await box.enqueue({ channelId, threadId, text: ' Hello ', document, attachments: [attachment] });
    expect(row.status).toBe('sending');
    expect(row.attachments).toEqual([{ id: 'asset', name: 'note.txt', size: 5, type: 'text/plain', description: 'a note' }]);
    expect(getMessageOutbox('another', workspace).getSnapshot()).toEqual([]);
    expect(getMessageOutbox(viewer, 'another-workspace').getSnapshot()).toEqual([]);

    vi.resetModules();
    const recovered = (await import('./message-outbox.js')).getMessageOutbox(viewer, workspace);
    await recovered.refresh();
    expect(recovered.getSnapshot()).toEqual([row]);
    const emit = vi.fn().mockResolvedValue({ data: saved(row.id) });
    const socket = socketWith(emit);
    await Promise.all([recovered.send(row.id, socket), recovered.send(row.id, socket)]);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('message.send', { expected_actor: viewer, client_message_id: row.id, channel_id: channelId, thread_id: threadId,
      document, text: 'Hello', asset_ids: ['asset'], asset_descriptions: { asset: 'a note' } });
    expect(recovered.getSnapshot()).toEqual([]);
  });

  it('recovers queued work from IndexedDB on reconnect, skips permanent errors and stays within the actor scope', async () => {
    const workspace = crypto.randomUUID(), box = getMessageOutbox(viewer, workspace);
    const first = await box.enqueue({channelId, text: 'First'});
    const denied = await box.enqueue({channelId, text: 'Restricted'});
    await box.send(denied.id, socketWith(vi.fn().mockResolvedValue({error: 'channel_posting_forbidden'})));
    const uncertain = await box.enqueue({channelId, text: 'Lost acknowledgment'});
    await box.send(uncertain.id, socketWith(vi.fn().mockRejectedValue(new Error('operation has timed out'))));
    vi.resetModules();
    const {getMessageOutbox: reopen} = await import('./message-outbox.js');
    const emit = vi.fn(async (_name, payload) => ({data: saved(payload.client_message_id)}));
    const socket = socketWith(emit);
    await reopen('someone-else', workspace).resumeSends(socket, () => true);
    expect(emit).not.toHaveBeenCalled();
    const recovered = reopen(viewer, workspace);
    await recovered.resumeSends(socket, () => true);
    expect(emit.mock.calls.map(([,payload]) => payload.client_message_id)).toEqual([first.id, uncertain.id]);
    expect(emit.mock.calls.every(([,payload]) => payload.expected_actor === viewer)).toBe(true);
    expect(recovered.getSnapshot().map(row => row.id)).toEqual([denied.id]);
  });

  it('keeps overlapping tab writes and ignores a stale failure after the other tab confirms', async () => {
    const workspace = crypto.randomUUID(), first = getMessageOutbox(viewer, workspace);
    vi.resetModules();
    const second = (await import('./message-outbox.js')).getMessageOutbox(viewer, workspace);
    const [a,b] = await Promise.all([first.enqueue({channelId, text:'A'}),second.enqueue({channelId,text:'B'})]);
    await second.refresh();
    let reject!: (reason: Error) => void;
    const pending = first.send(a.id, socketWith(vi.fn(() => new Promise((_, fail) => { reject = fail; }))));
    await vi.waitFor(() => expect(reject).toBeTypeOf('function'));
    await second.reconcile([saved(a.id)]);
    reject(new Error('timed out'));
    await pending;
    await first.refresh();
    expect(first.getSnapshot().map(row => row.id)).toEqual([b.id]);
  });

  it('hands a confirmed row to another open tab before it removes its optimistic copy', async () => {
    const workspace = crypto.randomUUID(), first = getMessageOutbox(viewer, workspace);
    vi.resetModules();
    const second = (await import('./message-outbox.js')).getMessageOutbox(viewer, workspace);
    const stopFirst = first.subscribe(() => {}), stopSecond = second.subscribe(() => {});
    const delivered = vi.fn();
    const stopDelivery = second.onDelivered(delivered);
    try {
      const row = await first.enqueue({channelId, text: 'Hello'});
      await vi.waitFor(() => expect(second.getSnapshot()).toHaveLength(1));
      const message = saved(row.id);
      await first.send(row.id, socketWith(vi.fn().mockResolvedValue({data: message})));
      await vi.waitFor(() => expect(second.getSnapshot()).toEqual([]));
      expect(delivered).toHaveBeenCalledWith(message, false);
    } finally { stopDelivery(); stopSecond(); stopFirst(); }
  });

  it('resumes a persisted deletion if the tab closed before the response', async () => {
    const workspace = crypto.randomUUID(), box = getMessageOutbox(viewer, workspace);
    const row = await box.enqueue({channelId, text:'Delete me'});
    await box.send(row.id, undefined);
    let finish!: (value: Response) => void;
    const fetch = vi.fn().mockImplementationOnce(() => new Promise(resolve => {finish=resolve;}))
      .mockResolvedValue(Response.json({message:null}));
    vi.stubGlobal('fetch',fetch);
    const pending = box.discard(row.id);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    vi.resetModules();
    const recovered = (await import('./message-outbox.js')).getMessageOutbox(viewer,workspace);
    await recovered.refresh();
    recovered.resumeDeletes();
    await vi.waitFor(() => expect(recovered.getSnapshot()).toEqual([]));
    finish(Response.json({message:null}));
    await pending;
  });

  it('reconciles only matching human deliveries and ignores stale rejections after removal', async () => {
    const box = getMessageOutbox(viewer, crypto.randomUUID());
    const row = await box.enqueue({ channelId, threadId, text: 'Hello' });
    const other = await box.enqueue({ channelId, threadId, text: 'Hello' });
    expect(other.id).not.toBe(row.id);
    let reject!: (reason: Error) => void;
    const pending = box.send(row.id, socketWith(vi.fn(() => new Promise((_, fail) => { reject = fail; }))));
    await box.discard(row.id);
    const message = saved(row.id);
    await box.reconcile([{ ...message, author: { ...message.author, id: 'another' } }, { ...message, channel_id: 'another' }, { ...message, thread_id: 'another' }]);
    expect(box.getSnapshot()).toHaveLength(2);
    await vi.waitFor(() => expect(reject).toBeTypeOf('function'));
    await box.reconcile([message]);
    reject(new Error('ack timed out'));
    await expect(pending).resolves.toBeUndefined();
    expect(box.getSnapshot()).toEqual([other]);
  });

  it('keeps a root send when an unrelated reply carries the same client ID', async () => {
    const box = getMessageOutbox(viewer, crypto.randomUUID());
    const entry = await box.enqueue({ channelId, text: 'Hello' });
    await box.reconcile([{ ...saved(entry.id), thread_root_id: 'different-root' }]);
    expect(box.getSnapshot()).toEqual([entry]);
    await box.reconcile([saved(entry.id)]);
    expect(box.getSnapshot()).toEqual([]);
  });

  it('recovers valid rows when a neighboring stored row is damaged', async () => {
    const workspace = crypto.randomUUID();
    const box = getMessageOutbox(viewer, workspace);
    const entry = await box.enqueue({ channelId, text: 'Hello' });
    const key = 'space:message-outbox:v1:' + JSON.stringify([viewer, workspace]) + ':';
    const legacy = {...entry, id: 'old-tab'};
    sessionStorage.setItem(key + legacy.id, JSON.stringify(legacy));
    sessionStorage.setItem(key + 'damaged', JSON.stringify({ ...entry, id: 'damaged', createdAt: 9000 }));
    vi.resetModules();
    const recovered = (await import('./message-outbox.js')).getMessageOutbox(viewer, workspace);
    await recovered.refresh();
    expect(sessionStorage.getItem(key + legacy.id)).toBeNull();
    expect(recovered.getSnapshot().map(row => row.id)).toEqual([entry.id, legacy.id]);
  });

  it('makes server-requested broadcast confirmation explicit and preserves approval on further retries', async () => {
    const box = getMessageOutbox(viewer, crypto.randomUUID());
    const row = await box.enqueue({ channelId, text: '@channel Hello' });
    const emit = vi.fn().mockResolvedValueOnce({ error: 'broadcast_confirmation_required' }).mockRejectedValueOnce(new Error('timed out')).mockResolvedValueOnce({data: saved(row.id)});
    const socket = socketWith(emit);
    await box.send(row.id, socket);
    expect(box.getSnapshot()[0]).toMatchObject({ status: 'failed', error: 'broadcast_confirmation_required' });
    await box.send(row.id, socket);
    expect(emit).toHaveBeenCalledTimes(1);
    await box.send(row.id, socket, true);
    await box.send(row.id, socket);
    expect(emit).toHaveBeenCalledTimes(3);
    expect(emit.mock.calls.slice(1).map(call => call[1])).toEqual(Array(2).fill({
      client_message_id: row.id, expected_actor: viewer, channel_id: channelId, text: '@channel Hello', broadcast_confirmed: true,
    }));
  });

  it('allows failed rows to be discarded and prevents replies after a channel purge', async () => {
    const box = getMessageOutbox(viewer, crypto.randomUUID());
    const row = await box.enqueue({ channelId, threadId, text: 'Hello' });
    const other = await box.enqueue({ channelId: 'another', text: 'Another' });
    await box.send(other.id, undefined);
    let acknowledge!: (result: unknown) => void;
    const pending = box.send(row.id, socketWith(vi.fn(() => new Promise(done => { acknowledge = done; }))));
    await vi.waitFor(() => expect(acknowledge).toBeTypeOf('function'));
    await box.purgeChannel(channelId);
    acknowledge({data: saved(row.id)});
    await expect(pending).resolves.toBeUndefined();
    expect(box.getSnapshot().map(entry => entry.id)).toEqual([other.id]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ message: null })));
    await box.discard(other.id);
    expect(box.getSnapshot()).toEqual([]);
  });

  it('persists a cancellation before delivery reconciliation and returns the canonical deletion', async () => {
    const box = getMessageOutbox(viewer, crypto.randomUUID());
    const row = await box.enqueue({ channelId, threadId, text: 'Hello', document, attachments: [attachment] });
    await box.send(row.id, undefined);
    let finish!: (value: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(done => { finish = done; }));
    vi.stubGlobal('fetch', fetch);
    const pending = box.discard(row.id);
    await box.reconcile([saved(row.id)]);
    await box.send(row.id, socketWith(vi.fn()));
    expect(box.getSnapshot()).toEqual([expect.objectContaining({status: 'deleting', id: row.id, text: '', attachments: []})]);
    expect(box.getSnapshot()[0]?.attachments).toEqual([]);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(fetch.mock.calls[0]).toEqual([`/v1/channels/${channelId}/outgoing/${row.id}`, expect.objectContaining({ method: 'DELETE', headers: { 'X-Expected-Actor': viewer } })]);
    const tombstone = { ...saved(row.id), deleted_at: new Date().toISOString(), text: '' };
    finish(Response.json({ message: tombstone }));
    await expect(pending).resolves.toEqual(tombstone);
    expect(box.getSnapshot()).toEqual([]);
  });

  it('recovers cancellation intent, limits automatic attempts and lets the user retry explicitly', async () => {
    const workspace = crypto.randomUUID();
    const box = getMessageOutbox(viewer, workspace);
    const row = await box.enqueue({ channelId, text: 'Hello' });
    await box.send(row.id, undefined);
    const fetch = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetch);
    await box.discard(row.id);
    expect(box.getSnapshot()[0]?.status).toBe('delete_failed');
    vi.resetModules();
    const recovered = (await import('./message-outbox.js')).getMessageOutbox(viewer, workspace);
    const emit = vi.fn();
    await recovered.refresh();
    await recovered.send(row.id, socketWith(emit));
    expect(emit).not.toHaveBeenCalled();
    for (let i = 0; i < 5; i++) {
      recovered.resumeDeletes(channelId);
      await vi.waitFor(() => expect(recovered.getSnapshot()[0]).toMatchObject({status: 'delete_failed', deleteAttempts: Math.min(i + 2, 3)}));
    }
    expect(fetch).toHaveBeenCalledTimes(3);
    fetch.mockResolvedValue(Response.json({ message: null }));
    await recovered.discard(row.id);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(recovered.getSnapshot()).toEqual([]);
  });

  it('skips queued deletions after revocation and ignores a late cancellation result', async () => {
    const box = getMessageOutbox(viewer, crypto.randomUUID());
    const first = await box.enqueue({ channelId, text: 'first' });
    const second = await box.enqueue({ channelId, text: 'second' });
    await Promise.all([box.send(first.id, undefined), box.send(second.id, undefined)]);
    let finish!: (value: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(done => { finish = done; }));
    vi.stubGlobal('fetch', fetch);
    const pending = Promise.all([box.discard(first.id), box.discard(second.id)]);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await box.purgeChannel(channelId);
    finish(Response.json({ message: { ...saved(first.id), deleted_at: new Date().toISOString() } }));
    await expect(pending).resolves.toEqual([undefined, undefined]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(box.getSnapshot()).toEqual([]);
  });

  it('keeps the original failure if cancellation intent cannot be saved', async () => {
    const box = getMessageOutbox(viewer, crypto.randomUUID());
    const row = await box.enqueue({ channelId, text: 'Hello' });
    await box.send(row.id, undefined);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const write = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => { throw new Error('disabled'); });
    try {
      await expect(box.discard(row.id)).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
      expect(box.getSnapshot()[0]).toMatchObject({ status: 'failed', text: 'Hello' });
    } finally { write.mockRestore(); }
  });

  it('purges revoked rows durably while preserving other failed sends', async () => {
    const workspace = crypto.randomUUID();
    const box = getMessageOutbox(viewer, workspace);
    const revoked = await box.enqueue({ channelId, text: 'private message' });
    const other = await box.enqueue({ channelId: 'other', text: 'keep' });
    await box.send(other.id, socketWith(vi.fn().mockRejectedValue(new Error('x'.repeat(240)))));
    await box.purgeChannel(channelId);
    vi.resetModules();
    const restored = (await import('./message-outbox.js')).getMessageOutbox(viewer, workspace);
    await restored.refresh();
    expect(restored.getSnapshot().map(entry => entry.id)).toEqual([other.id]);
    expect(restored.getSnapshot().some(entry => entry.id === revoked.id)).toBe(false);
  });

  it('retains existing messages and reports a failed durable write before accepting another draft', async () => {
    const box = getMessageOutbox(viewer, crypto.randomUUID());
    const first = await box.enqueue({ channelId, text: 'first' });
    const listener = vi.fn();
    const unsubscribe = box.subscribe(listener);
    const write = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => { throw new Error('quota'); });
    try {
      await expect(box.enqueue({ channelId, text: 'next' })).rejects.toThrow();
      expect(box.getSnapshot()).toEqual([first]);
      expect(listener).not.toHaveBeenCalled();
    } finally { write.mockRestore(); unsubscribe(); }
    for (let i = 1; i < 100; i++) await box.enqueue({ channelId, text: String(i) });
    await expect(box.enqueue({ channelId, text: 'overflow' })).rejects.toThrow();
    expect(box.getSnapshot()).toHaveLength(100);
  });
});

it('replays an encrypted send under the same ID without serializing message text or document',async()=>{
  const workspace=crypto.randomUUID(),id=crypto.randomUUID(),sender=crypto.randomUUID();
  const encrypted={version:1 as const,sender,recipients:[sender],ciphertext:'YWJjZA=='};
  const box=getMessageOutbox(viewer,workspace);
  await box.enqueue({channelId,text:'Encrypted message',encrypted},id);
  const timedOut=vi.fn().mockRejectedValue(new Error('operation has timed out'));
  await box.send(id,socketWith(timedOut));
  vi.resetModules();
  const reopened=(await import('./message-outbox.js')).getMessageOutbox(viewer,workspace);
  const delivered=vi.fn().mockResolvedValue({data:{...saved(id),text:'Encrypted message',encrypted}});
  await reopened.resumeSends(socketWith(delivered),()=>true);
  const wire={expected_actor:viewer,channel_id:channelId,client_message_id:id,encrypted};
  expect(timedOut).toHaveBeenCalledWith('message.send',wire);
  expect(delivered).toHaveBeenCalledWith('message.send',wire);
  expect(reopened.getSnapshot()).toEqual([]);
});
