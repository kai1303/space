import { randomUUID } from 'node:crypto';
import { record, webVaultItem, webVaultResult, type WebVaultItem, type WebVaultResult } from '@space/contracts';
import type { WebVaultHandler } from './runtime.js';

// Each continuation belongs to one approved list on this connector connection.
// Keep Socket.IO frames below 128 KiB even for long titles and origins.
const pageSize = 24;
export function webVaultPages(handler: WebVaultHandler) {
  let snapshot: {actor: string; installation: string; cursor: string; items: WebVaultItem[]; offset: number} | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  function clear() {
    clearTimeout(deadline);
    snapshot = undefined;
  }
  function next(): WebVaultResult {
    const list = snapshot!;
    const items = list.items.slice(list.offset, list.offset + pageSize);
    list.offset += items.length;
    if (list.offset === list.items.length) {
      clear();
      return {status: 'listed', items, more: false};
    }
    list.cursor = randomUUID();
    clearTimeout(deadline);
    deadline = setTimeout(clear, 65_000);
    deadline.unref();
    return {status: 'listed', items, more: true, cursor: list.cursor};
  }
  const dispatch: WebVaultHandler = async (request, signal) => {
    if (request.cursor) {
      if (request.action !== 'list' || !snapshot || snapshot.cursor !== request.cursor ||
          snapshot.actor !== request.actor || snapshot.installation !== request.installation) return {status: 'unavailable'};
      return next();
    }
    clear();
    const result = await handler(request, signal);
    if (signal.aborted) return {status: 'unavailable'};
    const response = record(result, ['status', 'items', 'more']);
    if (response.status !== 'listed' || request.action !== 'list' || !Array.isArray(response.items) ||
        response.more !== false || response.items.length <= pageSize) return webVaultResult(response, request.action);
    const items = response.items.map(webVaultItem);
    snapshot = {actor: request.actor, installation: request.installation, items, offset: 0, cursor: ''};
    return next();
  };
  return {dispatch, clear};
}
