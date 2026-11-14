import {
  MAX_ASSET_BYTES,
  MAX_MESSAGE_ASSETS,
  parseAssetInput,
  parseAssetIds,
  record,
} from '@space/contracts';

export type FileSecret = {
  name: string;
  type: string;
  size: number;
  key: string;
  iv: string;
  tag: string;
};
export type EncryptedFile = FileSecret & { id: string; description?: string };
const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
const bytes = (value: string) => Uint8Array.from(value.match(/../g)!, (pair) => parseInt(pair, 16));
export function parseEncryptedFiles(input: unknown): EncryptedFile[] {
  if (!Array.isArray(input) || input.length > MAX_MESSAGE_ASSETS)
    throw Error('Invalid encrypted attachments.');
  const files = input.map((raw) => {
    const v = record(raw, ['id', 'name', 'type', 'size', 'key', 'iv', 'tag', 'description']);
    for (const [field, length] of [
      ['key', 64],
      ['iv', 24],
      ['tag', 32],
    ] as const)
      if (typeof v[field] !== 'string' || v[field].length !== length || !/^[0-9a-f]+$/.test(v[field]))
        throw Error('Invalid file key.');
    if (
      v.description !== undefined &&
      (typeof v.description !== 'string' || v.description.length > 1000 || v.description.includes('\0'))
    )
      throw Error('Invalid file description.');
    return {
      id: v.id as string,
      ...parseAssetInput({ name: v.name, size: v.size, type: v.type }),
      key: v.key as string,
      iv: v.iv as string,
      tag: v.tag as string,
      ...(v.description ? { description: v.description as string } : {}),
    };
  });
  parseAssetIds(files.map((file) => file.id));
  return files;
}
export async function encryptFile(file: File): Promise<{ blob: File; secret: FileSecret }> {
  const metadata = parseAssetInput({
    name: file.name,
    size: file.size,
    type: file.type,
  });
  const key = crypto.getRandomValues(new Uint8Array(32)),
    iv = crypto.getRandomValues(new Uint8Array(12));
  const imported = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, imported, await file.arrayBuffer()),
  );
  // Carry the authentication tag inside the signed message. Stored bytes retain the existing upload size limit.
  return {
    blob: new File([encrypted.subarray(0, -16)], 'Encrypted file', {
      type: 'application/octet-stream',
    }),
    secret: {
      ...metadata,
      key: hex(key),
      iv: hex(iv),
      tag: hex(encrypted.subarray(-16)),
    },
  };
}
export async function decryptFile(ciphertext: ArrayBuffer, secret: FileSecret): Promise<Blob> {
  if (ciphertext.byteLength !== secret.size || ciphertext.byteLength > MAX_ASSET_BYTES)
    throw Error('File size mismatch.');
  const key = await crypto.subtle.importKey('raw', bytes(secret.key), 'AES-GCM', false, ['decrypt']);
  const authenticated = new Uint8Array(ciphertext.byteLength + 16);
  authenticated.set(new Uint8Array(ciphertext));
  authenticated.set(bytes(secret.tag), ciphertext.byteLength);
  const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(secret.iv) }, key, authenticated);
  return new Blob([clear], { type: secret.type });
}
