import { render, screen, within } from "@testing-library/react";
import type { ChatMessage } from "@space/contracts";
import { describe, expect, it } from 'vitest';
import { ConversationMessage, continuesMessageGroup } from './ThreadConversation.js';

const message = (created_at:string, id='kai', kind:'human'|'agent'='human') => ({created_at,author:{id,name:id,kind}});
describe('conversation message grouping',()=>{
 it('groups adjacent messages by the same author within five minutes',()=>{
  expect(continuesMessageGroup(message('2026-11-04T10:04:59'),message('2026-11-04T10:00:00'))).toBe(true);
 });
 it('starts a new group at history, sender, identity-kind and time boundaries',()=>{
  const current=message('2026-11-04T10:05:00');
  expect(continuesMessageGroup(current)).toBe(false);
  expect(continuesMessageGroup(current,message('2026-11-04T10:04:59','maya'))).toBe(false);
  expect(continuesMessageGroup(current,message('2026-11-04T10:04:59','kai','agent'))).toBe(false);
  expect(continuesMessageGroup(current,message('2026-11-04T10:00:00'))).toBe(false);
  expect(continuesMessageGroup(current,message('2026-11-04T10:06:00'))).toBe(false);
  expect(continuesMessageGroup(message('2026-11-05T00:01:00'),message('2026-11-04T23:59:00'))).toBe(false);
 });
});

it('shows the workflow name and badge on each post, including consecutive posts', () => {
 const post:ChatMessage={id:'m',channel_id:'c',thread_id:'t',task_id:null,client_message_id:null,
  author:{kind:'workflow',name:'IT Help Request',id:'service'},created_at:'2026-11-10T05:00:00Z',text:'VPN is down'};
 render(<ConversationMessage message={post} previous={post} viewerId="viewer" />);
 const header=screen.getByText('IT Help Request',{selector:'strong'}).parentElement!;
 expect(header.className).toBe('sp-message-meta');
 expect(within(header).getByText('Workflow')).toBeTruthy();
});
