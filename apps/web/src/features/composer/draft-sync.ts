import { parseComposerDraftKey, parseComposerDraftMutation, type ComposerDraftPage, type ComposerDraftRow, type ComposerDraftValue, type RichDocument } from '@space/contracts';
import type { Attachment } from '@space/ui/rich-text';
import { request } from '../../shared/api/request.js';
import { invalidateUpdates, subscribeUpdates } from '../../shared/realtime/live-updates.js';
import { DM_DRAFT_KEY_AVAILABLE, openDmDraft, sealDmDraft } from '../direct-messages/encryption/draft-crypto.js';

export type DraftContent = { document: RichDocument; attachments: Attachment[] };
export const emptyDraft: DraftContent = { document: { ops: [] }, attachments: [] };
export function destination(key: string) {
  try { return parseComposerDraftKey(key); } catch { return undefined; }
}
type Snapshot = Pick<ComposerDraftRow, 'key' | 'value'> &
  Partial<Pick<ComposerDraftRow, 'workspace_id' | 'destination_name'>> & { revision: string | null };
type Edit = { base?: string | null; mutation_id: string; value: ComposerDraftValue };
type Callbacks = {
  apply: (key: string, content: DraftContent, locked: boolean) => void;
  changed?: () => void;
  notify: (message: string) => void;
  journaled: (key: string) => void;
};

async function encode(viewer: string, key: string, { document, attachments }: DraftContent): Promise<ComposerDraftValue> {
  const ready = attachments.filter(file => file.status === 'ready' || !file.status);
  if (!document.ops.some(op => op.insert.trim()) && !ready.length) return null;
  if (key.startsWith('encrypted:')) return sealDmDraft(viewer, key.slice(10), document, ready);
  const files = ready.map(({ id, name, size, type, description }) => ({
    id, name, size, type, ...(description?.trim() && { description: description.trim() }),
  }));
  return { document, files };
}

async function decode(viewer: string, key: string, value: ComposerDraftValue): Promise<DraftContent> {
  if (!value) return emptyDraft;
  if (key.startsWith('encrypted:')) {
    if (!('ciphertext' in value)) throw Error('Invalid encrypted draft.');
    return openDmDraft(viewer, key.slice(10), value.ciphertext, value.asset_ids);
  }
  if ('ciphertext' in value) throw Error('Invalid conversation draft.');
  return { document: value.document, attachments: value.files.map(file => ({ ...file, status: 'ready' })) };
}

// JSONB can return rich-text attributes in a different order.
function comparable(value: ComposerDraftValue) {
  return JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}

export class DraftSync {
  private revision = 0;
  private readonly listeners = new Set<() => void>();
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  readonly snapshot = () => this.revision;
  private changed() {
    this.revision++;
    for (const listener of this.listeners) listener();
    this.callbacks.changed?.();
  }
  private readonly base = '/composer-drafts';
  private readonly prefix: string;
  private readonly rows = new Map<string, Snapshot>();
  private readonly edits = new Map<string, Edit>();
  private readonly generations = new Map<string, number>();
  private readonly encoding = new Set<string>();
  private readonly unsealed = new Map<string, DraftContent>();
  private readonly running = new Set<string>();
  private readonly skipped = new Set<string>();
  private readonly retryable = new Set<string>();
  private readonly locked = new Set<string>();
  readonly conflicts = new Set<string>();
  readonly failures = new Map<string, string>();
  loadError = '';
  loaded = false;
  private controller = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private active = false;

  constructor(private viewer: string, private callbacks: Callbacks) {
    this.prefix = 'space:draft-edit:' + viewer + ':';
  }

  metadata(key: string) { return this.rows.get(key); }

  private conflict(key: string) {
    if (!this.conflicts.has(key)) this.callbacks.notify('This draft changed on another device. Choose a version in Drafts & sent.');
    this.conflicts.add(key);
  }

  private generation(key: string) { return this.generations.get(key) ?? 0; }
  private touch(key: string) {
    const next = this.generation(key) + 1;
    this.generations.set(key, next);
    return next;
  }

  private persist(key: string, edit: Edit) {
    this.edits.set(key, edit);
    try { localStorage.setItem(this.prefix + key, JSON.stringify(edit)); this.callbacks.journaled(key); }
    catch { this.callbacks.notify('Browser storage is unavailable. Keep this window open until the draft syncs.'); }
  }

