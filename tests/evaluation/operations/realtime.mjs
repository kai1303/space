import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';

export async function realtime(ctx, owner, peer, workspace, channel) {
  const sockets = [];
  async function open(person) {
    const socket = io(ctx.address, { transports: ['websocket'], reconnection: false, autoConnect: false,
      extraHeaders: { origin: ctx.origin, cookie: person.cookie } });
    sockets.push(socket);
    await ctx.measure('Authentication', 'Socket connect', () => new Promise((resolve, reject) => {
      socket.once('connect', resolve).once('connect_error', reject).connect();
    }));
    for (const event of ['workspace.unread', 'updates.changed', 'chat.events']) socket.on(event, (_frame, ack) => ack());
    return socket;
  }
  const ack = (socket, area, name, data) => ctx.measure(area, 'Socket ' + name, async () => {
    const result = await socket.timeout(5000).emitWithAck(name, data);
    assert.ok(result.data, name + ' ' + result.error);
    return result.data;
  });
  try {
    const sender = await open(owner), recipient = await open(peer);
    const ch = { channel_id: channel }, ws = { workspace_id: workspace }, view = { scope: 'channel', id: channel };
    await ack(sender, 'Workspace', 'workspace.subscribe', ws);
    await ack(sender, 'Workspace', 'updates.subscribe', view);
    for (const socket of sockets) await ack(socket, 'Channels', 'channel.subscribe', { ...ch, after: '0' });
    await ack(sender, 'Messages', 'typing.change', { ...ch, active: true });
    const id = randomUUID();
    await ctx.measure('Messages', 'Send to peer delivery', async () => {
      const arrived = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Peer delivery timed out')), 8000);
        recipient.on('chat.events', frame => {
          if (frame.events.some(event => event.payload?.client_message_id === id)) { clearTimeout(timer); resolve(); }
        });
      });
      await Promise.all([arrived, ack(sender, 'Messages', 'message.send', { ...ch, client_message_id: id, text: 'Socket message' })]);
    });
    await ack(sender, 'Channels', 'channel.unsubscribe', ch);
    await ack(sender, 'Workspace', 'updates.unsubscribe', view);
    await ack(sender, 'Workspace', 'workspace.unsubscribe', ws);
  } finally { for (const socket of sockets) socket.disconnect(); }
}
