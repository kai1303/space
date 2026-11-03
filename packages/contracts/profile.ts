import { isUnicodeEmoji } from './emoji.js';
import { AppError, record, text } from './validation.js';

export interface UserStatus { text: string; emoji: string; expires_at: string | null }
export interface UserProfile {
  id: string; display_name: string; full_name: string; title: string; name_pronunciation: string;
  phone: string; time_zone: string; image: string | null; email: string | null;
  presence: 'active' | 'away'; status: UserStatus | null;
}
export type ProfileUpdate = Partial<Omit<UserProfile, 'id' | 'email'>>;
export function parseProfileUpdate(input: unknown): ProfileUpdate {
  const v = record(input, ['display_name', 'full_name', 'title', 'name_pronunciation', 'phone', 'time_zone', 'image', 'presence', 'status']);
  if (!Object.keys(v).length) throw new AppError(400, 'empty_profile_update');
  const result: ProfileUpdate = {};
  const optionalText = (value: unknown, max: number) => {
    if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new AppError(400, 'invalid_text');
    return value.trim();
  };
  if ('display_name' in v) result.display_name = text(v.display_name, 100).trim();
  for (const key of ['full_name', 'title', 'name_pronunciation', 'phone'] as const) if (key in v) result[key] = optionalText(v[key], key === 'phone' ? 50 : 200);
  if ('time_zone' in v) {
    const zone = text(v.time_zone, 100);
    try { new Intl.DateTimeFormat('en', { timeZone: zone }); } catch { throw new AppError(400, 'invalid_time_zone'); }
    result.time_zone = zone;
  }
  if ('presence' in v) {
    if (v.presence !== 'active' && v.presence !== 'away') throw new AppError(400, 'invalid_presence');
    result.presence = v.presence;
  }
  if ('image' in v) {
    if (v.image !== null && (typeof v.image !== 'string' || v.image.length > 200_000 || !/^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(v.image))) throw new AppError(400, 'invalid_profile_photo');
    result.image = v.image as string | null;
  }
  if ('status' in v) {
    if (v.status === null) result.status = null;
    else {
      const s = record(v.status, ['text', 'emoji', 'expires_at']);
      const statusText = optionalText(s.text, 100), emoji = optionalText(s.emoji, 64);
      if (emoji && !isUnicodeEmoji(emoji)) throw new AppError(400, 'invalid_status_emoji');
      if (s.expires_at !== null && (typeof s.expires_at !== 'string' || !Number.isFinite(Date.parse(s.expires_at)) || new Date(s.expires_at).toISOString() !== s.expires_at || Date.parse(s.expires_at) <= Date.now())) throw new AppError(400, 'invalid_status_expiration');
      result.status = statusText || emoji ? { text: statusText, emoji, expires_at: s.expires_at as string | null } : null;
    }
  }
  return result;
}
export function visibleStatus(status: UserStatus | null, now = Date.now()): UserStatus | null {
  return status?.expires_at && Date.parse(status.expires_at) <= now ? null : status;
}
