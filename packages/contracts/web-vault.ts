import { AppError, record, text, uuid } from './validation.js';

export type WebVaultAction = 'list' | 'manage';
export interface VaultMac { id: string; name: string; online: boolean }
export interface WebVaultItem { title: string; site: string; kind: 'login' | 'token' }
export type WebVaultResult = {status: 'opened' | 'cancelled' | 'busy' | 'unavailable'} |
  {status: 'listed'; items: WebVaultItem[]; more: boolean; cursor?: string};

export function webVaultItem(raw: unknown): WebVaultItem {
  const item = record(raw, ['title', 'site', 'kind']);
  const site = new URL(text(item.site, 2048));
  if (site.protocol !== 'https:' || site.origin !== item.site || (item.kind !== 'login' && item.kind !== 'token'))
    throw new AppError(502, 'invalid_vault_response');
  return {title: text(item.title, 400), site: site.origin, kind: item.kind};
}

// The remote protocol carries display metadata only. Reject unexpected fields at the relay.
export function webVaultResult(raw: unknown, action: WebVaultAction): WebVaultResult {
  const value = record(raw, ['status', 'items', 'more', 'cursor']);
  if (value.status === 'listed' && action === 'list' && Array.isArray(value.items) && value.items.length <= 100 && typeof value.more === 'boolean') {
    const items = value.items.map(webVaultItem);
    if (value.cursor !== undefined) {
      if (!value.more || !items.length) throw new AppError(502, 'invalid_vault_response');
      return {status: 'listed', items, more: true, cursor: uuid(value.cursor)};
    }
    return {status: 'listed', items, more: value.more};
  }
  if ((value.status === 'opened' && action === 'manage') || value.status === 'busy' || value.status === 'cancelled' || value.status === 'unavailable')
    return {status: value.status};
  throw new AppError(502, 'invalid_vault_response');
}
