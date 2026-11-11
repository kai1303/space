import { conversationPath, type ChannelSummary, type ChannelNotificationPreferences } from '@space/contracts';
import type { SidebarAction } from '@space/ui/navigation';

export type NotificationPatch = Partial<Omit<ChannelNotificationPreferences, 'effective_mode'>>;
export type ChannelMenuDialog = 'details' | 'default' | 'advanced' | 'leave';
export function channelMenu(channel: Pick<ChannelSummary,'id'|'name'|'joined'|'notification_preferences'>, starred: boolean, callbacks: {
  dialog: (value: ChannelMenuDialog) => void;
  star: () => void;
  split: () => void;
  copy: (value: string) => void;
  save: (patch: NotificationPatch) => void;
}): SidebarAction[] {
  const { dialog, split, copy, star, save } = callbacks;
  const path = conversationPath(channel.id);
  const copyItems: SidebarAction[] = [{ label:'Copy name', select:() => copy(channel.name) }];
  if (path) {
    const url = new URL(path, location.origin);
    copyItems.push({ label:'Copy link', select:() => copy(url.href) });
    const huddle = new URL(url);
    huddle.searchParams.set('huddle','1');
    copyItems.push({ label:'Copy huddle link', select:() => copy(huddle.href) });
  }
  const actions: SidebarAction[] = [];
  if (channel.joined) actions.push({ label:'Channel details', select:() => dialog('details') });
  actions.push({ label:'Copy', items:copyItems });
  if (channel.joined) {
    const prefs = channel.notification_preferences;
    const until = prefs?.muted_until ? Date.parse(prefs.muted_until) : 0;
    const paused = until > Date.now();
    const midnight = new Date();
    midnight.setHours(24,0,0,0);
    const mode = paused ? 'none' : prefs?.effective_mode ?? 'mentions';
    actions.push({ label:starred ? 'Unstar channel' : 'Star channel', select:star });
    const modes = [['all','All new posts'], ['mentions','Just mentions'], ['none','Mute and hide']] as const;
    for (const [value,label] of modes) actions.push({ label, checked:mode === value, divider:value === 'all', heading:value === 'all' ? 'Notifications' : undefined,
      select:() => save({mode:value, muted_until:null}) });
    function mute(minutes?: number) {
      const date = new Date();
      if (minutes) date.setTime(date.getTime() + minutes * 60000);
      else date.setHours(24, 0, 0, 0);
      save({ muted_until:date.toISOString() });
    }
    actions.push({ label:'More options', items:[
      { label:'Until tomorrow', heading:'Temporarily mute…', checked:paused && until === midnight.getTime(), select:() => mute() },
      { label:'1 hour', checked:paused && until !== midnight.getTime(), select:() => mute(60) },
      ...(paused ? [{label:'Resume notifications',select:() => save({muted_until:null})}] : []),
      { label:'Edit default preferences', divider:true, select:() => dialog('default') },
      { label:'Advanced settings', select:() => dialog('advanced') },
    ] });
  }
  if (path && window.self === window.top) actions.push({ label:'Open in split view', divider:true, shortcut:/Mac/i.test(navigator.platform) ? '⌘ ⌥ Click' : 'Ctrl Alt Click', select:split });
  if (channel.joined) actions.push({ label:'Leave channel', divider:true, danger:true, select:() => dialog('leave') });
  return actions;
}
