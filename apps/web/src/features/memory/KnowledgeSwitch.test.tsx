import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KnowledgeSwitch } from './KnowledgeSwitch.js';

const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('turns knowledge notes on through its own route', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response({ enabled: false, knowledge_enabled: true, provider: 'markdown', can_manage: true, providers: [], document: null })));
  const onChange = vi.fn();
  render(<KnowledgeSwitch path="/channels/c/memory" enabled={false} onChange={onChange} />);
  await userEvent.click(screen.getByRole('switch', { name: 'Knowledge notes' }));
  const [path, options] = vi.mocked(fetch).mock.calls[0]!;
  expect(String(path)).toBe('/v1/channels/c/memory/knowledge');
  expect(JSON.parse((options as RequestInit).body as string)).toEqual({ enabled: true });
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ knowledge_enabled: true }));
});

it('shows the error code in words when the change fails', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response({ error: 'channel_management_forbidden' }, 403)));
  render(<KnowledgeSwitch path="/channels/c/memory" enabled={false} onChange={() => {}} />);
  await userEvent.click(screen.getByRole('switch', { name: 'Knowledge notes' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('channel management forbidden');
});
