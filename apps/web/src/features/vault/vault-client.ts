import {CompactEncrypt, compactDecrypt, exportSPKI, generateKeyPair, importSPKI} from 'jose';
import type {VaultChange, VaultChangeResult, VaultItemDetails, VaultPage, WebVaultResult} from '@space/contracts';
import {request} from '../../shared/api/request.js';

export async function vaultItemRequest(actor:string, mac:string, signal:AbortSignal, change?:VaultChange): Promise<VaultPage | VaultChangeResult> {
  if (mac === 'local') return await window.spaceDesktop?.vaultItemRequest?.(actor, change) ?? {status:'unavailable'};
  const send = (body:object) => request<WebVaultResult>('/me/vault/macs/' + mac + '/request', body, undefined, 'POST', signal, actor);
  const {privateKey, publicKey} = await generateKeyPair('ECDH-ES', {crv:'P-256'});
  const recipient = await exportSPKI(publicKey);
  async function receive(response:WebVaultResult): Promise<VaultPage | VaultChangeResult> {
    if (response.status === 'cancelled' || response.status === 'busy') return {status:response.status};
    if (response.status !== 'encrypted') return {status:'unavailable'};
    const {plaintext} = await compactDecrypt(response.sealed, privateKey, {
      keyManagementAlgorithms:['ECDH-ES'], contentEncryptionAlgorithms:['A256GCM'],
    });
    return JSON.parse(new TextDecoder().decode(plaintext));
  }
  if (change) {
    const ready = await send({action:'prepare-item'});
    if (ready.status !== 'ready') return {status: ready.status === 'busy' ? 'busy' : 'unavailable'};
    const key = await importSPKI(ready.publicKey, 'ECDH-ES');
    const sealed = await new CompactEncrypt(new TextEncoder().encode(JSON.stringify({change, publicKey:recipient})))
      .setProtectedHeader({alg:'ECDH-ES', enc:'A256GCM', kid:ready.transfer}).encrypt(key);
    signal.throwIfAborted();
    return receive(await send({action:'change-item', transfer:ready.transfer, sealed}));
  }
  let cursor: string | undefined;
  const seen = new Set<string>(), items:VaultItemDetails[] = [];
  let bytes = 0;
  do {
    const response = await send({action:'list-items', publicKey:recipient, ...(cursor ? {cursor} : {})});
    const page = await receive(response);
    if (page.status !== 'listed') return page;
    bytes += new TextEncoder().encode(JSON.stringify(page.items)).length;
    if (bytes > 8 * 1024 * 1024 || page.more !== Boolean(page.cursor)) throw new Error('invalid_vault_page');
    items.push(...page.items);
    cursor = page.cursor;
    if (cursor && seen.has(cursor)) throw new Error('invalid_vault_page');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return {status:'listed', items, more:false};
}
