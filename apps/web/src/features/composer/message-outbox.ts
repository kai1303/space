import { MAX_MESSAGE_ASSETS, parseRichDocument, type AssetAttachment, type ChatMessage, type RichDocument } from '@space/contracts';
import type { Socket } from 'socket.io-client';
import { request } from '../../shared/api/request.js';
import { messageContent, sendMessage } from './message-sender.js';

type Draft = {
  channelId: string; threadId?: string; text: string; document?: RichDocument;
  attachments?: AssetAttachment[]; broadcastConfirmed?: boolean;
};
export type OutboxEntry = Draft & {
  id: string; createdAt: string; attachments: AssetAttachment[];
  status: 'sending' | 'failed' | 'deleting' | 'delete_failed'; error?: string; deleteAttempts?: number;
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
  return {
    channelId: draft.channelId, ...(draft.threadId ? { threadId: draft.threadId } : {}),
    text: draft.text.trim(), ...(draft.document ? { document: parseRichDocument(draft.document) } : {}),
    attachments, ...(draft.broadcastConfirmed === true ? { broadcastConfirmed: true } : {}),
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
  private entries: OutboxEntry[];
  private readonly listeners = new Set<() => void>();
  private deletionTail: Promise<void> = Promise.resolve();
  private readonly sending = new Set<string>();
  constructor(private readonly viewerId: string, private readonly storageKey: string) {
    this.entries = restore(storageKey);
  }
  getSnapshot = (): readonly OutboxEntry[] => this.entries;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(next: OutboxEntry[]) {
    this.entries = next;
    for (const listener of this.listeners) listener();
  }

  private setStatus(previous: OutboxEntry, next: OutboxEntry, requirePersistence = false) {
    try { sessionStorage.setItem(this.storageKey + next.id, JSON.stringify(next)); }
    catch {
      if (requirePersistence) throw new Error('Could not save the deletion. Try again.');
      // The previous intent and key remain recoverable if an error description exceeds quota.
    }
    this.publish(this.entries.map(row => row === previous ? next : row));
  }

  private remove(shouldRemove: (row: OutboxEntry) => boolean) {
    const next = this.entries.filter(row => {
      if (!shouldRemove(row)) return true;
      // Deleting a single persisted key succeeds even if another send filled the remaining quota.
      try { sessionStorage.removeItem(this.storageKey + row.id); } catch { /* Storage is unavailable. */ }
      return false;
    });
    if (next.length !== this.entries.length) this.publish(next);
  }

  enqueue(draft: Draft): OutboxEntry {
    const entry: OutboxEntry = { ...copyContent(draft), id: crypto.randomUUID(), createdAt: new Date().toISOString(), status: 'sending' };
    const next = [...this.entries, entry];
    if (next.length > maxEntries || JSON.stringify(next).length > maxStorageLength) throw new Error('Your outgoing message queue is full.');
    try { sessionStorage.setItem(this.storageKey + entry.id, JSON.stringify(entry)); }
    catch { throw new Error('Could not save the outgoing message. Your draft is still here.'); }
    this.publish(next);
    return entry;
  }

  async send(id: string, socket: Socket | undefined, broadcastConfirmed = false): Promise<ChatMessage | undefined> {
    const entry = this.entries.find(row => row.id === id);
    if (!entry || cancelling(entry) || this.sending.has(id) || (entry.error === confirmationRequired && !broadcastConfirmed)) return;
    this.sending.add(id);
    const attempt: OutboxEntry = entry.status === 'sending' && !broadcastConfirmed ? entry :
      { ...entry, status: 'sending', error: undefined, broadcastConfirmed: broadcastConfirmed || entry.broadcastConfirmed };
    if (attempt !== entry) this.setStatus(entry, attempt);
    try {
      if (!socket) throw new Error('Reconnecting. Try again when connected.');
      const content = messageContent(attempt.text, attempt.document, attempt.attachments);
      const saved = await sendMessage(socket, attempt.channelId, attempt.threadId, id, content, attempt.broadcastConfirmed);
      if (!this.entries.includes(attempt)) return;
      if (!this.matches(attempt, saved)) throw new Error(unconfirmed);
      this.remove(row => row === attempt);
      return saved;
    } catch (reason) {
      if (this.entries.includes(attempt)) {
        const error = reason instanceof Error ? reason.message.slice(0, 240) : unconfirmed;
        this.setStatus(attempt, { ...attempt, status: 'failed', error });
      }
    } finally { this.sending.delete(id); }
  }

  private matches(entry: OutboxEntry, message: ChatMessage) {
    return message?.author?.kind === 'human' && message.author.id === this.viewerId && message.client_message_id === entry.id &&
      message.channel_id === entry.channelId && (entry.threadId ? message.thread_id === entry.threadId : !message.thread_root_id || message.thread_root_id === message.id);
  }

  reconcile(messages: readonly ChatMessage[]) {
    this.remove(row => !cancelling(row) && messages.some(message => this.matches(row, message)));
  }

  async discard(id: string): Promise<ChatMessage | undefined> {
    const row = this.entries.find(entry => entry.id === id);
    if (!row || (row.status !== 'failed' && row.status !== 'delete_failed')) return;
    const attempt: OutboxEntry = {
      id, channelId: row.channelId, threadId: row.threadId, createdAt: row.createdAt,
      text: '', attachments: [], status: 'deleting', deleteAttempts: Math.min((row.deleteAttempts ?? 0) + 1, 3),
    };
    this.setStatus(row, attempt, true);
    // A reconnect may release many cancellations. Give each request a deadline and send one at a time.
    const result = this.deletionTail.then(async () => {
      if (!this.entries.includes(attempt)) return;
      try {
        const route = '/channels/' + encodeURIComponent(row.channelId) + '/outgoing/' + encodeURIComponent(id);
        const response = await request<{ message: ChatMessage | null }>(route, undefined, undefined, 'DELETE', AbortSignal.timeout(8000), this.viewerId);
        if (!this.entries.includes(attempt)) return;
        if (response.message !== null && (!this.matches(attempt, response.message) || !('deleted_at' in response.message) || !response.message.deleted_at))
          throw new Error('Delete was not confirmed');
        this.remove(entry => entry === attempt);
        return response.message ?? undefined;
      } catch (reason) {
        if (this.entries.includes(attempt)) {
          this.setStatus(attempt, { ...attempt, status: 'delete_failed', error: reason instanceof Error ? reason.message.slice(0, 240) : 'Delete was not confirmed' });
        }
      }
    });
    this.deletionTail = result.then(() => {}, () => {});
    return result;
  }

  resumeDeletes(channelId?: string, onDeleted?: (message: ChatMessage) => void) {
    for (const row of this.entries) {
      if (row.status !== 'delete_failed' || (channelId && row.channelId !== channelId) || (row.deleteAttempts ?? 0) >= 3) continue;
      void this.discard(row.id).then(message => { if (message) onDeleted?.(message); }).catch(() => {
        // A failed storage write leaves the cancellation marked for explicit retry.
      });
    }
  }

  purgeChannel(channelId: string) {
    this.remove(row => row.channelId === channelId);
  }
}

// Keep one writer per tab and scope while mounted components or outstanding commands reference it.
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
