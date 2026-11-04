import { AppError, record, text, uuid } from './validation.js';
import { parsePage, type MemberRole, type Page } from './workspace.js';

export type InvitationGuestType = 'none' | 'single' | 'multi';
export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired';
export type InvitationDelivery = 'unavailable' | 'queued' | 'sent' | 'failed' | 'not_applicable';
export interface WorkspaceInvitation {
  id: string; workspace_id: string; kind: 'email' | 'link'; email: string | null;
  role: 'admin' | 'member'; guest_type: InvitationGuestType; channel_ids: string[];
  created_by: string; created_at: string; expires_at: string; status: InvitationStatus;
  use_limit: number; use_count: number; version: number; delivery_status: InvitationDelivery;
}
export interface InvitationList extends Page<WorkspaceInvitation> { role: MemberRole; email_available: boolean }
export interface InvitationResult { invitation: WorkspaceInvitation; token?: string }
export interface InvitationPreview {
  workspace_id: string; workspace_name: string; kind: 'email' | 'link'; role: 'admin' | 'member';
  guest_type: InvitationGuestType; expires_at: string; email_matches: boolean; email_verified: boolean;
}
export interface InvitationAcceptance { workspace_id: string; already_member: boolean }
export function parseInvitationInput(input: unknown) {
  const v = record(input, ['request_id', 'kind', 'email', 'role', 'guest_type', 'channel_ids', 'expires_in_days', 'use_limit']);
  const kind = v.kind ?? 'email';
  if (kind !== 'email' && kind !== 'link') throw new AppError(400, 'invalid_invitation_kind');
  let email: string | null = null;
  if (kind === 'email') {
    email = text(v.email, 254).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError(400, 'invalid_email');
  } else if (v.email !== undefined) throw new AppError(400, 'invalid_invitation_email');
  const role = v.role ?? 'member';
  if (role !== 'member' && role !== 'admin') throw new AppError(400, 'invalid_role');
  const guest_type = v.guest_type ?? 'none';
  if (!['none', 'single', 'multi'].includes(String(guest_type))) throw new AppError(400, 'invalid_guest_type');
  if (guest_type !== 'none' && role !== 'member') throw new AppError(400, 'invalid_guest_role');
  const channels = v.channel_ids ?? [];
  if (!Array.isArray(channels) || channels.length > 100) throw new AppError(400, 'invalid_channels');
  const channel_ids = [...new Set(channels.map(uuid))].sort();
  if (guest_type === 'single' && channel_ids.length !== 1 || guest_type === 'multi' && !channel_ids.length) throw new AppError(400, 'guest_channels_required');
  const days = v.expires_in_days ?? 7;
  if (!Number.isInteger(days) || Number(days) < 1 || Number(days) > 30) throw new AppError(400, 'invalid_invitation_expiry');
  const use_limit = v.use_limit ?? (kind === 'email' ? 1 : 100);
  if (!Number.isInteger(use_limit) || Number(use_limit) < 1 || Number(use_limit) > 1000 || kind === 'email' && use_limit !== 1) throw new AppError(400, 'invalid_use_limit');
  return { request_id: uuid(v.request_id), kind, email, role, guest_type: guest_type as InvitationGuestType, channel_ids, expires_in_days: Number(days), use_limit: Number(use_limit) };
}
export function parseInvitationQuery(input: unknown) {
  const v = record(input, ['after', 'limit', 'status', 'kind']);
  const status = v.status ?? 'pending', kind = v.kind ?? 'email';
  if (!['pending', 'accepted', 'revoked', 'expired', 'all'].includes(String(status))) throw new AppError(400, 'invalid_invitation_status');
  if (kind !== 'email' && kind !== 'link') throw new AppError(400, 'invalid_invitation_kind');
  return { ...parsePage({ ...(v.after === undefined ? {} : { after: v.after }), ...(v.limit === undefined ? {} : { limit: v.limit }) }), status: String(status), kind };
}
export function invitationToken(input: unknown): string {
  if (typeof input !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input)) throw new AppError(404, 'invitation_unavailable');
  return input;
}
