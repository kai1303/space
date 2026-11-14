// @vitest-environment node
import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { makeIdentity, recoveryCode } from './crypto.js';
import { deviceState } from './device-storage.js';
import { openDmDraft, sealDmDraft } from './draft-crypto.js';
import { fileManifest } from './encrypted-upload.js';
import { encryptFile } from './file-crypto.js';

it('recovers text and ready file keys on another linked device of the same author only', async () => {
  const viewer = crypto.randomUUID(), channel = crypto.randomUUID();
  const otherViewer = crypto.randomUUID(), otherChannel = crypto.randomUUID();
  const recovery = recoveryCode(), first = await makeIdentity(), second = await makeIdentity();
  await deviceState(viewer, channel, () => ({ identity: first, recovery, linked: true }));
  const file = new File(['only the author knows'], 'private.txt', { type: 'text/plain' });
  const { secret } = await encryptFile(file);
  const encryptedFile = { ...secret, id: crypto.randomUUID() };
  const attached = { ...encryptedFile, encryptedFile, description: 'private description', file, status: 'ready' as const };
  const document = { ops: [{ insert: 'private words', attributes: { bold: true } }] };
  const saved = await sealDmDraft(viewer, channel, document, [attached, { ...attached, status: 'uploading' }]);
  expect(Object.keys(saved)).toEqual(['ciphertext', 'asset_ids']);
  expect(saved.asset_ids).toEqual([attached.id]);
  const raw = atob(saved.ciphertext);
  for (const value of [document.ops[0]!.insert, file.name, attached.description, attached.id, secret.key])
    expect(raw).not.toContain(value);
  expect((await sealDmDraft(viewer, channel, document, [attached])).ciphertext).not.toBe(saved.ciphertext);
  await deviceState(viewer, channel, () => ({ identity: second, recovery, linked: true }));
  const restored = await openDmDraft(viewer, channel, saved.ciphertext, saved.asset_ids);
  await expect(openDmDraft(viewer, channel, saved.ciphertext, [crypto.randomUUID()])).rejects.toThrow('identity mismatch');
  expect(restored.document).toEqual(document);
  expect(restored.attachments).toHaveLength(1);
  expect(restored.attachments[0]).not.toHaveProperty('file');
  expect(fileManifest(restored.attachments)).toEqual([{ ...encryptedFile, description: attached.description }]);
  expect(fileManifest(restored.attachments.map(item => ({ ...item, description: '' })))).toEqual([encryptedFile]);
  const onlyFile = await sealDmDraft(viewer, channel, { ops: [] }, restored.attachments);
  expect(await openDmDraft(viewer, channel, onlyFile.ciphertext)).toMatchObject({ document: { ops: [] } });
  for (const [actor, room] of [[otherViewer, channel], [viewer, otherChannel]] as const) {
    await deviceState(actor, room, () => ({ identity: second, recovery, linked: true }));
    await expect(openDmDraft(actor, room, saved.ciphertext)).rejects.toThrow();
  }
  const tampered = btoa(raw.slice(0, -1) + String.fromCharCode(raw.charCodeAt(raw.length - 1) ^ 1));
  await expect(openDmDraft(viewer, channel, tampered)).rejects.toThrow();
  await deviceState(viewer, channel, () => ({ identity: second, recovery: recoveryCode(), linked: true }));
  await expect(openDmDraft(viewer, channel, saved.ciphertext)).rejects.toThrow();
  const trust = {
    code: '', devices: [first.id], keys: { [first.id]: first.publicKey }, owners: { [first.id]: viewer },
  };
  await deviceState(viewer, channel, () => ({ identity: first, recovery, trust }));
  expect((await openDmDraft(viewer, channel, saved.ciphertext)).document).toEqual(document);
  await deviceState(viewer, channel, () => ({ identity: second, recovery, linked: false }));
  await expect(sealDmDraft(viewer, channel, document, [])).rejects.toThrow('Link this device');
  await expect(openDmDraft(viewer, channel, saved.ciphertext)).rejects.toThrow('Link this device');
  await expect(openDmDraft(viewer, crypto.randomUUID(), saved.ciphertext)).rejects.toThrow('Link this device');
});
