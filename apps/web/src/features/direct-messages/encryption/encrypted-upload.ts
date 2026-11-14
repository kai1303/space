import { fileTransfers } from './file-transfers.js';
import type { Attachment } from '@space/ui/rich-text';
import { uploadAsset } from '../../files/assets.js';
import { encryptFile, type EncryptedFile } from './file-crypto.js';

const upload = fileTransfers();
export function encryptedTransfer(actor: string): typeof uploadAsset {
  return (channel, file, progress, signal) =>
    upload(signal, async () => {
      const { blob, secret } = await encryptFile(file);
      const asset = await uploadAsset(channel, blob, progress, signal, true, actor);
      // Only the encrypted message or the author's encrypted draft may carry this descriptor.
      return {
        id: asset.id,
        name: file.name,
        size: file.size,
        type: file.type,
        encryptedFile: { ...secret, id: asset.id },
      };
    });
}
export function fileManifest(files: Attachment[]): EncryptedFile[] {
  return files.map((file) => {
    if (!('encryptedFile' in file) || (file.encryptedFile as EncryptedFile | undefined)?.id !== file.id)
      throw Error('Reattach this file to encrypt it.');
    const { description: _oldDescription, ...manifest } = file.encryptedFile as EncryptedFile;
    return {
      ...manifest,
      ...(file.description ? { description: file.description } : {}),
    };
  });
}
