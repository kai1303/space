import { MAX_MESSAGE_ASSETS, encryptedMessageLabel,parseEncryptedDm,type EncryptedDm, parseRichDocument, type AssetAttachment, type ChatMessage, type RichDocument } from '@space/contracts';
import type { Socket } from 'socket.io-client';
import { request } from '../../shared/api/request.js';
import { transactOutbox } from './outbox-storage.js';
import { messageContent, sendMessage } from './message-sender.js';

type Draft = {
  encrypted?:EncryptedDm;
  channelId: string; threadId?: string; text: string; document?: RichDocument;
  attachments?: AssetAttachment[]; broadcastConfirmed?: boolean; alsoSendToChannel?: boolean;
};
export type OutboxEntry = Draft & {
  id: string; createdAt: string; attachments: AssetAttachment[];
  status: 'sending' | 'failed' | 'deleting' | 'delete_failed'; error?: string; deleteAttempts?: number; revision?: string; retryOnConnect?: boolean;
};
const maxEntries = 100;
const maxStorageLength = 500_000;
const unconfirmed = 'Delivery unconfirmed';
const confirmationRequired = 'broadcast_confirmation_required';

function cancelling(row: OutboxEntry) {
  return row.status === 'deleting' || row.status === 'delete_failed';
}

function copyContent(draft: Draft) {
  if (typeof draft.channelId !== 'string' || !draft.channelId || (draft.threadId !== undefined && typeof draft.threadId !== 'string')
    || typeof draft.text !== 'string' || !Array.isArray(draft.attachments ?? []) || (draft.attachments?.length ?? 0) > MAX_MESSAGE_ASSETS)
    throw new Error('Invalid outgoing message');
  const attachments = (draft.attachments ?? []).map(({ id, name, size, type, description }) => {
    if (!id || typeof id !== 'string' || typeof name !== 'string' || !Number.isSafeInteger(size) || typeof type !== 'string')
      throw new Error('Invalid outgoing attachment');
    const label = description?.trim();
    return { id, name, size, type, ...(label ? { description: label } : {}) };
  });
  if (draft.alsoSendToChannel && (!draft.threadId || draft.encrypted)) throw new Error('Invalid thread broadcast');
  if(draft.encrypted && (draft.threadId || draft.text!==encryptedMessageLabel || draft.document || attachments.length || draft.broadcastConfirmed)) throw new Error('Invalid encrypted message');
  return {
    ...(draft.encrypted ? {encrypted:parseEncryptedDm(draft.encrypted)} : {}),
    channelId: draft.channelId, ...(draft.threadId ? { threadId: draft.threadId } : {}),
    text: draft.text.trim(), ...(draft.document ? { document: parseRichDocument(draft.document) } : {}),
    attachments, ...(draft.alsoSendToChannel === true ? { alsoSendToChannel: true } : {}), ...(draft.broadcastConfirmed === true ? { broadcastConfirmed: true } : {}),
  };
}

