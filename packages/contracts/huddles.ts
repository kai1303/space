export interface Huddle {
  id: string;
  channel_id: string;
  workspace_id: string;
  channel_name: string;
  state: 'starting' | 'active' | 'ended';
  created_at: string;
}
export interface HuddleAdmission { huddle: Huddle; url: string; token: string }
export const HUDDLE_CAPACITY = 12;
