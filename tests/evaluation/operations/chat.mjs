import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';

export async function chatWorkload({ origin, client, measure, concurrency, rounds, failures }) {
  const people = [];
  const sockets = [];
  const pending = new Map();
  const setup = (user, method, path, body, status = 200) => user.call(null, 'Set up chat fixture', method, '/v1' + path, body, status);
  async function open(person) {
    const socket = io(person.address, { autoConnect: false, reconnection: false, timeout: 5000, transports: ['websocket'],
      extraHeaders: { origin, cookie: person.cookie } });
    sockets.push(socket);
    await new Promise((resolve, reject) => socket.once('connect', resolve).once('connect_error', reject).connect());
    return socket;
  }
  async function command(socket, name, data) {
    const ack = await socket.timeout(5000).emitWithAck(name, data);
    assert.ok(ack.data, name + ': ' + ack.error);
    return ack.data;
  }
  function receipt(id) {
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Peer delivery timed out')); }, 8000);
      pending.set(id, () => { clearTimeout(timer); pending.delete(id); resolve(); });
    });
    return promise;
  }
  let completed = 0;
  try {
    for (let i = 0; i <= concurrency; i++) {
      const person = client('192.0.2.' + (i + 1), i);
      const { user } = await setup(person, 'POST', '/auth/sign-up/email', { name: 'Participant ' + i,
        password: 'Bench-' + randomUUID(), email: randomUUID() + '@example.test' });
      people.push({ person, id: user.id });
    }
    const owner = people[0].person, observer = people.at(-1);
    const ws = (await setup(owner, 'POST', '/workspaces', { name: 'Chat benchmark' }, 201)).id;
    const base = '/v1/workspaces/' + ws, channels = base + '/channels';
    for (const { id } of people.slice(1)) await setup(owner, 'POST', '/workspaces/' + ws + '/members', { user_id: id, role: 'member' }, 201);
    const shared = (await setup(owner, 'POST', '/workspaces/' + ws + '/channels', { name: 'shared-chat', private: false }, 201)).id;
    const path = '/v1/channels/' + shared, messages = path + '/messages';
    for (const { id } of people.slice(1)) await setup(owner, 'POST', '/channels/' + shared + '/members', { user_id: id }, 201);
    const receiver = await open(observer.person);
    receiver.on('chat.events', (frame, ack) => {
      for (const e of frame.events) pending.get(e.payload?.client_message_id)?.();
      ack();
    });
    await command(receiver, 'channel.subscribe', { channel_id: shared, after: '0' });
    let lastId;
    for (let i = 0; i < 100; i++) {
      lastId = randomUUID();
      const delivered = i === 99 ? receipt(lastId) : undefined;
      await Promise.all([delivered, setup(owner, 'POST', '/channels/' + shared + '/messages',
        { client_message_id: lastId, text: 'Existing conversation ' + i }, 201)]);
    }
    for (const sender of people.slice(0, -1)) sender.socket = await open(sender.person);
    // Each wave starts all senders together on the same populated channel.
    for (let wave = 0; wave < rounds; wave++) {
      const outcomes = await Promise.allSettled(people.slice(0, -1).map(async ({ person, socket }) => {
        const c = (op, ...args) => person.call('Channels', op, ...args);
        const m = (op, ...args) => person.call('Messages', op, ...args);
        const payload = { client_message_id: randomUUID(), text: 'New message ' + wave };
        const delivery = measure('Messages', 'HTTP send to peer', () => receipt(payload.client_message_id));
        const [root] = await Promise.all([m('Send (HTTP)', 'POST', messages, payload, 201), delivery]);
        assert.equal((await m('Retry same send', 'POST', messages, payload, 201)).id, root.id);
        const socketId = randomUUID();
        const socketDelivery = measure('Messages', 'Socket send to peer', () => receipt(socketId));
        await Promise.all([measure('Messages', 'Send (socket ACK)', () => command(socket, 'message.send',
          { channel_id: shared, client_message_id: socketId, text: 'Socket message ' + wave })), socketDelivery]);
        const timeline = await m('Read channel messages', 'GET', messages + '?limit=50');
        assert.equal(timeline.messages.length, 50);
        const source = messages + '/' + root.id;
        assert.equal((await m('Read one message', 'GET', source)).id, root.id);
        const reply = await m('Reply in thread', 'POST', messages, { client_message_id: randomUUID(), text: 'Reply', thread_id: root.thread_id }, 201);
        assert.ok((await m('Read thread', 'GET', '/v1/threads/' + root.thread_id + '/messages')).some(row => row.id === reply.id));
        await m('Edit', 'PATCH', source, { revision: root.reaction_sequence ?? '0', document: { ops: [{ insert: 'Edited' }] } });
        await m('Add reaction', 'POST', source + '/reactions', { emoji: '👍', active: true });
        await m('Remove reaction', 'POST', source + '/reactions', { emoji: '👍', active: false });
        await m('Mark read', 'POST', path + '/read', { sequence: reply.sequence });
        await m('Delete', 'DELETE', source);
        const created = await c('Create', 'POST', channels, { name: 'bench-' + randomUUID().slice(0, 12), private: false }, 201);
        const ch = '/v1/channels/' + created.id;
        await c('List', 'GET', channels);
        await c('Open details', 'GET', path);
        await c('Edit topic', 'PATCH', ch, { topic: 'Updated' });
        await c('Add member', 'POST', ch + '/members', { user_id: observer.id }, 201);
        await c('List members', 'GET', path + '/members');
        await c('Remove member', 'DELETE', ch + '/members/' + observer.id, undefined, 204);
        await observer.person.call('Channels', 'Join', 'POST', ch + '/join', {});
        await c('Archive', 'PATCH', ch, { archived: true });
        await c('Restore', 'PATCH', ch, { archived: false });
      }));
      for (const result of outcomes) {
        if (result.status === 'fulfilled') completed++;
        else failures.push('Wave ' + (wave + 1) + ': ' + result.reason.message);
      }
    }
  } finally { sockets.forEach(s => s.disconnect()); }
  return completed;
}
