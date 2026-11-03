import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AgentResponse as Response } from '@space/contracts';
import { AgentResponse } from './agent-response.js';

afterEach(cleanup);

it('keeps the saved text visible when a backend finishes without structured content', () => {
  render(<AgentResponse response={{ messages: [], tools: [], components: [] }} fallback="Agent run completed." />);
  expect(screen.getByText('Agent run completed.')).toBeTruthy();
});
const response: Response = {
  messages: [{ id: 'm', text: '## Results\n\nHello **Kai**.\n\n```ts\nconst answer = 42;\n```', status: 'complete' }],
  tools: [{ id: 't', name: 'Search records', arguments: '{"query":"churn"}', result: 'Found 3 records', status: 'completed' }],
  components: [{ id: 'c', type: 'card', title: 'Churn', body: 'Down 2%' }, { id: 'table', type: 'table', title: 'Customers', columns: ['Plan', 'Count'], rows: [['Pro', '3']] }],
};
it('renders Markdown, Space code blocks, tool results and registered cards/tables', async () => {
  render(<AgentResponse response={response} />);
  expect(screen.getByRole('heading', { name: 'Results' })).toBeTruthy();
  expect(screen.getByText('Kai').tagName).toBe('STRONG');
  expect(screen.getByRole('group', { name: /code block/i })).toBeTruthy();
  expect(screen.getByRole('table', { name: 'Customers' })).toBeTruthy();
  expect(screen.getByText('Down 2%')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Expand timeline' }));
  expect(screen.getByText('Found 3 records')).toBeTruthy();
});
it('never mounts agent HTML, executable links or remote images', () => {
  const { container } = render(<AgentResponse response={{ ...response, messages: [{ id: 'm', status: 'complete', text: '<script>alert(1)</script>\n\n[click](javascript:alert)\n\n![tracking](https://example.com/pixel.png)' }] }} />);
  expect(container.querySelector('script, iframe, img, a[href^="javascript:"]')).toBeNull();
});
it('updates streamed text in place and shows interrupted tool state on failure', () => {
  const partial: Response = { messages: [{ id: 'm', text: 'Hel', status: 'streaming' }], tools: [], components: [], step: 'Looking up records' };
  const { rerender } = render(<AgentResponse response={partial} streaming />);
  expect(screen.getByRole('status').textContent).toContain('Looking up records');
  rerender(<AgentResponse response={{ ...partial, messages: [{ id: 'm', text: 'Hello Kai', status: 'complete' }], tools: [{ ...response.tools[0]!, status: 'interrupted', result: undefined }] }} />);
  expect(screen.getAllByText('Hello Kai')).toHaveLength(1);
  expect(screen.getByText(/Interrupted/)).toBeTruthy();
  expect(screen.queryByRole('status')).toBeNull();
});
