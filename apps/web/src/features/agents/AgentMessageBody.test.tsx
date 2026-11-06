import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@space/contracts';
import { AgentMessageBody } from './AgentMessageBody.js';

const attachmentMessage = {
  author: { id: 'kai', name: 'Kai', kind: 'human' },
  text: '', document: { ops: [{ insert: '\n' }] },
  attachments: [{ id: 'file', name: 'notes.txt' }],
} as ChatMessage;

describe('attachment message body', () => {
  it('omits the empty composer paragraph above an attachment-only message', () => {
    expect(renderToStaticMarkup(<AgentMessageBody message={attachmentMessage} />)).toBe('');
  });
  it('preserves rich text and intentional blank lines before attachments', () => {
    const message = { ...attachmentMessage, document: { ops: [{ insert: '\nCaption\n' }] } };
    expect(renderToStaticMarkup(<AgentMessageBody message={message} />)).toContain('<p><br/></p><p>Caption</p>');
  });
  it('preserves plain-text captions without a document', () => {
    const message = { ...attachmentMessage, document: undefined, text: 'Caption' };
    expect(renderToStaticMarkup(<AgentMessageBody message={message} />)).toContain('Caption');
  });
});
