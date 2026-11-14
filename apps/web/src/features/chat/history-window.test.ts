import { expect, it } from 'vitest';
import type { ChatMessage, MessagePage } from '@space/contracts';
import { appendLive, mergePage, HISTORY_LIMIT } from './history-window.js';

const message = (n: number): ChatMessage => ({ id: String(n), sequence: String(n), channel_id: 'channel', thread_id: 'thread', task_id: null, client_message_id: null, created_at: '2026-11-03T00:00:00Z', text: String(n), author: { kind: 'human', id: 'user', name: 'Kai' } });
const page = (start: number, end: number, older = true, newer = false): MessagePage => ({ messages: Array.from({ length: end - start + 1 }, (_, i) => message(start + i)), older_cursor: String(start), newer_cursor: String(end), has_older: older, has_newer: newer, event_cursor: String(end + 3) });

it('deduplicates overlapping pages and keeps chronological order across sequence gaps', () => {
  const result = mergePage(page(51, 100), page(1, 51, false, true), 'older');
  expect(result.messages.map(m => m.id)).toEqual(Array.from({ length: 100 }, (_, i) => String(i + 1)));
  expect(result.has_older).toBe(false);
  expect(result.has_newer).toBe(false);
});
it('evicts the far end and exposes a way back in both directions', () => {
  const older = mergePage(page(51, 550), page(1, 50, false, true), 'older');
  expect(older.messages).toHaveLength(HISTORY_LIMIT);
  expect([older.older_cursor, older.newer_cursor, older.has_newer]).toEqual(['1', '500', true]);
  const newer = mergePage(older, page(501, 550), 'newer');
  expect(newer.messages).toHaveLength(HISTORY_LIMIT);
  expect([newer.older_cursor, newer.newer_cursor, newer.has_older, newer.has_newer]).toEqual(['51', '550', true, false]);
});
it('does not evict what the user is reading when live messages fill the cache', () => {
  const result = appendLive(page(1, 500, false), [message(501)], false);
  expect(result.messages[0]?.id).toBe('1');
  expect(result.messages).toHaveLength(500);
  expect(result.has_newer).toBe(true);
  const pinned = appendLive(page(1, 500, false), [message(501)], true);
  expect([pinned.messages[0]?.id, pinned.newer_cursor, pinned.has_older]).toEqual(['2', '501', true]);
});
it('does not splice live messages onto a historical window with a gap', () => {
  const result = appendLive(page(1, 50, false, true), [message(1000)], true);
  expect(result.newer_cursor).toBe('50');
  expect(result.messages).toHaveLength(50);
});
it('keeps messages delivered during a latest-page request without retaining old history', () => {
  const result = mergePage(page(1, 105, false), page(51, 100), 'latest');
  expect(result.messages[0]?.id).toBe('51');
  expect(result.messages.at(-1)?.id).toBe('105');
  expect(result.messages.some(m => m.id === '101')).toBe(false); // snapshot watermark is 103
});

it('retains an edit delivered while the latest history page was loading', () => {
  const snapshot = page(51, 54);
  const edited = { ...message(52), text: '😂 hello', reaction_sequence: '58' };
  const updated = appendLive(snapshot, [edited], true);
  expect(mergePage(updated, snapshot, 'latest').messages[1]).toEqual(edited);
});

it('updates reactions in older history without inserting unseen messages or moving the window', () => {
  const old = page(1, 50, false, true);
  const updated = {...message(10),reaction_sequence:'101',reactions:[{emoji:'👀',count:1,user_ids:['user']}]};
  const result = appendLive(old,[updated,{...message(99),reaction_sequence:'102',reactions:[]}],false);
  expect(result.messages).toHaveLength(50);
  expect(result.messages.find(m=>m.id==='10')?.reactions).toEqual(updated.reactions);
  expect(result.messages.some(m=>m.id==='99')).toBe(false);
  expect(result.older_cursor).toBe('1');
  expect(result.newer_cursor).toBe('50');
  const stale = mergePage(result,page(1,50,false,true),'older');
  expect(stale.messages.find(m=>m.id==='10')?.reaction_sequence).toBe('101');
});
it('does not pull an old unseen message into the live end when its reaction changes', () => {
  const latest = page(51,100);
  const next = appendLive(latest,[{...message(5),reaction_sequence:'110',reactions:[]}],true);
  expect(next.messages.map(m=>m.id)).toEqual(latest.messages.map(m=>m.id));
});
it('retains a reaction update when a simultaneous new message overflows an unpinned window', () => {
  const updated = {...message(10),reaction_sequence:'600',reactions:[{emoji:'👀',count:1,user_ids:['user']}]};
  const result = appendLive(page(1,500,false),[updated,message(501)],false);
  expect(result.messages).toHaveLength(500);
  expect(result.has_newer).toBe(true);
  expect(result.messages.find(m=>m.id==='10')?.reaction_sequence).toBe('600');
});