function restore(prefix: string): OutboxEntry[] {
  const rows: OutboxEntry[] = [];
  try {
    for (let i = 0; i < sessionStorage.length && rows.length < maxEntries; i++) {
      const key = sessionStorage.key(i);
      if (!key?.startsWith(prefix)) continue;
      const value = sessionStorage.getItem(key);
      if (!value || value.length > maxStorageLength) continue;
      try {
        const row = JSON.parse(value);
        if (!row || key !== prefix + row.id || typeof row.id !== 'string' || typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt))) continue;
        const entry = { ...copyContent(row), id: row.id, createdAt: row.createdAt };
        if (cancelling(row)) {
          rows.push({ ...entry, status: 'delete_failed', deleteAttempts: Number.isSafeInteger(row.deleteAttempts) ? row.deleteAttempts : 0 });
        } else {
          rows.push({ ...entry, status: 'failed', error: row.status === 'failed' && typeof row.error === 'string' ? row.error : unconfirmed });
        }
      } catch { /* A damaged entry must not hide the other sends. */ }
    }
  } catch { /* Storage access can be disabled by the browser. */ }
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export class MessageOutbox {
  private entries: OutboxEntry[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly queued = new Set<() => void>();
  private readonly delivered = new Set<(message: ChatMessage, thread: boolean) => void>();
  private updates?: BroadcastChannel;
  private deletionTail: Promise<void> = Promise.resolve();
  private readonly sending = new Set<string>();
  private readonly deleting = new Set<string>();
  private migration?: Promise<void>;
  constructor(private readonly viewerId: string, private readonly storageKey: string) {}
  getSnapshot = (): readonly OutboxEntry[] => this.entries;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      if (typeof BroadcastChannel !== 'undefined') {
        try { this.updates = new BroadcastChannel(this.storageKey); } catch { /* Storage partition disallows tab broadcasts. */ }
        if (this.updates) this.updates.onmessage = ({data}) => {
          for (const saved of data?.delivered ?? []) {
            const entry = this.entries.find(row => !cancelling(row) && this.matches(row, saved));
            if (entry) this.notifyDelivery(saved, entry);
          }
          void this.refresh().catch(() => {});
        };
      }
      void this.refresh().catch(() => {});
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) { this.updates?.close(); this.updates = undefined; }
    };
  };
  onQueued(listener: () => void) {
    this.queued.add(listener);
    return () => { this.queued.delete(listener); };
  }
  onDelivered(listener: (message: ChatMessage, thread: boolean) => void) {
    this.delivered.add(listener);
    return () => { this.delivered.delete(listener); };
  }

  private notifyDelivery(saved: ChatMessage, entry: OutboxEntry) {
    for (const listener of this.delivered) listener(saved, !!entry.threadId);
  }

  private async transaction(change?: (rows: OutboxEntry[]) => OutboxEntry[], delivered?: ChatMessage[]) {
    const { rows, changed } = await transactOutbox(this.storageKey, change);
    if (rows.length !== this.entries.length || rows.some((row, i) =>
      row.id !== this.entries[i]?.id || row.revision !== this.entries[i]?.revision)) {
      this.entries = rows;
      for (const listener of this.listeners) listener();
    }
    if (changed && typeof BroadcastChannel !== 'undefined') {
      // Other tabs may see the outbox removal before their socket receives the saved row.
      try {
        const channel = this.updates ?? new BroadcastChannel(this.storageKey);
        try { channel.postMessage(delivered?.length ? { delivered } : null); }
        finally { if (!this.updates) channel.close(); }
      } catch { /* The IndexedDB commit succeeded. Other tabs also refresh on focus. */ }
    }
  }

  private migrate() {
    if (!this.migration) {
      const legacy = restore(this.storageKey);
      const imported = new Set<string>();
      this.migration = (legacy.length ? this.transaction(rows => {
        const combined = [...rows];
        let length = JSON.stringify(rows).length;
        for (const entry of legacy) {
          if (!rows.some(row => row.id === entry.id)) {
            const extra = JSON.stringify(entry).length + (combined.length ? 1 : 0);
            if (combined.length >= maxEntries || length + extra > maxStorageLength) continue;
            combined.push(entry);
            length += extra;
          }
          imported.add(entry.id);
        }
        return combined.length === rows.length ? rows : combined;
      }).then(() => {
        for (const id of imported) sessionStorage.removeItem(this.storageKey + id);
        // Retry the remaining legacy rows after the shared queue has room.
        if (imported.size < legacy.length) this.migration = undefined;
      }) : Promise.resolve()).catch(error => { this.migration = undefined; throw error; });
    }
    return this.migration;
  }
  async refresh() {
    await this.migrate();
    await this.transaction();
  }
  private async replace(previous: OutboxEntry, next: OutboxEntry) {
    let replaced = false;
    next.revision = crypto.randomUUID();
    await this.transaction(rows => {
      const index = rows.findIndex(row => row.id === previous.id && row.revision === previous.revision);
      if (index < 0) return rows;
      replaced = true;
      const updated = [...rows]; updated[index] = next;
      return updated;
    });
    return replaced;
  }
  private async remove(predicate: (row: OutboxEntry) => boolean, delivered?: ChatMessage[]) {
    await this.migrate();
    await this.transaction(rows => {
      const next = rows.filter(row => !predicate(row));
      return next.length === rows.length ? rows : next;
    }, delivered);
  }

  async enqueue(draft: Draft, id:string=crypto.randomUUID()): Promise<OutboxEntry> {
    const entry: OutboxEntry = { ...copyContent(draft), id, createdAt: new Date().toISOString(), status: 'sending' };
    await this.migrate();
    await this.transaction(rows => {
      const next = [...rows, entry];
      if (next.length > maxEntries || JSON.stringify(next).length > maxStorageLength) throw new Error('Your outgoing message queue is full.');
      return next;
    });
    for (const listener of this.queued) listener();
    return entry;
  }

  async send(id: string, socket: Socket | undefined, broadcastConfirmed = false): Promise<ChatMessage | undefined> {
    const entry = this.entries.find(row => row.id === id);
    if (!entry || cancelling(entry) || this.sending.has(id) || (entry.error === confirmationRequired && !broadcastConfirmed)) return;
    this.sending.add(id);
    const attempt: OutboxEntry = entry.status === 'sending' && !broadcastConfirmed ? entry :
      { ...entry, status: 'sending', error: undefined, retryOnConnect: undefined, broadcastConfirmed: broadcastConfirmed || entry.broadcastConfirmed };
    try {
      if (attempt !== entry && !await this.replace(entry, attempt)) return;
      if (!socket?.connected) throw new Error('Reconnecting. Try again when connected.');
      const content = attempt.encrypted ? {encrypted:attempt.encrypted} : messageContent(attempt.text, attempt.document, attempt.attachments);
      const saved = await sendMessage(socket, attempt.channelId, attempt.threadId, id, content, attempt.broadcastConfirmed, this.viewerId, attempt.alsoSendToChannel);
      if (!this.matches(attempt, saved)) throw new Error(unconfirmed);
      if (!this.entries.some(row => row.id === id && !cancelling(row))) return;
      this.notifyDelivery(saved, entry);
      await this.remove(row => row.id === id && !cancelling(row), [saved]);
      return saved;
    } catch (reason) {
      const error = reason instanceof Error ? reason.message.slice(0, 240) : unconfirmed;
      await this.replace(attempt, { ...attempt, status: 'failed', error,
        retryOnConnect: !socket?.connected || /timed out|connection changed|reconnecting/i.test(error) });
    } finally { this.sending.delete(id); }
  }

  async resumeSends(socket: Socket, active: () => boolean, retryUnconfirmed = true) {
    await this.refresh();
    for (const row of this.entries) {
      if (!active() || !socket.connected) break;
      if (!this.entries.some(current => current.id === row.id && current.revision === row.revision)) continue;
      if (row.status === 'sending' || (retryUnconfirmed && row.status === 'failed' && row.retryOnConnect))
        await this.send(row.id, socket);
    }
  }

  private matches(entry: OutboxEntry, message: ChatMessage) {
    return message?.author?.kind === 'human' && message.author.id === this.viewerId && message.client_message_id === entry.id &&
      message.channel_id === entry.channelId && (entry.threadId ? message.thread_id === entry.threadId : !message.thread_root_id || message.thread_root_id === message.id);
  }

  reconcile(messages: readonly ChatMessage[]) {
    const matches = (row: OutboxEntry) => !cancelling(row) && messages.some(message => this.matches(row, message));
    if (this.entries.some(matches)) {
      const delivered = messages.filter(message => this.entries.some(row => !cancelling(row) && this.matches(row, message)));
      return this.remove(matches, delivered);
    }
  }

  async discard(id: string): Promise<ChatMessage | undefined> {
    const row = this.entries.find(entry => entry.id === id);
    if (!row || row.status === 'sending' || this.deleting.has(id)) return;
    const attempt: OutboxEntry = {
      id, channelId: row.channelId, threadId: row.threadId, createdAt: row.createdAt,
      text: '', attachments: [], status: 'deleting', deleteAttempts: Math.min((row.deleteAttempts ?? 0) + 1, 3),
    };
    this.deleting.add(id);
    try {
      if (!await this.replace(row, attempt)) return;
      return await this.deleteEntry(attempt);
    } finally { this.deleting.delete(id); }
  }

  private deleteEntry(attempt: OutboxEntry) {
    const { id, channelId } = attempt;
    // A reconnect may release many cancellations. Give each request a deadline and send one at a time.
    const result = this.deletionTail.then(async () => {
      if (!this.entries.some(entry => entry.id === id && entry.revision === attempt.revision)) return;
      try {
        const route = '/channels/' + encodeURIComponent(channelId) + '/outgoing/' + encodeURIComponent(id);
        const response = await request<{ message: ChatMessage | null }>(route, undefined, undefined, 'DELETE', AbortSignal.timeout(8000), this.viewerId);
        if (!this.entries.some(entry => entry.id === id && entry.revision === attempt.revision)) return;
        if (response.message !== null && (!this.matches(attempt, response.message) || !('deleted_at' in response.message) || !response.message.deleted_at))
          throw new Error('Delete was not confirmed');
        await this.remove(entry => entry.id === id && entry.revision === attempt.revision);
        return response.message ?? undefined;
      } catch (reason) {
        if (this.entries.some(entry => entry.id === id && entry.revision === attempt.revision)) {
          await this.replace(attempt, { ...attempt, status: 'delete_failed', error: reason instanceof Error ? reason.message.slice(0, 240) : 'Delete was not confirmed' });
        }
      }
    });
    this.deletionTail = result.then(() => {}, () => {});
    return result;
  }

  resumeDeletes(channelId?: string, onDeleted?: (message: ChatMessage) => void) {
    for (const row of this.entries) {
      if (!cancelling(row) || this.deleting.has(row.id) || (channelId && row.channelId !== channelId)) continue;
      if ((row.deleteAttempts ?? 0) >= 3) {
        if (row.status === 'deleting') void this.replace(row, { ...row, status: 'delete_failed' }).catch(() => {});
        continue;
      }
      void this.discard(row.id).then(message => { if (message) onDeleted?.(message); }).catch(() => {
        // A failed storage write leaves the cancellation marked for explicit retry.
      });
    }
  }

  purgeChannel(channelId: string) {
    return this.remove(row => row.channelId === channelId);
  }
}

// Share the in-memory snapshot within a tab. IndexedDB coordinates writes between tabs.
const stores = new Map<string, WeakRef<MessageOutbox>>();
export function getMessageOutbox(viewerId: string, workspaceId: string) {
  const key = 'space:message-outbox:v1:' + JSON.stringify([viewerId, workspaceId]) + ':';
  const existing = stores.get(key)?.deref();
  if (existing) return existing;
  for (const [id, store] of stores) if (!store.deref()) stores.delete(id);
  const box = new MessageOutbox(viewerId, key);
  stores.set(key, new WeakRef(box));
  return box;
}
