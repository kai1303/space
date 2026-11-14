import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionTranscript } from './SessionTranscript.js';
import { request } from '../../shared/api/request.js';

vi.mock('../../shared/api/request.js', () => ({ request: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('loads older tools on demand and reconstructs the exact expanded result across pages', async () => {
  const tool = { id: 'first', kind: 'tool', name: 'shell', status: 'completed', shell:{command:'cat log',duration_ms:3000,exit_code:7,outcome:'failed'}, position: 0 };
  const message = { id: 'answer', kind: 'message', name: 'Message', position: 1 };
  const output = 'Output line\n'.repeat(2000) + 'Final line';
  const data = JSON.stringify({ id: tool.id, name: tool.name, arguments: JSON.stringify({command:'cat log'}), status:'interrupted', result: output });
  const routes: Record<string,unknown> = {
    '/archive': { items: [message], next: 1 },
    '/archive?after=1': { items: [tool], next: null },
    '/archive?position=1': { chunks: [{ part: 0, last: true, data: JSON.stringify({ id: message.id, text: 'Finished.' }) }] },
    '/archive?position=0': { chunks: [{ part: 0, last: false, data: data.slice(0,12000) }] },
    '/archive?position=0&after=0': { chunks: [{ part: 1, last: true, data: data.slice(12000) }] },
  };
  vi.mocked(request).mockImplementation(async path => {
    if (!(path in routes)) throw new Error('Unexpected URL ' + path);
    return routes[path];
  });
  render(<SessionTranscript url="/archive" version={2} viewer="user" streaming={false}/>);
  await screen.findByText('Finished.');
  fireEvent.click(screen.getByRole('button', { name: 'Show earlier items' }));
  const expand = await screen.findByRole('button', { name: /Ran cat log.*3s/ });
  expect(vi.mocked(request).mock.calls.some(([path])=>path.startsWith('/archive?position=0'))).toBe(false);
  fireEvent.click(expand);
  expect((await screen.findByLabelText('Tool result')).textContent).toBe(output);
  expect(screen.getByText('Exit code 7')).toBeTruthy();
  const writeText=vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator',Object.create(navigator,{clipboard:{value:{writeText}}}));
  try {
    fireEvent.click(screen.getByRole('button',{name:'Copy output'}));
    expect(writeText).toHaveBeenCalledWith(output);
    fireEvent.click(screen.getByRole('button',{name:'Copy command'}));
    expect(writeText).toHaveBeenCalledWith('cat log');
  } finally { vi.unstubAllGlobals(); }
});
