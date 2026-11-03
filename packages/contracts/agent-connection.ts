import { AppError, record, text } from './validation.js';
export type AgentAuthStatus = 'required' | 'ready' | 'error';
export interface AgentPairing { id: string; code: string; expires_at: string }
export interface AgentPairingStatus { id: string; status: 'pending' | 'claimed' | 'expired' | 'cancelled'; installation_id: string | null; expires_at: string }
export interface WorkspaceParticipant {
  id: string; kind: 'human' | 'agent'; name: string; owner_id?: string;
  status?: 'online' | 'offline' | 'auth_required' | 'error'; auth_status?: AgentAuthStatus;
}
export function connectionSecret(value: unknown, length: 32 | 43): string {
  if (typeof value !== 'string' || value.length !== length || !/^[A-Za-z0-9_-]+$/.test(value)) throw new AppError(400, 'invalid_connection_secret');
  return value;
}
export function parsePairing(value: unknown) {
  const v = record(value, ['name']);
  return { name: v.name === undefined ? undefined : text(v.name, 100).trim() };
}
export function parsePairingClaim(value: unknown) {
  const v = record(value, ['code', 'credential']);
  return { code: connectionSecret(v.code, 32), credential: connectionSecret(v.credential, 43) };
}
export function parseAgentHeartbeat(value: unknown): AgentAuthStatus {
  const v = record(value, ['auth_status']);
  if (!['required', 'ready', 'error'].includes(v.auth_status as string)) throw new AppError(400, 'invalid_auth_status');
  return v.auth_status as AgentAuthStatus;
}
