import { parseComposerDraftCiphertext, parseRichDocument, record, type RichDocument } from '@space/contracts';
import type { Attachment } from '@space/ui/rich-text';
import { deviceState } from './device-storage.js';
import { fileManifest } from './encrypted-upload.js';
import { parseEncryptedFiles } from './file-crypto.js';

export const DM_DRAFT_KEY_AVAILABLE = 'space:dm-draft-key-available';
const encoder = new TextEncoder();

async function draftKey(viewer: string, channel: string) {
  const local = await deviceState(viewer, channel);
  // Previously enrolled devices already pinned their own identity when verifying this conversation.
  const linked = local?.linked ?? (local && local.trust?.keys[local.identity.id] === local.identity.publicKey &&
    local.trust?.owners[local.identity.id] === viewer);
  if (!local || !linked || !/^[a-f0-9]{64}$/.test(local.recovery))
    throw Error('Link this device in conversation details to open or save your encrypted draft.');
  const secret = await crypto.subtle.importKey('raw', encoder.encode(local.recovery), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: encoder.encode('Space private DM draft v1'),
    info: encoder.encode(JSON.stringify([viewer, channel])),
  }, secret, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

function draftDocument(value: unknown): RichDocument {
  const doc = record(value, ['ops']);
  return Array.isArray(doc.ops) && doc.ops.length === 0 ? { ops: [] } : parseRichDocument(doc);
}

export async function sealDmDraft(viewer: string, channel: string, document: RichDocument, attachments: Attachment[]) {
  const ready = attachments.filter(file => file.status === 'ready' || !file.status);
  const payload = { document: draftDocument(document), files: parseEncryptedFiles(fileManifest(ready)) };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await draftKey(viewer, channel),
    encoder.encode(JSON.stringify(payload)));
  const packed = new Uint8Array(1 + iv.length + encrypted.byteLength);
  packed[0] = 1;
  packed.set(iv, 1);
  packed.set(new Uint8Array(encrypted), 13);
  const ciphertext = btoa(Array.from(packed, byte => String.fromCharCode(byte)).join(''));
  return {
    ciphertext: parseComposerDraftCiphertext(ciphertext),
    ...(payload.files.length ? { asset_ids: payload.files.map(file => file.id) } : {}),
  };
}

export async function openDmDraft(viewer: string, channel: string, ciphertext: string, assetIds?: string[]):
  Promise<{ document: RichDocument; attachments: Attachment[] }> {
  const packed = Uint8Array.from(atob(parseComposerDraftCiphertext(ciphertext)), ch => ch.charCodeAt(0));
  if (packed[0] !== 1) throw Error('Unsupported encrypted draft version.');
  const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: packed.subarray(1, 13) },
    await draftKey(viewer, channel), packed.subarray(13));
  const payload = record(JSON.parse(new TextDecoder().decode(clear)), ['document', 'files']);
  const files = parseEncryptedFiles(payload.files);
  if (assetIds && JSON.stringify(files.map(file => file.id)) !== JSON.stringify(assetIds))
    throw Error('Encrypted draft attachment identity mismatch.');
  return {
    document: draftDocument(payload.document),
    attachments: files.map(({ description, ...encryptedFile }) => ({
      id: encryptedFile.id, name: encryptedFile.name, size: encryptedFile.size, type: encryptedFile.type,
      ...(description ? { description } : {}), status: 'ready', encryptedFile,
    })),
  };
}
