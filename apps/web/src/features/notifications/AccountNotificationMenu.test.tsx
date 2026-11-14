import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AccountNotificationMenu } from './AccountNotificationMenu.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('shares a saved pause with subsequent openings and resumes without changing other preferences', async () => {
  let paused: string | null = null;
  const writes: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path, options) => {
    expect(path).toBe('/v1/workspaces/w/notification-settings');
    expect(options.headers['X-Expected-Actor']).toBe('actor');
    if (options.method === 'PATCH') {
      const patch = JSON.parse(options.body);
      writes.push(patch); paused = patch.paused_until;
    }
    return { ok: true, json: async () => ({ paused_until: paused }) };
  }));
  const close = vi.fn();
  const show = () => render(<AccountNotificationMenu workspace="w" actor="actor" onClose={close}/>);
  const first = show();
  await userEvent.hover(screen.getByRole('menuitem', { name: 'Notifications' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: '30 minutes' }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(Date.parse(paused!) - Date.now()).toBeGreaterThan(29 * 60000);
  first.unmount(); show();
  fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Notifications' }), { key: 'ArrowRight' });
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Resume notifications' }));
  expect(writes).toEqual([{ paused_until: expect.any(String) }, { paused_until: null }]);
});
it('rejects an expired custom pause locally and keeps a failed future pause editable', async () => {
  const fetcher = vi.fn(async (_path, options) => ({ ok: options.method !== 'PATCH', json: async () => ({ paused_until: null }) }));
  vi.stubGlobal('fetch', fetcher);
  const close = vi.fn();
  render(<AccountNotificationMenu workspace="w" actor="actor" onClose={close}/>);
  await userEvent.click(screen.getByRole('menuitem', { name: 'Notifications' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Custom…' }));
  const field = screen.getByLabelText('Pause until');
  fireEvent.change(field, { target: { value: '2020-01-01T12:00' } });
  await userEvent.click(screen.getByRole('button', { name: 'Pause notifications' }));
  expect(screen.getByRole('alert').textContent).toContain('future time');
  expect(fetcher).toHaveBeenCalledTimes(1);
  const tomorrow = new Date(Date.now()+86400000);
  fireEvent.change(field, { target: { value: new Date(tomorrow.getTime() - tomorrow.getTimezoneOffset()*60000).toISOString().slice(0,16) } });
  await userEvent.click(screen.getByRole('button', { name: 'Pause notifications' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Couldn’t save'));
  expect(close).not.toHaveBeenCalled();
});

it('shows progress on the chosen duration and accepts it before status is known',async()=>{
 let finish!: (response:Response)=>void;
 vi.stubGlobal('fetch',vi.fn((_url:string,init?:RequestInit)=>new Promise<Response>(resolve=>{
   if(init?.method==='PATCH')finish=resolve;
 })));
 const close=vi.fn();
 render(<AccountNotificationMenu workspace="w" actor="actor" onClose={close}/>);
 await userEvent.click(screen.getByRole('menuitem',{name:'Notifications'}));
 expect(screen.getByText('Checking notification pause…')).toBeTruthy();
 await userEvent.click(screen.getByRole('menuitem',{name:'15 minutes'}));
 expect(screen.getByRole('menuitem',{name:'15 minutes'}).getAttribute('aria-busy')).toBe('true');
 expect(screen.getByRole('menuitem',{name:'1 hour'}).hasAttribute('aria-busy')).toBe(false);
 finish(Response.json({paused_until:new Date(Date.now()+900000).toISOString()}));
 await waitFor(()=>expect(close).toHaveBeenCalledOnce());
});
