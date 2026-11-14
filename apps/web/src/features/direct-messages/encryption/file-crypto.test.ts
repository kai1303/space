// @vitest-environment node
import { expect, it } from 'vitest';
import { encryptFile, decryptFile } from './file-crypto.js';

it('keeps names and bytes out of storage and authenticates ciphertext before opening', async () => {
  const original = new File(['confidential data'], 'payroll.txt', {
    type: 'text/plain',
  });
  const { blob, secret } = await encryptFile(original);
  expect(blob.name).not.toBe(original.name);
  expect(blob.type).toBe('application/octet-stream');
  expect(blob.size).toBe(original.size);
  expect(await blob.text()).not.toBe('confidential data');
  expect(await (await decryptFile(await blob.arrayBuffer(), secret)).text()).toBe('confidential data');
  const swapped = await encryptFile(original);
  await expect(decryptFile(await swapped.blob.arrayBuffer(), secret)).rejects.toThrow();
  const changed = new Uint8Array(await blob.arrayBuffer());
  changed[0] = changed[0]! ^ 1;
  await expect(decryptFile(changed.buffer, secret)).rejects.toThrow();
});
