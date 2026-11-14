import assert from 'node:assert/strict';

export async function huddles({call, ws, channel, peer, peerId, media}) {
  const op = call('Huddles'), invited = call('Huddles', peer);
  const room = '/channels/' + channel + '/huddle', directory = '/workspaces/' + ws + '/huddles';
  const {huddle, token} = await op('Join channel huddle', 'POST', room + '/join', {});
  try {
    assert.ok(token && huddle.id);
    const path = '/huddles/' + huddle.id;
    assert.equal((await op('Current huddle', 'GET', room)).id, huddle.id);
    await op('Active workspace huddles', 'GET', directory);
    await op('Workspace huddle directory', 'GET', directory + '/directory');
    await op('Find invitees', 'GET', path + '/people');
    await op('Invite member', 'POST', path + '/invite', {user_id: peerId});
    const invitations = await invited('Huddle invitations', 'GET', '/huddles/invitations');
    assert.ok(invitations.some(item => item.id === huddle.id));
    await invited('Dismiss invitation', 'POST', '/huddles/invitations/' + huddle.id + '/dismiss', {});
  } finally { await media.remove(huddle.id); }
}
