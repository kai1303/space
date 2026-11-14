import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ComposerDraftRow, ComposerDraftValue } from '@space/contracts';
import { DraftSync, emptyDraft } from './draft-sync.js';
import { request } from '../../shared/api/request.js';

const events = vi.hoisted(() => ({ refresh: async () => {} }));
vi.mock('../../shared/realtime/live-updates.js', () => ({
  subscribeUpdates: (_scope: string, _actor: string, refresh: () => Promise<void>) => {
    events.refresh = refresh;
    void refresh();
    return () => {};
  },
  invalidateUpdates: () => events.refresh(),
}));
vi.mock('../../shared/api/request.js', () => ({ request: vi.fn() }));

const viewer = crypto.randomUUID(), key = crypto.randomUUID();
const doc = (insert: string) => ({ ops: [{ insert }] });
const content = (insert: string) => ({ document: doc(insert), attachments: [] });
const value = (insert: string) => ({ document: doc(insert), files: [] });
let row: ComposerDraftRow;
let offline = false;
let loseAck = false;
let stop = () => {};
const tick = () => vi.advanceTimersByTimeAsync(500);
function client(legacy = {}) {
  const apply = vi.fn(), notify = vi.fn();
  const sync = new DraftSync(viewer, { apply, changed: vi.fn(), notify, journaled: vi.fn() });
  stop = sync.start(legacy);
  return { apply, notify, sync };
}
beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  offline = loseAck = false;
  row = { key, workspace_id: crypto.randomUUID(), destination_name: 'General', revision: crypto.randomUUID(), value: value('Original') };
  vi.mocked(request).mockImplementation(async (path, body) => {
    if (offline) throw Error('offline');
    if (path === '/composer-drafts') return { items: row.value ? [row] : [], next: null };
    if (!body) return row;
    const edit = body as { value: ComposerDraftValue; mutation_id: string; base: string };
    if (edit.mutation_id === row.revision) return row;
    if (row.revision !== edit.base) throw Error('draft_conflict');
    row = { ...row, value: edit.value, revision: edit.mutation_id };
    if (loseAck) { loseAck = false; throw Error('Response lost'); }
    return row;
  });
});
afterEach(() => { stop(); vi.clearAllMocks(); vi.useRealTimers(); });

it('keeps competing offline edits until the author explicitly chooses a version', async () => {
  const first = client();
  await tick();
  offline = true;
  first.sync.edit(key, content('Local copy'));
  await tick();
  stop();
  row = { ...row, value: value('From another device'), revision: crypto.randomUUID() };
  offline = false;
  const second = client();
  await tick();
  expect(second.sync.conflicts.has(key)).toBe(true);
  expect(second.apply).toHaveBeenCalledWith(key, content('Local copy'), false);
  expect(row.value).toEqual(value('From another device'));
  await second.sync.resolve(key, true);
  await tick();
  expect(row.value).toEqual(value('Local copy'));
  expect(localStorage.length).toBe(0);
});

it('replays a deletion after a lost acknowledgement using the original mutation ID', async () => {
  const { sync } = client();
  await tick();
  loseAck = true;
  sync.edit(key, emptyDraft);
  await tick();
  expect(row.value).toBeNull();
  const deletion = row.revision;
  stop();
  const reopened = client();
  await tick();
  expect(row.revision).toBe(deletion);
  expect(reopened.sync.conflicts.size).toBe(0);
  expect(localStorage.length).toBe(0);
});

it('preserves a legacy draft that differs from the cloud copy and can accept the remote version', async () => {
  const { sync, apply } = client({ [key]: doc('Legacy text') });
  await tick();
  expect(sync.conflicts.has(key)).toBe(true);
  await sync.resolve(key, false);
  expect(apply).toHaveBeenLastCalledWith(key, content('Original'), false);
  expect(localStorage.length).toBe(0);
});
