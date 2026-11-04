import { AppError, record, text, uuid } from './validation.js';
import type { MemberRole } from './workspace.js';

export type WorkspacePolicy = 'admins' | 'members';
export interface WorkspacePreferences {
  workspace_id: string;
  revision: string;
  icon_url: string | null;
  slug: string | null;
  description: string;
  default_channel_ids: string[];
  approved_email_domains: string[];
  language: string;
  display_name_guidelines: string;
  email_visibility: WorkspacePolicy;
  invite_permission: WorkspacePolicy;
  create_channel_permission: WorkspacePolicy;
  retention_days: number | null;
}
export interface WorkspaceSettings extends WorkspacePreferences {
  name: string;
  role: MemberRole;
  created_at: string;
}
export type WorkspaceSettingsUpdate = { revision: string; name?: string } & Partial<Omit<WorkspacePreferences, 'workspace_id' | 'revision'>>;
export const workspacePreferenceDefaults = {
  revision: '0', icon_url: null, slug: null, description: '', default_channel_ids: [], approved_email_domains: [],
  language: 'en', display_name_guidelines: '', email_visibility: 'admins', invite_permission: 'admins',
  create_channel_permission: 'members', retention_days: null,
} satisfies Omit<WorkspacePreferences, 'workspace_id'>;
export const workspaceLanguages = ['en', 'vi', 'fr', 'de', 'es', 'pt', 'ja', 'ko', 'zh'] as const;
export function parseWorkspaceSlug(value: unknown): string {
  const slug = text(value, 63).trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(slug) || slug.length < 3) throw new AppError(400, 'invalid_workspace_slug');
  return slug;
}
export function parseWorkspaceSettingsUpdate(input: unknown): WorkspaceSettingsUpdate {
  const v = record(input, ['revision', 'name', ...Object.keys(workspacePreferenceDefaults)]);
  if (typeof v.revision !== 'string' || !/^(0|[1-9][0-9]{0,17})$/.test(v.revision)) throw new AppError(400, 'invalid_settings_revision');
  if (Object.keys(v).length < 2) throw new AppError(400, 'empty_settings_update');
  const result: WorkspaceSettingsUpdate = { revision: v.revision };
  if ('name' in v) result.name = text(v.name, 100).trim();
  if ('slug' in v) result.slug = v.slug === null ? null : parseWorkspaceSlug(v.slug);
  for (const key of ['description', 'display_name_guidelines'] as const) if (key in v) {
    if (typeof v[key] !== 'string' || v[key].length > 2000 || v[key].includes('\0')) throw new AppError(400, 'invalid_text');
    result[key] = v[key].trim();
  }
  if ('icon_url' in v) {
    if (v.icon_url !== null) {
      if (typeof v.icon_url !== 'string' || v.icon_url.length > 200_000) throw new AppError(400, 'invalid_workspace_icon');
      const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(v.icon_url);
      if (!match || match[2]!.length % 4 !== 0) throw new AppError(400, 'invalid_workspace_icon');
      const bytes = atob(match[2]!);
      if (!(match[1] === 'png' ? bytes.startsWith('\x89PNG\r\n\x1a\n') : match[1] === 'jpeg' ? bytes.startsWith('\xff\xd8\xff') : bytes.startsWith('RIFF') && bytes.slice(8, 12) === 'WEBP')) throw new AppError(400, 'invalid_workspace_icon');
    }
    result.icon_url = v.icon_url as string | null;
  }
  if ('default_channel_ids' in v) {
    if (!Array.isArray(v.default_channel_ids) || v.default_channel_ids.length > 25) throw new AppError(400, 'invalid_default_channels');
    result.default_channel_ids = [...new Set(v.default_channel_ids.map(uuid))];
  }
  if ('approved_email_domains' in v) {
    if (!Array.isArray(v.approved_email_domains) || v.approved_email_domains.length > 50) throw new AppError(400, 'invalid_email_domains');
    result.approved_email_domains = [...new Set(v.approved_email_domains.map(value => {
      const domain = text(value, 253).trim().toLowerCase();
      if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) throw new AppError(400, 'invalid_email_domains');
      return domain;
    }))];
  }
  if ('language' in v) {
    if (!workspaceLanguages.includes(v.language as typeof workspaceLanguages[number])) throw new AppError(400, 'invalid_workspace_language');
    result.language = v.language as string;
  }
  for (const key of ['email_visibility', 'invite_permission', 'create_channel_permission'] as const) if (key in v) {
    if (v[key] !== 'admins' && v[key] !== 'members') throw new AppError(400, 'invalid_workspace_permission');
    result[key] = v[key];
  }
  if ('retention_days' in v) {
    if (v.retention_days !== null && (!Number.isInteger(v.retention_days) || Number(v.retention_days) < 1 || Number(v.retention_days) > 36500)) throw new AppError(400, 'invalid_retention_days');
    result.retention_days = v.retention_days as number | null;
  }
  return result;
}
