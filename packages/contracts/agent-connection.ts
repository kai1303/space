import type { AgentCapabilities } from './index.js';
import { AppError, record, text } from './validation.js';
export const localProviders = {
  codex: { name: 'Codex', connector: 'codex.local', skill: 'codex.run', definition: '41a5de8a-63df-4c25-8666-1d0290bc921f' },
  kiro: { name: 'Kiro', connector: 'kiro.local', skill: 'kiro.run', definition: 'f6090a5c-8959-4674-aec1-f7e611f35c42' },
} as const;
export type LocalProvider = keyof typeof localProviders;
export function parseLocalProvider(value: unknown = 'codex'): LocalProvider {
  if (value !== 'codex' && value !== 'kiro') throw new AppError(400, 'invalid_provider');
  return value;
}
export function localProviderForConnector(connector: string) {
  return Object.values(localProviders).find(provider => provider.connector === connector);
}
export function isLocalAgentSkill(skill: string) { return Object.values(localProviders).some(provider => provider.skill === skill); }
export interface PairedConnector { id: string; definition_id: string; name: string; capabilities: AgentCapabilities; provider?: LocalProvider }
export interface ChannelAgent { id: string; name: string; connector_id: string; provider?: LocalProvider; skills: string[]; granted_skills: string[]; enabled_in_channel: boolean; persistent_sessions: boolean }
export const defaultPairedConnectors: PairedConnector[] = Object.entries(localProviders).map(([provider, entry]) => ({ id: entry.connector, definition_id: entry.definition, name: entry.name, provider: provider as LocalProvider, capabilities: { skills: [entry.skill], controls: { progress_stream: true }, persistent_sessions: true } }));
export type AgentAuthStatus = 'required' | 'ready' | 'error';
export interface AgentPairing { id: string; code: string; expires_at: string; connector_id?: string; provider?: LocalProvider }
export interface AgentPairingStatus { id: string; status: 'pending' | 'claimed' | 'expired' | 'cancelled'; installation_id: string | null; expires_at: string }
export interface WorkspaceParticipant {
  id: string; kind: 'human' | 'agent'; name: string; owner_id?: string;
  status?: 'online' | 'offline' | 'auth_required' | 'error'; auth_status?: AgentAuthStatus; provider?: LocalProvider;
}
export function connectionSecret(value: unknown, length: 32 | 43): string {
  if (typeof value !== 'string' || value.length !== length || !/^[A-Za-z0-9_-]+$/.test(value)) throw new AppError(400, 'invalid_connection_secret');
  return value;
}
export function parsePairing(value: unknown) {
  const v = record(value, ['name', 'provider', 'connector_id']);
  return { connector_id: v.connector_id === undefined ? undefined : text(v.connector_id, 80), provider: parseLocalProvider(v.provider), name: v.name === undefined ? undefined : text(v.name, 100).trim() };
}
export function parsePairingClaim(value: unknown) {
  const v = record(value, ['code', 'credential', 'provider']);
  return { provider: v.provider === undefined ? undefined : parseLocalProvider(v.provider), code: connectionSecret(v.code, 32), credential: connectionSecret(v.credential, 43) };
}
export function parseAgentHeartbeat(value: unknown): AgentAuthStatus {
  const v = record(value, ['auth_status']);
  if (!['required', 'ready', 'error'].includes(v.auth_status as string)) throw new AppError(400, 'invalid_auth_status');
  return v.auth_status as AgentAuthStatus;
}