it('keeps reply counts monotonic through duplicate delivery, reaction updates and stale pages',()=>{
  const root={...message(1),thread_root_id:'1',reply_count:0};
  const previous={...page(1,1,false,true),messages:[root]};
  const reply={...message(100),thread_root_id:'1',reply_count:5};
  const unseen={...message(101),thread_root_id:'99',reply_count:1};
  const live=appendLive(previous,[reply,unseen,reply],false,true);
  expect(live.messages).toHaveLength(1);
  expect(live.messages[0]!.reply_count).toBe(5);
  expect(live.newer_cursor).toBe('1');
  const reaction={...root,reaction_sequence:'102',reactions:[{emoji:'👀',count:1,user_ids:['user']}]};
  const updated=appendLive(live,[reaction],false,true);
  expect(updated.messages[0]!.reactions).toEqual(reaction.reactions);
  expect(updated.messages[0]!.reply_count).toBe(5);
  const stale=mergePage(updated,{...previous,messages:[root]},'older');
  expect(stale.messages[0]!.reply_count).toBe(5);
});

it.each([false,true])('attaches live session references below the root without counting them as replies: rootsOnly=%s',rootsOnly=>{
 const root={...message(1),thread_root_id:'1',reply_count:0};
 const ref={...message(2),thread_root_id:'1',reply_count:1,agent_session_id:'session',text:'Research',author:{kind:'agent' as const,id:'agent',name:'Codex'}};
 const previous={...page(1,1,false),messages:[root]};
 const once=appendLive(previous,[ref],true,rootsOnly);
 const twice=appendLive(once,[ref],true,rootsOnly);
 const updated=twice.messages.find(m=>m.id===root.id)!;
 expect(updated.agent_sessions).toEqual([{id:'session',title:'Research',agent_name:'Codex'}]);
 const batched=appendLive({...previous,messages:[],older_cursor:null,newer_cursor:null},[root,ref],true,rootsOnly);
 expect(batched.messages.find(m=>m.id===root.id)?.agent_sessions).toEqual(updated.agent_sessions);
 expect(updated.reply_count).toBe(0);
 expect(mergePage(twice,previous,'older').messages.find(m=>m.id===root.id)?.agent_sessions).toEqual(updated.agent_sessions);
});

it('keeps tombstones in place through replay and stale pages', () => {
  const latest = page(51, 54);
  const deleted = { ...message(52), text: '', deleted_at: '2026-11-09T00:00:00Z' };
  const oldDeletion = { ...deleted, id: '2', sequence: '2' };
  const previousReaction = { ...message(52), reaction_sequence: '100' };
  const updated = appendLive(latest, [previousReaction, deleted, oldDeletion, previousReaction], true);
  expect(updated.messages.map(m => m.id)).toEqual(latest.messages.map(m => m.id));
  expect(updated.messages[1]).toMatchObject(deleted);
  for (const direction of ['older', 'latest'] as const) {
    expect(mergePage(updated, latest, direction).messages[1]).toMatchObject(deleted);
  }
});

it('merges the newest reply summary into its root across echoed replies, deletion and stale pages',()=>{
 const summary = (revision:string,count:number) => ({revision,count,participants:[],participant_count:0,last_reply_at:null});
 const root={...message(1),thread_root_id:'1',reply_summary:summary('1',0)};
 const previous={...page(1,1,false),messages:[root]};
 const reply={...message(2),thread_root_id:'1',reply_summary:summary('2',1),reply_count:1};
 const deletion={...reply,deleted_at:'2026-01-01',reaction_sequence:'3',reply_summary:summary('3',0)};
 const latest=appendLive(previous,[reply,deletion,reply],true,true);
 expect(latest.messages).toHaveLength(1);
 expect(latest.messages[0]!.reply_summary).toEqual(deletion.reply_summary);
 expect(mergePage(latest,{...previous,messages:[{...root,reply_summary:reply.reply_summary}]},'older').messages[0]!.reply_summary).toEqual(deletion.reply_summary);
});

it('places a promoted reply at its channel position and keeps the original position in the thread', () => {
  const reply = {...message(2),thread_root_id:'1'};
  const visible = appendLive(page(1,1,false),[reply,message(3)],true,true);
  const promoted = {...reply,channel_broadcast_sequence:'4',reaction_sequence:'4'};
  expect(appendLive(visible,[promoted,promoted],true,true).messages.map(m=>[m.id,m.sequence])).toEqual([['1','1'],['3','3'],['2','4']]);
  expect(appendLive(page(1,2,false),[promoted],true).messages.map(m=>[m.id,m.sequence])).toEqual([['1','1'],['2','2']]);
});
