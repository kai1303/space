import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { parseMessageInput } from '@space/contracts';
import { RichComposer } from './rich-composer.js';

afterEach(cleanup);
it('sends an attachment-only message with a document accepted by the API', async () => {
  const attachment = { id: '00000000-0000-4000-8000-000000000001', name: 'qa.txt', size: 3, type: 'text/plain', status: 'ready' as const };
  const send = vi.fn(async (text, document, files) => {
    expect(() => parseMessageInput({ client_message_id: '00000000-0000-4000-8000-000000000002', text, document, asset_ids: files.map((file: typeof attachment) => file.id) })).not.toThrow();
  });
  render(<RichComposer channel="qa" attachmentsEnabled attachments={[attachment]} onSend={send} />);
  await screen.findByRole('textbox', { name: 'Message qa' });
  fireEvent.click(screen.getByRole('button', { name: 'Send now' }));
  await waitFor(() => expect(send).toHaveBeenCalledOnce());
  expect(send.mock.calls[0]?.[0]).toBe('');
  expect(screen.queryByRole('alert')).toBeNull();
});
