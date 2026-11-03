import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentRequest } from './AgentRequest.js';
const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('./chat-client.js', () => api);
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const agent = { id: 'local', workspace_id: 'workspace', owner_id: 'owner', definition_id: 'definition', connector_id: 'codex.local', enabled: true, capabilities: { skills: ['codex.run'], controls: {} } };
const candidate = { installation_id: 'local', name: 'Kai’s Codex', skill: 'codex.run', description: 'Local agent' };
it('discovers a newly paired Codex, enables it explicitly for this channel, then requests an approved task', async () => {
  let enabled = false;
  api.request.mockImplementation(async (path: string) => {
    if (path.startsWith('/agents/installations')) return [agent];
    if (path.endsWith('/local-codex')) return [{ id: 'local', name: 'Kai’s Codex', enabled_in_channel: enabled }];
    if (path.endsWith('/navigator')) return { candidates: enabled ? [candidate] : [] };
    if (path.endsWith('/channels/channel')) { enabled = true; return { enabled_in_channel: true }; }
    return { id: 'task' };
  });
  const props = { workspace: 'workspace', channel: 'channel', thread: 'thread', agents: [], onCandidates: vi.fn() };
  render(<AgentRequest {...props} />);
  await userEvent.click(screen.getByRole('button', { name: 'Ask an agent' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Enable Kai’s Codex in this channel' }));
  expect(api.request).toHaveBeenCalledWith('/agents/connections/local/channels/channel', { enabled: true });
  const select = await screen.findByRole('combobox', { name: 'Agent and skill' });
  await userEvent.selectOptions(select, 'local|codex.run');
  await userEvent.type(screen.getByRole('textbox', { name: 'What should the agent do?' }), 'Say hello');
  await userEvent.click(screen.getByRole('button', { name: 'Request task' }));
  await waitFor(() => expect(api.request).toHaveBeenCalledWith('/tasks', { workspace_id: 'workspace', thread_id: 'thread', installation_id: 'local', skill: 'codex.run', goal: 'Say hello' }, expect.any(String)));
  expect(props.onCandidates).toHaveBeenCalledWith([candidate]);
});
it('does not offer an ungranted local skill and makes discovery errors visible', async () => {
  api.request.mockRejectedValue(new Error('not_found'));
  const props = { workspace: 'workspace', channel: 'private', thread: 'thread', agents: [agent], onCandidates: vi.fn() };
  render(<AgentRequest {...props} />);
  await userEvent.click(screen.getByRole('button', { name: 'Ask an agent' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'not found');
  expect(screen.queryByRole('option', { name: /codex.run/ })).toBeNull();
});
