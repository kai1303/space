export type NotificationKind = 'mention' | 'direct_message' | 'thread_reply' | 'reaction' | 'channel_message';
export type NotificationItem = {
  id: string;
  kind: NotificationKind;
  channel_id: string;
  channel_name: string;
  channel_kind: 'channel' | 'direct';
  message_id: string;
  thread_id: string;
  author_name: string;
  text: string;
  emoji: string | null;
  created_at: string;
  read_at: string | null;
  silent: boolean;
};
export type NotificationActivity = { items: NotificationItem[]; unread_count: number; next_cursor: string | null; latest_id: string };
export type NotificationSettings = {
  mode: 'mentions' | 'all' | 'none';
  desktop_enabled: boolean;
  preview_enabled: boolean;
  thread_replies: boolean;
  paused_until: string | null;
};
