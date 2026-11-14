import { parseAssetIds } from './assets.js';
import { AppError, record, text, uuid } from './validation.js';

export const encryptedMessageLabel = 'Encrypted message';
export interface DmDevice {
  id: string;
  user_id: string;
  public_key: string;
  authorization: string;
  revoked: boolean;
}
export interface DmEncryption {
  enabled: boolean;
  devices: DmDevice[];
}
export interface EncryptedDm {
  version: 1;
  sender: string;
  recipients: string[];
  ciphertext: string;
  asset_ids?: string[];
}

export function parseEncryptedDm(raw: unknown): EncryptedDm {
  const v = record(raw, ['version', 'sender', 'recipients', 'ciphertext', 'asset_ids']);
  if (v.version !== 1 || !Array.isArray(v.recipients) || !v.recipients.length || v.recipients.length > 16)
    throw new AppError(400, 'invalid_envelope');
  const recipients = v.recipients.map(uuid).sort(),
    sender = uuid(v.sender),
    ciphertext = text(v.ciphertext, 80000);
  if (
    !recipients.includes(sender) ||
    new Set(recipients).size !== recipients.length ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(ciphertext) ||
    ciphertext.length % 4 !== 0
  )
    throw new AppError(400, 'invalid_envelope');
  return { version: 1, sender, recipients, ciphertext, ...(v.asset_ids === undefined ? {} : { asset_ids: parseAssetIds(v.asset_ids) }) };
}
