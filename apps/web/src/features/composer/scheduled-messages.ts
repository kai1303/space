import type { ScheduledMessage } from '@space/contracts';
import type { Attachment, RichDocument } from '@space/ui/rich-text';
import { ComposerSendError } from '@space/ui/composer';
import { toast } from '@space/ui/primitives';
import { request } from '../../shared/api/request.js';
import { errorText } from '../../shared/api/error-text.js';

const messages: Record<string, string> = {
  too_many_scheduled_messages: 'You have 100 scheduled messages. Send or cancel some first.',
  send_at_out_of_range: 'Choose a time between one minute and 120 days from now.',
  asset_unavailable: 'A file is no longer available. Remove it and try again.',
};

export const scheduledLabel = (at: string | Date) => new Date(at).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// A fresh id per attempt; the server treats a repeat of the same id and content as the same schedule.
export async function scheduleMessage(channel: string, thread: string | undefined, text: string, document: RichDocument, files: Attachment[], at: Date) {
  try {
    const scheduled = await request<ScheduledMessage>(`/channels/${channel}/scheduled-messages`, {
      id: crypto.randomUUID(), text, document, send_at: at.toISOString(), ...(thread ? { thread_id: thread } : {}),
      ...(files.length ? { asset_ids: files.map(file => file.id) } : {}),
    });
    toast.success(`Scheduled for ${scheduledLabel(scheduled.send_at)}`, { description: 'See it in Drafts & sent.' });
    return scheduled;
  } catch (reason) {
    const code = reason instanceof Error ? reason.message : '';
    throw new ComposerSendError(messages[code] ?? `Could not schedule: ${errorText(reason)}. Your draft is still here.`);
  }
}
