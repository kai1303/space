import { parseEncryptedFiles, type EncryptedFile } from './file-crypto.js';
import {
  parseRichDocument,
  parseEncryptedDm,
  type DmDevice,
  type EncryptedDm,
  type RichDocument,
} from '@space/contracts';
import {
  createMessage,
  decrypt,
  decryptKey,
  encrypt,
  generateKey,
  readKey,
  readMessage,
  readPrivateKey,
} from 'openpgp';

export type DeviceIdentity = {
  id: string;
  publicKey: string;
  privateKey: string;
  wrappingKey: CryptoKey;
  wrappedPassword: ArrayBuffer;
  iv: Uint8Array<ArrayBuffer>;
};
const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (n) => n.toString(16).padStart(2, '0')).join('');
export const recoveryCode = () => hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
export async function enrollmentProof(code: string) {
  if (!/^[a-f0-9]{64}$/.test(code)) throw Error('Enter the 64-character device linking code.');
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode('Space DM enrollment v1 ' + code)));
}
// The server sees an enrollment verifier, never the linking secret used to authenticate a device.
export async function authorizeDevice(
  code: string,
  channel: string,
  actor: string,
  id: string,
  publicKey: string,
) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(code),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(
    await crypto.subtle.sign(
      'HMAC',
      key,
      encoder.encode(JSON.stringify(['space-dm-device-v1', channel, actor, id, publicKey])),
    ),
  );
}
export async function verifiedRosterCode(
  channel: string,
  actor: string,
  participants: string[],
  local: { recovery: string; identity: DeviceIdentity },
  devices: DmDevice[],
) {
  const live = devices.filter((d) => !d.revoked);
  if (
    !live.some(
      (d) => d.user_id === actor && d.id === local.identity.id && d.public_key === local.identity.publicKey,
    ) ||
    participants.some((p) => !live.some((d) => d.user_id === p)) ||
    live.some((d) => !participants.includes(d.user_id))
  )
    throw Error('Unexpected participant or missing device.');
  for (const d of live.filter((d) => d.user_id === actor)) {
    if (d.authorization !== (await authorizeDevice(local.recovery, channel, actor, d.id, d.public_key)))
      throw Error('An unrecognized device was added to your account.');
  }
  return verificationCode(channel, devices);
}
export async function makeIdentity(): Promise<DeviceIdentity> {
  const id = crypto.randomUUID(),
    password = recoveryCode();
  const { privateKey, publicKey } = await generateKey({
    type: 'curve25519',
    config: { v6Keys: true },
    userIDs: [{ name: id }],
    passphrase: password,
  });
  const wrappingKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrappedPassword = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    wrappingKey,
    encoder.encode(password),
  );
  return { id, privateKey, publicKey, wrappingKey, iv, wrappedPassword };
}
const unlockedKeys = new WeakMap<DeviceIdentity, ReturnType<typeof unlock>>();
function unlocked(identity: DeviceIdentity) {
  const cached = unlockedKeys.get(identity);
  if (cached) return cached;
  const pending = unlock(identity).catch((error) => {
    unlockedKeys.delete(identity);
    throw error;
  });
  unlockedKeys.set(identity, pending);
  return pending;
}
async function unlock(identity: DeviceIdentity) {
  const bytes = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: identity.iv },
    identity.wrappingKey,
    identity.wrappedPassword,
  );
  return decryptKey({
    privateKey: await readPrivateKey({ armoredKey: identity.privateKey }),
    passphrase: new TextDecoder().decode(bytes),
  });
}
export type Trust = {
  code: string;
  devices: string[];
  keys: Record<string, string>;
  owners: Record<string, string>;
};
export async function verificationCode(channel: string, devices: DmDevice[]) {
  const rows = await Promise.all(
    devices
      .filter((d) => !d.revoked)
      .map(async (d) => [d.user_id, d.id, (await readKey({ armoredKey: d.public_key })).getFingerprint()]),
  );
  rows.sort((a, b) => (a[1]! < b[1]! ? -1 : a[1] === b[1] ? 0 : 1));
  return hex(
    await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(['space-dm-v1', channel, rows]))),
  );
}
export async function trustRoster(channel: string, devices: DmDevice[], prior?: Trust): Promise<Trust> {
  const keys = { ...prior?.keys },
    owners = { ...prior?.owners };
  for (const d of devices.filter((d) => !d.revoked)) {
    if (keys[d.id] && (keys[d.id] !== d.public_key || owners[d.id] !== d.user_id))
      throw Error('A device identity changed. Revoke it and enroll a new device.');
    keys[d.id] = d.public_key;
    owners[d.id] = d.user_id;
  }
  return {
    code: await verificationCode(channel, devices),
    devices: devices.filter((d) => !d.revoked).map((d) => d.id),
    keys,
    owners,
  };
}
export async function seal(
  identity: DeviceIdentity,
  trust: Trust,
  devices: DmDevice[],
  channel: string,
  actor: string,
  id: string,
  document: RichDocument,
  files: EncryptedFile[] = [],
): Promise<EncryptedDm> {
  const live = devices.filter((d) => !d.revoked);
  if (
    !live.some((d) => d.id === identity.id && d.user_id === actor && d.public_key === identity.publicKey) ||
    trust.code !== (await verificationCode(channel, live))
  )
    throw Error('Verify the device list in conversation details before sending.');
  const recipients = live.map((d) => d.id).sort();
  const payload = {
    version: 1,
    channel,
    actor,
    id,
    sender: identity.id,
    recipients,
    document: parseRichDocument(document),
    ...(files.length ? { files: parseEncryptedFiles(files) } : {}),
  };
  const bytes = await encrypt({
    message: await createMessage({ text: JSON.stringify(payload) }),
    encryptionKeys: await Promise.all(live.map((d) => readKey({ armoredKey: trust.keys[d.id]! }))),
    signingKeys: await unlocked(identity),
    format: 'binary',
  });
  if (!(bytes instanceof Uint8Array)) throw Error('Unexpected encryption output.');
  return parseEncryptedDm({
    version: 1,
    sender: identity.id,
    recipients,
    ...(files.length ? { asset_ids: files.map((file) => file.id) } : {}),
    ciphertext: btoa(Array.from(bytes, (n) => String.fromCharCode(n)).join('')),
  });
}
export async function unsealContent(
  identity: DeviceIdentity,
  trust: Trust,
  devices: DmDevice[],
  channel: string,
  actor: string,
  id: string,
  encrypted: EncryptedDm,
): Promise<{ document: RichDocument; files: EncryptedFile[] }> {
  const envelope = parseEncryptedDm(encrypted);
  const sender = devices.find((d) => d.id === envelope.sender && d.user_id === actor);
  if (
    !sender ||
    trust.owners[sender.id] !== actor ||
    trust.keys[sender.id] !== sender.public_key ||
    !envelope.recipients.includes(identity.id)
  )
    throw Error('Message unavailable on this device.');
  const message = await readMessage({
    binaryMessage: Uint8Array.from(atob(envelope.ciphertext), (ch) => ch.charCodeAt(0)),
  });
  const result = await decrypt({
    message,
    decryptionKeys: await unlocked(identity),
    verificationKeys: await readKey({ armoredKey: sender.public_key }),
    expectSigned: true,
    config: { maxDecompressedMessageSize: 65536 },
  });
  const data = JSON.parse(result.data);
  if (
    data.version !== 1 ||
    data.channel !== channel ||
    data.actor !== actor ||
    data.id !== id ||
    data.sender !== sender.id ||
    JSON.stringify(data.recipients) !== JSON.stringify(envelope.recipients)
  )
    throw Error('Message identity mismatch.');
  const files = parseEncryptedFiles(data.files ?? []);
  if (JSON.stringify(files.map((file) => file.id)) !== JSON.stringify(envelope.asset_ids ?? []))
    throw Error('Attachment identity mismatch.');
  return { document: parseRichDocument(data.document), files };
}

export async function unseal(...args: Parameters<typeof unsealContent>): Promise<RichDocument> {
  return (await unsealContent(...args)).document;
}
