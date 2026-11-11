import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ChannelSummary } from '@space/contracts';
import { WorkspaceMemory } from './WorkspaceMemory.js';

const dirty = vi.hoisted(() => ({ value: false }));
vi.mock('./ChannelMemory.js', async () => {
  const { useEffect } = await import('react');
  return { ChannelMemory: ({ channel, name, onDirtyChange }: { channel: string; name: string; onDirtyChange?: (dirty: boolean) => void }) => {
    useEffect(() => { onDirtyChange?.(dirty.value); }, [onDirtyChange]);
    return <p data-channel={channel}>Memory for {name}</p>;
  } };
});
afterEach(() => { cleanup(); dirty.value = false; vi.restoreAllMocks(); });

const channel = (id: string, name: string, joined = true) => ({ id, name, joined, private: false, workspace_id: 'w' }) as unknown as ChannelSummary;
const channels = [channel('a', 'general'), channel('b', 'payments'), channel('c', 'secret-plans', false)];

it('lists only joined channels and shows the first one’s memory', async () => {
  const open = vi.fn();
  render(<WorkspaceMemory channels={channels} onOpenChannel={open} />);
  expect(screen.getByText('Memory for general')).toBeTruthy();
  const options = Array.from(screen.getByRole('combobox', { name: 'Channel' }).closest('label')!.querySelectorAll('option')).map(option => option.value);
  expect(options).toEqual(['a', 'b']);
  await userEvent.click(screen.getByRole('button', { name: 'Open channel' }));
  expect(open).toHaveBeenCalledWith('a');
});

it('asks before switching channels with unsaved edits', async () => {
  dirty.value = true;
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<WorkspaceMemory channels={channels} onOpenChannel={() => {}} />);
  const select = screen.getByRole('combobox', { name: 'Channel' }).closest('label')!.querySelector('select')!;
  await userEvent.selectOptions(select, 'b');
  expect(confirm).toHaveBeenCalled();
  expect(screen.getByText('Memory for general')).toBeTruthy();
  confirm.mockReturnValue(true);
  await userEvent.selectOptions(select, 'b');
  expect(screen.getByText('Memory for payments')).toBeTruthy();
});

it('explains what to do when no channel is joined', () => {
  render(<WorkspaceMemory channels={[channel('c', 'secret-plans', false)]} onOpenChannel={() => {}} />);
  expect(screen.getByRole('heading', { name: 'No channel memory to show' })).toBeTruthy();
});
