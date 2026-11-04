import { AppError, record, text, uuid } from './validation.js';

export type MemberRole = 'owner' | 'admin' | 'member';
export interface PageInput { after?: string; limit: number }
export interface Page<T> { items: T[]; next_cursor: string | null }

export function parseProfileInput(input: unknown): { display_name: string } {
  const v = record(input, ['display_name']);
  return { display_name: text(v.display_name, 100).trim() };
}
export function parseWorkspaceInput(input: unknown): { name: string } {
  const v = record(input, ['name']);
  return { name: text(v.name, 100).trim() };
}
export function memberRole(input: unknown): MemberRole {
  if (input !== 'owner' && input !== 'admin' && input !== 'member') throw new AppError(400, 'invalid_role');
  return input;
}
export function parseMemberInput(input: unknown): { user_id: string; role: MemberRole } {
  const v = record(input, ['user_id', 'role']);
  return { user_id: uuid(v.user_id), role: memberRole(v.role) };
}
export function parseWorkspaceMemberInput(input: unknown): { user_id: string; role: MemberRole } | { email: string; role: MemberRole } {
  const v = record(input, ['user_id', 'email', 'role']);
  if (v.email !== undefined) {
    if (v.user_id !== undefined) throw new AppError(400, 'invalid_member');
    const email = text(v.email, 254).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError(400, 'invalid_email');
    return { email, role: memberRole(v.role) };
  }
  return { user_id: uuid(v.user_id), role: memberRole(v.role) };
}

export interface WorkspaceDirectoryMember {
  user_id: string; display_name: string; email?: string | null; role: MemberRole; guest_type?: 'none'|'single'|'multi'; active: boolean; joined_at: string;
}
export interface WorkspaceDirectory extends Page<WorkspaceDirectoryMember> { role: MemberRole; primary_owner_id?: string | null; email_visible?: boolean }
export function parseDirectoryQuery(input: unknown) {
  const v = record(input, ['after', 'limit', 'q', 'role', 'status', 'sort', 'guest']);
  const paging = parsePage({ ...(v.after === undefined ? {} : {after:v.after}), ...(v.limit === undefined ? {} : {limit:v.limit}) });
  const q = v.q === undefined || v.q === '' ? '' : text(v.q, 100).trim();
  const role = v.role === undefined || v.role === 'all' ? undefined : memberRole(v.role);
  const status = v.status ?? 'active';
  if (status !== 'active' && status !== 'deactivated' && status !== 'all') throw new AppError(400, 'invalid_member_status');
  const sort = v.sort ?? 'id';
  if (sort !== 'id' && sort !== 'name' && sort !== 'joined') throw new AppError(400, 'invalid_sort');
  const guest = v.guest ?? 'all';
  if (!['all','none','single','multi'].includes(guest as string)) throw new AppError(400, 'invalid_guest_type');
  return { ...paging, q, role, status, sort, guest };
}
export function parseRoleInput(input: unknown): { role: MemberRole } {
  const v = record(input, ['role']);
  return { role: memberRole(v.role) };
}
export function parsePage(input: unknown): PageInput {
  const v = record(input, ['after', 'limit']);
  const limit = v.limit ?? '50';
  if (typeof limit !== 'string' || !/^[1-9]\d{0,2}$/.test(limit) || Number(limit) > 100) throw new AppError(400, 'invalid_limit');
  return { limit: Number(limit), ...(v.after === undefined ? {} : { after: uuid(v.after) }) };
}
