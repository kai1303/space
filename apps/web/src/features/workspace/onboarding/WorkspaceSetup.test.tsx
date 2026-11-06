import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { WorkspaceSetup } from './WorkspaceSetup.js';

afterEach(cleanup);

it('submits one trimmed name while pending and allows retry after a failed creation', async () => {
  let reject!: (reason: Error) => void;
  const create = vi.fn().mockReturnValue(new Promise((_, fail) => { reject = fail; }));
  render(<WorkspaceSetup name="Kai" onCreate={create} />);
  const input = screen.getByRole('textbox', { name: 'Workspace name' });
  fireEvent.change(input, { target: { value: '  My team  ' } });
  const form = input.closest('form')!;
  fireEvent.submit(form);
  fireEvent.submit(form);
  expect(create).toHaveBeenCalledTimes(1);
  expect(create).toHaveBeenCalledWith('My team');
  expect(input).toHaveProperty('disabled', true);
  expect(screen.getByRole('button', { name: 'Creating workspace…' })).toHaveProperty('disabled', true);
  await act(async () => { reject(new Error('Cannot reach the server')); });
  expect(screen.getByRole('alert').textContent).toContain('Cannot reach the server');
  expect(input).toHaveProperty('value', '  My team  ');
  expect(input).toHaveProperty('disabled', false);
  create.mockResolvedValue(undefined);
  await act(async () => { fireEvent.submit(form); });
  expect(create).toHaveBeenCalledTimes(2);
});
