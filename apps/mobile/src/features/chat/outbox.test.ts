import type { ChatMessage } from '@space/contracts';
import { failed, reconcile, sending, type Outgoing } from './outbox';

const saved = (clientId: string, author = 'u1'): ChatMessage => ({
  id: `m-${clientId}`, client_message_id: clientId, channel_id: 'c', thread_id: 't', task_id: null,
  text: 'hi', created_at: '2026-11-11T00:00:00Z', author: { kind: 'human', id: author, name: 'Kai' },
});

it('adds pending messages and retries one in place', () => {
  let list = sending(sending([], { id: 'a', text: 'one' }), { id: 'b', text: 'two' });
  list = failed(list, 'a', 'Connection changed. Try again.');
  expect(list.map(entry => [entry.id, entry.status])).toEqual([['a', 'failed'], ['b', 'sending']]);
  list = sending(list, list[0]!);
  expect(list).toEqual([{ id: 'a', text: 'one', status: 'sending' }, { id: 'b', text: 'two', status: 'sending' }]);
});

it('removes entries the viewer\'s saved message confirms', () => {
  const list: Outgoing[] = [{ id: 'a', text: 'one', status: 'failed', error: 'x' }, { id: 'b', text: 'two', status: 'sending' }];
  expect(reconcile(list, [saved('a')], 'u1').map(entry => entry.id)).toEqual(['b']);
});

it('ignores another person\'s message with the same client id', () => {
  const list: Outgoing[] = [{ id: 'a', text: 'one', status: 'sending' }];
  expect(reconcile(list, [saved('a', 'u2')], 'u1')).toBe(list);
});
