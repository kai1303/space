// @vitest-environment node
import { encryptFile } from './file-crypto.js';
import { expect, it } from 'vitest';
import {
  makeIdentity,
  seal,
  trustRoster,
  unseal,
  unsealContent,
  authorizeDevice,
  recoveryCode,
  verifiedRosterCode,
} from './crypto.js';

it('binds signed rich text to a conversation, sender, device roster and message identity', async () => {
  const alice = await makeIdentity(),
    bob = await makeIdentity(),
    newDevice = await makeIdentity();
  const recovery = recoveryCode();
  const devices = [
    {
      id: alice.id,
      user_id: 'alice',
      public_key: alice.publicKey,
      authorization: await authorizeDevice(recovery, 'room', 'alice', alice.id, alice.publicKey),
      revoked: false,
    },
    {
      id: bob.id,
      user_id: 'bob',
      public_key: bob.publicKey,
      authorization: 'other',
      revoked: false,
    },
  ];
  const trust = await trustRoster('room', devices),
    doc = { ops: [{ insert: 'Private content', attributes: { bold: true } }] },
    id = crypto.randomUUID();
  const wire = await seal(alice, trust, devices, 'room', 'alice', id, doc);
  const { secret } = await encryptFile(new File(['secret bytes'], 'secret.txt', { type: 'text/plain' }));
  const file = {
    ...secret,
    id: crypto.randomUUID(),
    description: 'Private description',
  };
  const attached = await seal(alice, trust, devices, 'room', 'alice', id, doc, [file]);
  expect(JSON.stringify(attached)).not.toContain('secret.txt');
  expect(JSON.stringify(attached)).not.toContain(secret.key);
  expect((await unsealContent(bob, trust, devices, 'room', 'alice', id, attached)).files).toEqual([file]);
  await expect(
    unsealContent(bob, trust, devices, 'room', 'alice', id, {
      ...attached,
      asset_ids: [crypto.randomUUID()],
    }),
  ).rejects.toThrow(/Attachment identity/);
  await expect(
    unsealContent(bob, trust, devices, 'room', 'alice', id, {
      ...attached,
      asset_ids: [],
    }),
  ).rejects.toThrow(/Attachment identity/);

  expect(
    await verifiedRosterCode('room', 'alice', ['alice', 'bob'], { identity: alice, recovery }, devices),
  ).toBe(trust.code);
  await expect(
    verifiedRosterCode('room', 'alice', ['alice', 'bob'], { identity: alice, recovery }, [
      ...devices,
      { ...devices[0]!, id: newDevice.id, public_key: newDevice.publicKey },
    ]),
  ).rejects.toThrow(/unrecognized/);
  expect(await unseal(bob, trust, devices, 'room', 'alice', id, wire)).toEqual(doc);
  for (const [room, user, messageId] of [
    ['other', 'alice', id],
    ['room', 'bob', id],
    ['room', 'alice', crypto.randomUUID()],
  ] as const) {
    await expect(unseal(bob, trust, devices, room, user, messageId, wire)).rejects.toThrow();
  }
  await expect(unseal(newDevice, trust, devices, 'room', 'alice', id, wire)).rejects.toThrow();
  const altered = {
    ...wire,
    ciphertext: wire.ciphertext.slice(0, -12) + 'AAAAAAAAAAAA',
  };
  await expect(unseal(bob, trust, devices, 'room', 'alice', id, altered)).rejects.toThrow();
  const changed = [
    ...devices,
    {
      id: newDevice.id,
      user_id: 'bob',
      public_key: newDevice.publicKey,
      authorization: 'unverified',
      revoked: false,
    },
  ];
  await expect(seal(alice, trust, changed, 'room', 'alice', id, doc)).rejects.toThrow(/Verify/);
  const verified = await trustRoster('room', changed, trust);
  expect(verified.code).not.toBe(trust.code);
  const next = await seal(alice, verified, changed, 'room', 'alice', id, doc);
  expect(await unseal(newDevice, verified, changed, 'room', 'alice', id, next)).toEqual(doc);
});