  private removeEdit(key: string) {
    const edit = this.edits.get(key);
    this.edits.delete(key);
    try {
      const stored = localStorage.getItem(this.prefix + key);
      if (stored && JSON.parse(stored).mutation_id === edit?.mutation_id) localStorage.removeItem(this.prefix + key);
    } catch { /* Another tab may have replaced this edit. */ }
    this.conflicts.delete(key);
    this.failures.delete(key);
    this.retryable.delete(key);
  }

  private async display(row: Snapshot, generation: number) {
    let content = emptyDraft, locked = false;
    try { content = await decode(this.viewer, row.key, row.value); } catch { locked = true; }
    if (!this.active || generation !== this.generation(row.key)) return;
    if (locked) this.locked.add(row.key); else this.locked.delete(row.key);
    this.callbacks.apply(row.key, content, locked);
  }

  start(legacy: Record<string, RichDocument>) {
    this.controller = new AbortController();
    this.active = true;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const name = localStorage.key(i);
        if (!name?.startsWith(this.prefix)) continue;
        const key = name.slice(this.prefix.length);
        if (!destination(key)) continue;
        try {
          const edit: Edit = JSON.parse(localStorage.getItem(name)!);
          parseComposerDraftMutation({ ...edit, base: edit.base ?? null }, key.startsWith('encrypted:'));
          this.edits.set(key, edit);
          void this.display({ key, revision: edit.mutation_id, value: edit.value }, this.generation(key));
        } catch { /* Skip a damaged entry without hiding other drafts. */ }
      }
    } catch { /* Storage can be unavailable. */ }
    for (const [key, document] of Object.entries(legacy)) {
      if (destination(key) && !key.startsWith('encrypted:') && !this.edits.has(key)) {
        this.edit(key, { document, attachments: [] });
      }
    }
    const stop = subscribeUpdates('drafts', this.viewer, () => this.refresh(), () => {
      for (const key of new Set([...this.rows.keys(), ...this.edits.keys(), ...this.unsealed.keys()])) this.forget(key);
    });
    const wake = () => { void this.retry(); };
    window.addEventListener('online', wake);
    window.addEventListener(DM_DRAFT_KEY_AVAILABLE, wake);
    return () => {
      this.active = false;
      this.controller.abort();
      clearTimeout(this.timer);
      this.timer = undefined;
      window.removeEventListener('online', wake);
      window.removeEventListener(DM_DRAFT_KEY_AVAILABLE, wake);
      stop();
    };
  }

  edit(key: string, content: DraftContent) {
    if (!destination(key) || this.locked.has(key)) return;
    const generation = this.touch(key);
    this.unsealed.set(key, content);
    this.encoding.add(key);
    void encode(this.viewer, key, content).then(value => {
      if (this.generation(key) !== generation) return;
      const base = this.edits.has(key) ? this.edits.get(key)!.base : this.rows.get(key)?.revision;
      this.unsealed.delete(key);
      this.persist(key, { base, mutation_id: crypto.randomUUID(), value });
      this.failures.delete(key);
      this.retryable.delete(key);
      this.schedule();
    }).catch(error => {
      if (this.generation(key) === generation) {
        this.failures.set(key, error.message);
        this.callbacks.notify(error.message);
      }
    }).finally(() => {
      if (this.generation(key) === generation) { this.encoding.delete(key); this.changed(); }
    });
  }

  private schedule() {
    if (!this.active || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.pump(); }, 400);
  }

  private pump() {
    if (!this.active) return;
    for (const [key, edit] of this.edits) {
      if (this.running.size >= 4) break;
      if (this.running.has(key) || this.encoding.has(key) || this.conflicts.has(key) || this.failures.has(key)) continue;
      this.running.add(key);
      void this.send(key, edit).finally(() => {
        this.running.delete(key);
        if (this.active) { this.changed(); this.schedule(); }
      });
    }
  }

  private point(key: string) {
    return request<Snapshot>(this.base + '/' + encodeURIComponent(key), undefined, undefined, 'POST', this.controller.signal, this.viewer);
  }

  private async send(key: string, edit: Edit) {
    const signal = this.controller.signal;
    try {
      if (edit.base === undefined) {
        const current = await this.point(key);
        if (signal.aborted || this.edits.get(key) !== edit) return;
        this.rows.set(key, current);
        if (comparable(current.value) === comparable(edit.value)) { this.removeEdit(key); return; }
        if (current.value !== null) {
          this.conflict(key);
          return;
        }
        edit.base = current.revision;
        this.persist(key, edit);
      }
      const saved = await request<ComposerDraftRow>(this.base + '/' + encodeURIComponent(key), edit, undefined, 'PUT', signal, this.viewer);
      if (signal.aborted || !this.edits.has(key)) return;
      this.rows.set(key, saved);
      const latest = this.edits.get(key)!;
      if (latest === edit) {
        this.removeEdit(key);
        if (this.skipped.delete(key)) void invalidateUpdates('drafts', this.viewer);
      }
      else this.persist(key, { ...latest, base: saved.revision });
    } catch (error) {
      if (signal.aborted || !this.edits.has(key)) return;
      const message = error instanceof Error ? error.message : 'Cannot sync this draft.';
      if (message === 'draft_conflict') {
        this.conflict(key);
        try {
          const current = await this.point(key);
          if (!signal.aborted && this.conflicts.has(key)) this.rows.set(key, current);
        } catch { /* A later refresh can recover the destination label. */ }
      }
      else if (['not_found', 'forbidden', 'dm_encryption_mode_changed'].includes(message)) this.forget(key);
      else {
        this.failures.set(key, message); this.retryable.add(key);
        this.callbacks.notify('Draft hasn’t synced. Open Drafts & sent to retry.');
      }
    }
  }

  private async refresh() {
    const signal = this.controller.signal;
    const before = new Map(this.rows);
    const incoming = new Map<string, Snapshot>();
    try {
      let next: string | null = null;
      do {
        const page: ComposerDraftPage = await request(this.base + (next ? '?after=' + encodeURIComponent(next) : ''), undefined, undefined, 'POST', signal, this.viewer);
        for (const row of page.items) incoming.set(row.key, row);
        next = page.next;
      } while (next && !signal.aborted);
      if (signal.aborted) return;
      for (const [key, row] of before) {
        if (row.value !== null && !incoming.has(key)) incoming.set(key, { key, revision: null, value: null });
      }
      for (const [key, row] of incoming) {
        if (signal.aborted) return;
        if (this.edits.has(key) || this.unsealed.has(key)) {
          this.skipped.add(key);
          const dirty = this.edits.get(key);
          if (row.revision === null && before.has(key)) {
            try { await this.point(key); }
            catch (reason) {
              if (!signal.aborted && reason instanceof Error && ['not_found','dm_encryption_mode_changed'].includes(reason.message)) this.forget(key);
            }
          } else if (row.workspace_id && !this.rows.has(key) && dirty && !this.unsealed.has(key)) {
            this.rows.set(key, row);
          }
          continue;
        }
        if (this.rows.get(key) !== before.get(key)) {
          // A PUT settled during this read. Recheck once after the acknowledged write.
          void invalidateUpdates('drafts', this.viewer);
          continue;
        }
        const prior = this.rows.get(key);
        if (prior && prior.revision === row.revision && !this.locked.has(key)) continue;
        // A deletion is absent from a list page. Read its tombstone before the next create.
        if (row.revision === null) this.rows.delete(key); else this.rows.set(key, row);
        await this.display(row, this.generation(key));
      }
      this.loadError = '';
      this.loaded = true;
      for (const key of this.retryable) this.failures.delete(key);
      this.retryable.clear();
      this.schedule();
    } catch (error) {
      if (signal.aborted) return;
      this.loadError = error instanceof Error ? error.message : 'Cannot load drafts.';
    }
    this.changed();
  }

  async retry() {
    for (const [key, content] of this.unsealed) if (!this.encoding.has(key)) this.edit(key, content);
    await invalidateUpdates('drafts', this.viewer);
  }

  async resolve(key: string, useLocal: boolean) {
    const edit = this.edits.get(key);
    if (!edit) return;
    try {
      const current = await this.point(key);
      if (!this.active || this.edits.get(key) !== edit) return;
      this.rows.set(key, current);
      if (useLocal) {
        this.persist(key, { ...edit, base: current.revision, mutation_id: crypto.randomUUID() });
        this.conflicts.delete(key);
        this.failures.delete(key);
        this.schedule();
      } else {
        this.removeEdit(key);
        await this.display(current, this.touch(key));
      }
    } catch (error) { if (this.active) this.failures.set(key, error instanceof Error ? error.message : 'Cannot load draft.'); }
    if (this.active) this.changed();
  }

  forget(key: string) {
    this.touch(key);
    this.encoding.delete(key);
    this.unsealed.delete(key);
    this.removeEdit(key);
    this.rows.delete(key);
    this.locked.delete(key);
    this.skipped.delete(key);
    this.callbacks.apply(key, emptyDraft, false);
  }
}
