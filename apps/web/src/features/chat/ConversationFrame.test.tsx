import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ConversationFrameProvider, ConversationMain } from './ConversationFrame.js';

afterEach(cleanup);
it('keeps the cited answer and its scroll container when a channel takes the primary frame', () => {
  function View({ atSource }: { atSource: boolean }) {
    return <ConversationFrameProvider>
      <ConversationMain retainContents primary={!atSource} inert={atSource} aria-label="Agent session">
        <div data-testid="timeline"><a href="#source">Cited message</a></div>
      </ConversationMain>
      {atSource && <ConversationMain aria-label="Channel">Source message</ConversationMain>}
    </ConversationFrameProvider>;
  }
  const view = render(<View atSource={false}/>);
  const primary = screen.getByRole('main', { name: 'Agent session' });
  const timeline = screen.getByTestId('timeline'), link = screen.getByText('Cited message');
  view.rerender(<View atSource/>);
  expect(screen.getByRole('main', { name: 'Channel' })).toBe(primary);
  expect(link.isConnected).toBe(true);
  expect(link.closest('main')?.hasAttribute('inert')).toBe(true);
  view.rerender(<View atSource={false}/>);
  expect(screen.getByRole('main', { name: 'Agent session' })).toBe(primary);
  expect(screen.getByTestId('timeline')).toBe(timeline);
  expect(primary.contains(link)).toBe(true);
});
