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
