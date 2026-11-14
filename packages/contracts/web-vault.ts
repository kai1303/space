import { AppError, record, text, uuid } from './validation.js';

export type WebVaultAction = 'list' | 'manage' | 'prepare-linear' | 'save-linear' | 'list-items' | 'prepare-item' | 'change-item';
export interface VaultMac { id: string; name: string; online: boolean }
export interface WebVaultItem { title: string; site: string; kind: 'login' | 'token' }
export interface VaultItemDetails extends WebVaultItem {
  id: string; version: string; username?: string; endpoint?: string;
}
export type VaultChange =
  | {operation:'delete'; id:string; version:string; site:string; title:string}
  | {operation:'create' | 'edit'; id?:string; version?:string; kind:'login'|'token'; title:string; site:string;
     username?:string; endpoint?:string; secret:string};
export function parseVaultChange(raw: unknown): VaultChange {
  const fields = record(raw, ['operation','id','version','kind','title','site','username','endpoint','secret']);
  const {operation, kind} = fields;
  const title = text(fields.title, 100).trim(), site = text(fields.site, 2000);
  const identity = operation === 'create' ? {} : {id:uuid(fields.id), version:uuid(fields.version)};
  if (operation === 'delete') return {operation, site, title, id:uuid(fields.id), version:uuid(fields.version)};
  if ((operation !== 'create' && operation !== 'edit') || (kind !== 'login' && kind !== 'token') ||
      typeof fields.secret !== 'string' || fields.secret.length > 4096 || (operation === 'create' && !fields.secret))
    throw new AppError(400, 'invalid_vault_item');
  return {operation, ...identity, kind, title, site, secret:fields.secret,
    ...(kind === 'login' ? {username:text(fields.username, 1024)} : {endpoint: fields.endpoint ? text(fields.endpoint, 2000) : ''})};
}
export type VaultChangeResult = {status:'saved'; item:VaultItemDetails} | {status:'deleted'|'duplicate'|'stale'|'invalid'|'busy'|'cancelled'|'unavailable'};
export type VaultPage = {status:'listed'; items:VaultItemDetails[]; more:boolean; cursor?:string};
export type WebVaultResult = {status:'encrypted'; sealed:string; cursor?:string} | {status: 'opened' | 'cancelled' | 'busy' | 'unavailable'} |
  {status: 'ready'; transfer: string; publicKey: string} | {status: 'saved'; item: WebVaultItem} | {status: 'duplicate'} |
  {status: 'listed'; items: WebVaultItem[]; more: boolean; cursor?: string};

export function webVaultItem(raw: unknown): WebVaultItem {
  const item = record(raw, ['title', 'site', 'kind']);
  const site = new URL(text(item.site, 2048));
  if (site.protocol !== 'https:' || site.origin !== item.site || (item.kind !== 'login' && item.kind !== 'token'))
    throw new AppError(502, 'invalid_vault_response');
  return {title: text(item.title, 400), site: site.origin, kind: item.kind};
}

export function webVaultCommand(raw: unknown) {
  const {action, cursor, transfer, sealed, publicKey} = record(raw, ['action', 'cursor', 'transfer', 'sealed', 'publicKey']);
  if (action === 'list-items' && transfer === undefined && sealed === undefined) {
    return {action, publicKey:text(publicKey, 256), ...(cursor === undefined ? {} : {cursor:uuid(cursor)})} as const;
  }
  if (publicKey !== undefined) throw new AppError(400, 'invalid_vault_action');
  if (action !== 'list' && action !== 'manage' && action !== 'prepare-linear' && action !== 'save-linear' && action !== 'prepare-item' && action !== 'change-item')
    throw new AppError(400, 'invalid_vault_action');
  if ((action === 'save-linear' || action === 'change-item') && cursor === undefined && typeof sealed === 'string' && sealed.length <= 32768 &&
      /^[A-Za-z0-9_-]+\.\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/.test(sealed))
    return {action, transfer: uuid(transfer), sealed} as const;
  if (action === 'save-linear' || action === 'change-item' || transfer !== undefined || sealed !== undefined || (cursor !== undefined && action !== 'list'))
    throw new AppError(400, 'invalid_vault_action');
  return {action, ...(cursor === undefined ? {} : {cursor: uuid(cursor)})} as const;
}

export function webVaultResult(raw: unknown, action: WebVaultAction): WebVaultResult {
  if (action === 'list-items' || action === 'change-item') {
    const value = record(raw, ['status','sealed','cursor']);
    if (value.status === 'encrypted') {
      return {status:'encrypted', sealed:text(value.sealed, 110000),
        ...(action === 'list-items' && value.cursor !== undefined ? {cursor:uuid(value.cursor)} : {})};
    }
    if (value.status === 'busy' || value.status === 'cancelled' || value.status === 'unavailable') return {status:value.status};
    throw new AppError(502, 'invalid_vault_response');
  }
  const value = record(raw, (action === 'prepare-linear' || action === 'prepare-item') ? ['status', 'transfer', 'publicKey'] :
    action === 'save-linear' ? ['status', 'item'] : ['status', 'items', 'more', 'cursor']);
  if ((action === 'prepare-linear' || action === 'prepare-item') && value.status === 'ready')
    return {status:'ready', transfer: uuid(value.transfer), publicKey: text(value.publicKey, 256)};
  if (action === 'save-linear' && value.status === 'saved') {
    const item = webVaultItem(value.item);
    if (item.site !== 'https://linear.app' || item.kind !== 'token') throw new AppError(502, 'invalid_vault_response');
    return {status:'saved', item};
  }
  if (action === 'save-linear' && value.status === 'duplicate') return {status:'duplicate'};
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
