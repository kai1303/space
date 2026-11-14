import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import type { UserProfile } from '@space/contracts';
import userEvent from '@testing-library/user-event';
import { UserSettings, endOfDay } from './UserProfile.js';

vi.mock('../auth/AuthScreen.js', () => ({ SignOutButton: () => <button>Sign out</button> }));
const profile = { id: 'user', display_name: 'Kai', full_name: 'Kai Nguyen', title: 'Designer', phone: '', name_pronunciation: '', time_zone: 'Asia/Ho_Chi_Minh', image: null, email: 'kai@example.test', status: null, presence: 'active' as const };
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')); };
});
function setup(fail = false, initial: UserProfile = profile) {
  let current = { ...initial };
  const fetcher = vi.fn(async (_url: string, options?: RequestInit) => {
    if (options?.method === 'PATCH' && fail) return { ok: false, status: 500, json: async () => ({ error: 'Save failed' }) };
    if (options?.method === 'PATCH') current = { ...current, ...JSON.parse(options.body as string) };
    return { ok: true, json: async () => current };
  });
  vi.stubGlobal('fetch', fetcher);
  render(<StrictMode><UserSettings user="Kai" userId="user" /></StrictMode>);
  return fetcher;
}
async function open(label: string) {
  await userEvent.click(screen.getByRole('button', { name: 'Your account' }));
  await userEvent.click(screen.getByRole('menuitem', { name: label }));
}
it('opens the personal Vault directly below Profile on desktop', async () => {
  const openVault = vi.fn(async () => 'closed');
  vi.stubGlobal('spaceDesktop', { openVault });
  setup();
  await userEvent.click(screen.getByRole('button', { name: 'Your account' }));
  const entry = await screen.findByRole('menuitem', { name: 'Vault' });
  expect(entry.previousElementSibling?.textContent).toBe('Profile');
  expect(entry.getAttribute('href')).toBe('/vault');
  expect(openVault).not.toHaveBeenCalled();
});
it('links to the personal Vault page on the web', async () => {
  setup();
  await userEvent.click(screen.getByRole('button', { name: 'Your account' }));
  const vault = await screen.findByRole('menuitem', { name: 'Vault' });
  expect(vault.getAttribute('href')).toBe('/vault');
});
it('edits and persists a profile, then displays the saved name', async () => {
  const fetcher = setup();
  await open('Profile');
  await screen.findByRole('heading', { name: 'Kai Nguyen' });
  await userEvent.click(screen.getByRole('button', { name: 'Edit profile' }));
  const name = screen.getByRole('textbox', { name: 'Display name' });
  await userEvent.clear(name); await userEvent.type(name, 'Kai N');
  await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
  await waitFor(() => expect(fetcher.mock.calls.some(([, options]) => options?.method === 'PATCH' && JSON.parse(options.body as string).display_name === 'Kai N')).toBe(true));
  await screen.findByText('Kai N');
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit your profile' })).toBeNull());
});
it('sets a status preset with expiration and can clear it', async () => {
  const fetcher = setup();
  await open('Update your status');
  await userEvent.click(screen.getByRole('button', { name: /In a meeting/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  await waitFor(() => expect(fetcher.mock.calls.some(([, options]) => options?.method === 'PATCH' && JSON.parse(options.body as string).status?.text === 'In a meeting')).toBe(true));
  const saved = JSON.parse(fetcher.mock.calls.find(([, options]) => options?.method === 'PATCH')![1]!.body as string);
  expect(Date.parse(saved.status.expires_at)).toBeGreaterThan(Date.now());
  await open('Clear status');
  await waitFor(() => expect(fetcher.mock.calls.some(([, options]) => options?.method === 'PATCH' && JSON.parse(options.body as string).status === null)).toBe(true));
});
it('keeps unsaved profile edits after a failed save and cancel sends no patch', async () => {
  const fetcher = setup(true);
  await open('Profile'); await screen.findByRole('heading', { name: 'Kai Nguyen' });
  await userEvent.click(screen.getByRole('button', { name: 'Edit profile' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Engineer' } });
  await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
  await screen.findByRole('alert');
  expect((screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement).value).toBe('Engineer');
  const before = fetcher.mock.calls.length;
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(fetcher.mock.calls.length).toBe(before);
});
it('persists away presence and offers switching back to active', async () => {
  const fetcher = setup();
  await open('Set yourself as away');
  await waitFor(() => expect(fetcher.mock.calls.some(([, options]) => options?.method === 'PATCH' && JSON.parse(options.body as string).presence === 'away')).toBe(true));
  await userEvent.click(screen.getByRole('button', { name: 'Your account' }));
  expect(screen.getByRole('menuitem', { name: 'Set yourself as active' })).toBeTruthy();
});
it('calculates Today using the profile time zone and handles DST changes', () => {
  expect(endOfDay('Asia/Ho_Chi_Minh', new Date('2026-11-03T10:00:00Z')).toISOString()).toBe('2026-11-03T17:00:00.000Z');
  expect(endOfDay('America/New_York', new Date('2026-11-01T05:30:00Z')).toISOString()).toBe('2026-11-02T05:00:00.000Z');
});
it('keeps status edits safe when the original status expires while editing', async () => {
  const fetcher = setup(false, { ...profile, status: { text: 'Reviewing', emoji: '👀', expires_at: new Date(Date.now() + 10_000).toISOString() } });
  await open('Reviewing');
  vi.useFakeTimers();
  act(() => vi.advanceTimersByTime(11_000));
  fireEvent.submit(document.querySelector('.space-status-editor')!);
  expect(screen.getByRole('alert').textContent).toContain('expired');
  expect(fetcher.mock.calls.some(([, options]) => options?.method === 'PATCH')).toBe(false);
});
it('prepares, previews and saves a photo under StrictMode', async () => {
  const fetcher = setup();
  const image = 'data:image/jpeg;base64,/9j/AA==';
  const drawImage = vi.fn(), close = vi.fn();
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 256, height: 128, close })));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage, fillRect: vi.fn() } as any);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(image);
  await open('Profile'); await screen.findByRole('heading', { name: 'Kai Nguyen' });
  await userEvent.click(screen.getByRole('button', { name: 'Edit profile' }));
  await userEvent.upload(screen.getByLabelText('Upload profile photo'), new File(['test'], 'photo.png', { type: 'image/png' }));
  await screen.findByRole('button', { name: 'Remove photo' });
  expect(drawImage.mock.calls[0]?.slice(1)).toEqual([64, 0, 128, 128, 0, 0, 192, 192]);
  expect(close).toHaveBeenCalledOnce();
  await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
  await waitFor(() => expect(fetcher.mock.calls.some(([, options]) => options?.method === 'PATCH' && JSON.parse(options.body as string).image === image)).toBe(true));
});

it('keeps the searchable emoji picker inside the native status dialog', async () => {
  const fetcher = setup();
  await open('Update your status');
  const status = screen.getByRole('dialog');
  await userEvent.click(screen.getByRole('button',{name:'Choose status emoji'}));
  const picker = screen.getByRole('dialog',{name:'Choose status emoji'});
  expect(status.contains(picker)).toBe(true);
  await userEvent.type(within(picker).getByRole('searchbox',{name:'Search emoji'}),'rocket');
  await userEvent.click(within(picker).getByRole('button',{name:'🚀 :rocket:'}));
  await userEvent.click(screen.getByRole('button',{name:'Save',exact:true}));
  await waitFor(() => expect(fetcher.mock.calls.some(([,options]) => options?.method === 'PATCH' && JSON.parse(options.body as string).status?.emoji === '🚀')).toBe(true));
});
