import { useState } from 'react';
import { Button, Dialog } from '@space/ui/primitives';
import type { ChannelSummary } from '@space/contracts';
import type { NotificationPatch } from './channel-menu.js';

export function ChannelNotificationEditor({ channel, onClose, onSave }: {channel:ChannelSummary; onClose:()=>void; onSave:(patch:NotificationPatch)=>Promise<void>}) {
  const prefs = channel.notification_preferences;
  const [busy,setBusy] = useState(false), [error,setError] = useState('');
  async function change(key:'desktop_enabled'|'follow_every_thread'|'badge_every_post', value:boolean) {
    setBusy(true); setError('');
    try {
      if (key === 'desktop_enabled' && value && (typeof Notification === 'undefined' || await Notification.requestPermission() !== 'granted')) throw Error('Allow desktop notifications for Space in your browser settings.');
      await onSave({[key]:value});
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save settings'); }
    finally { setBusy(false); }
  }
  function toggle(key:'desktop_enabled'|'follow_every_thread'|'badge_every_post', label:string, help:string) {
    return <label className="space-channel-alert-toggle"><span><strong>{label}</strong><small>{help}</small></span>
      <input type="checkbox" role="switch" checked={!!prefs?.[key]} disabled={busy} aria-label={label} onChange={event => void change(key,event.target.checked)}/></label>;
  }
  const mode = prefs?.effective_mode ?? 'mentions';
  return <Dialog open title="Advanced settings" onClose={onClose} onBeforeClose={()=>!busy}>
    <div className="space-channel-alert-settings">
      <h3>Notifications {mode === 'none' || Date.parse(prefs?.muted_until ?? '') > Date.now() ? 'muted' : mode === 'all' ? 'set to all new posts' : 'set to just mentions'}</h3>
      {toggle('desktop_enabled','Desktop notifications','Show a banner for new notifications.')}
      <div className="space-channel-alert-toggle"><span><strong>Mobile notifications</strong><small>Mobile push is unavailable in Space.</small></span></div>
      {toggle('badge_every_post','Badge every new message in your sidebar','Show an unread count next to the channel name.')}
      {toggle('follow_every_thread','Follow every thread','Get notified about replies in every thread in this channel.')}
      {error && <p role="alert">{error}</p>}
      <Button disabled={busy} onClick={onClose}>Close</Button>
    </div>
  </Dialog>;
}
