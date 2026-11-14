import { CompactEncrypt, compactDecrypt, exportSPKI, generateKeyPair, importSPKI } from 'jose';
import { randomUUID } from 'node:crypto';
import { text, record, parseVaultChange, webVaultItem, webVaultResult, type WebVaultItem, type WebVaultResult } from '@space/contracts';
import type { WebVaultHandler } from './runtime.js';

// Each continuation belongs to one approved list on this connector connection.
// Keep Socket.IO frames below 128 KiB even for long titles and origins.
const pageSize = 24;
export function webVaultPages(handler: WebVaultHandler) {
  let snapshot: {actor: string; installation: string; cursor: string; items: WebVaultItem[]; offset: number; publicKey?:string} | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let transfer: {id: string; actor: string; installation: string; key: CryptoKey; action:string; until: number} | undefined;
  let transferDeadline: ReturnType<typeof setTimeout> | undefined;
  function forgetTransfer() {
    clearTimeout(transferDeadline);
    transfer = undefined;
  }
  function clear() {
    forgetTransfer();
    clearTimeout(deadline);
    snapshot = undefined;
  }
  async function encryptReply(result: unknown, publicKey: string, cursor?: string): Promise<WebVaultResult> {
    const key = await importSPKI(publicKey, 'ECDH-ES');
    const sealed = await new CompactEncrypt(new TextEncoder().encode(JSON.stringify(result)))
      .setProtectedHeader({alg:'ECDH-ES', enc:'A256GCM'}).encrypt(key);
    return {status:'encrypted', sealed, ...(cursor ? {cursor} : {})};
  }
  async function next(): Promise<WebVaultResult> {
    const list = snapshot!;
    const items = list.items.slice(list.offset, list.offset + (list.publicKey ? 8 : pageSize));
    list.offset += items.length;
    const more = list.offset < list.items.length;
    if (more) {
      list.cursor = randomUUID();
      clearTimeout(deadline);
      deadline = setTimeout(clear, 65_000);
      deadline.unref();
    } else clear();
    const result = {status:'listed' as const, items, more, ...(more ? {cursor:list.cursor} : {})};
    return list.publicKey ? encryptReply(result, list.publicKey, result.cursor) : result;
  }
  const dispatch: WebVaultHandler = async (request, signal) => {
    if (request.action === 'prepare-linear' || request.action === 'prepare-item') {
      const {privateKey, publicKey} = await generateKeyPair('ECDH-ES', {crv:'P-256'});
      const publicPem = await exportSPKI(publicKey);
      if (signal.aborted) return {status:'unavailable'};
      forgetTransfer();
      transfer = {id:randomUUID(), actor:request.actor, installation:request.installation, key:privateKey, action:request.action, until:Date.now() + 60000};
      transferDeadline = setTimeout(forgetTransfer, 60000);
      transferDeadline.unref();
      return {status:'ready', transfer:transfer.id, publicKey:publicPem};
    }
    if (request.action === 'save-linear' || request.action === 'change-item') {
      const pending = transfer;
      if (!pending || pending.action !== (request.action === 'change-item' ? 'prepare-item' : 'prepare-linear') || !request.sealed || pending.id !== request.transfer || pending.actor !== request.actor ||
          pending.installation !== request.installation || pending.until <= Date.now() || signal.aborted) return {status:'unavailable'};
      forgetTransfer();
      try {
        const {plaintext, protectedHeader} = await compactDecrypt(request.sealed, pending.key, {
          keyManagementAlgorithms:['ECDH-ES'], contentEncryptionAlgorithms:['A256GCM'],
        });
        if (protectedHeader.kid !== pending.id || signal.aborted) return {status:'unavailable'};
        const decoded = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(plaintext));
        if (request.action === 'change-item') {
          const payload = record(decoded, ['change','publicKey']);
          const publicKey = text(payload.publicKey, 256);
          await importSPKI(publicKey, 'ECDH-ES');
          const change = parseVaultChange(payload.change);
          const response = await handler({...request, sealed:undefined, change}, signal);
          return signal.aborted ? {status:'unavailable'} : encryptReply(response, publicKey);
        }
        const {title, token} = record(decoded, ['title','token']);
        if (typeof title !== 'string' || !title.trim() || title.length > 100 || typeof token !== 'string' ||
            !token.trim() || Buffer.byteLength(token) > 4096) return {status:'unavailable'};
        const response = await handler({...request, sealed:undefined, title:title.trim(), token}, signal);
        return signal.aborted ? {status:'unavailable'} : webVaultResult(response, request.action);
      } catch { return {status:'unavailable'}; }
    }
    if (request.cursor) {
      if ((request.action !== 'list' && request.action !== 'list-items') || !snapshot || snapshot.publicKey !== request.publicKey || snapshot.cursor !== request.cursor ||
          snapshot.actor !== request.actor || snapshot.installation !== request.installation) return {status: 'unavailable'};
      return next();
    }
    clear();
    const result = await handler(request, signal);
    if (signal.aborted) return {status: 'unavailable'};
    const response = record(result, ['status', 'items', 'more']);
    if (request.action === 'list-items' && response.status === 'listed' && Array.isArray(response.items) && request.publicKey) {
      snapshot = {actor:request.actor, installation:request.installation, items:response.items, offset:0, cursor:'', publicKey:request.publicKey};
      return next();
    }
    if (response.status !== 'listed' || request.action !== 'list' || !Array.isArray(response.items) ||
        response.more !== false || response.items.length <= pageSize) return webVaultResult(response, request.action);
    const items = response.items.map(webVaultItem);
    snapshot = {actor: request.actor, installation: request.installation, items, offset: 0, cursor: ''};
    return next();
  };
  return {dispatch, clear};
}
