import { AppError, type MemberRole, type Page } from '@space/contracts';

export function page<T>(rows: T[], limit: number, key: (row: T) => string): Page<T> {
  const items = rows.slice(0, limit);
  return { items, next_cursor: rows.length > limit ? key(items[items.length - 1]!) : null };
}
export function canManage(actorRole: MemberRole, targetRole: MemberRole, nextRole: MemberRole = 'member') {
  if (actorRole !== 'owner' && !(actorRole === 'admin' && targetRole === 'member' && nextRole === 'member')) {
    throw new AppError(403, 'member_management_forbidden');
  }
}
