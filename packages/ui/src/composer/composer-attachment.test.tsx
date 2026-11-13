import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { parseMessageInput } from '@space/contracts';
import { RichComposer } from './rich-composer.js';

afterEach(cleanup);
it('sends an attachment-only message with a document accepted by the API', async () => {
  const attachment = { id: '00000000-0000-4000-8000-000000000001', name: 'qa.txt', size: 3, type: 'text/plain', status: 'ready' as const };
  const send = vi.fn(async (text, document, files) => {
    expect(() => parseMessageInput({ client_message_id: '00000000-0000-4000-8000-000000000002', text, document, asset_ids: files.map((file: typeof attachment) => file.id) })).not.toThrow();
  });
  render(<RichComposer channel="qa" attachmentsEnabled attachments={[attachment]} onSend={send} />);
  await screen.findByRole('textbox', { name: 'Message qa' });
  fireEvent.click(screen.getByRole('button', { name: 'Send now' }));
  await waitFor(() => expect(send).toHaveBeenCalledOnce());
  expect(send.mock.calls[0]?.[0]).toBe('');
  expect(screen.queryByRole('alert')).toBeNull();
});

it('submits an uploading draft once with the finalized file ID and retains a failed draft', async () => {
  const pending = { id: 'local', name: 'notes.txt', size: 10, type: 'text/plain', status: 'uploading' as const };
  const ready = { ...pending, draftId: 'local', id: 'saved', status: 'ready' as const };
  const send = vi.fn();
  const ui = (file: typeof pending | typeof ready | (Omit<typeof pending,'status'> & {status:'error'})) =>
    <RichComposer channel="qa" attachmentsEnabled attachments={[file]} onSend={send}/>;
  const view = render(ui(pending));
  await screen.findByRole('textbox', { name: 'Message qa' });
  fireEvent.click(screen.getByRole('button', { name: 'Send now' }));
  expect(send).not.toHaveBeenCalled();
  view.rerender(ui({ ...pending, status: 'error' }));
  await screen.findByText(/An attachment failed/);
  expect(send).not.toHaveBeenCalled();
  view.rerender(ui(pending));
  fireEvent.click(screen.getByRole('button', { name: 'Send now' }));
  view.rerender(ui(ready));
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  expect(send.mock.calls[0]?.[2]).toEqual([ready]);
});

it('routes file drop and paste through draft validation', async () => {
  const send=vi.fn();
  render(<RichComposer channel="qa" onSend={send}/>);
  const editor=await screen.findByRole('textbox',{name:'Message qa'});
  const file=(name:string)=>new File(['hello'],name,{type:'text/plain'});
  fireEvent.drop(editor,{dataTransfer:{types:['Files'],files:[file('first.txt')]}});
  fireEvent.paste(editor,{clipboardData:{files:[file('second.txt')]}});
  expect(await screen.findByRole('button',{name:'Remove second.txt'})).toBeTruthy();
  fireEvent.drop(editor,{dataTransfer:{types:['Files'],files:[new File([],'empty.txt')]}});
  expect((await screen.findByRole('alert')).textContent).toContain('Each file');
  fireEvent.click(screen.getByRole('button',{name:'Send now'}));
  await waitFor(()=>expect(send).toHaveBeenCalledOnce());
  expect(send.mock.calls[0]![2].map((f:{name:string})=>f.name)).toEqual(['first.txt','second.txt']);
});

it('opens the Attach menu on one click and the file chooser from Upload or a double click', async () => {
  const {container}=render(<RichComposer channel="qa" onSend={vi.fn()}/>);
  await screen.findByRole('textbox',{name:'Message qa'});
  const chooser=vi.spyOn(container.querySelector<HTMLInputElement>('input[type=file]')!,'click').mockImplementation(()=>{});
  const plus=screen.getByRole('button',{name:'Attach files'});
  fireEvent.click(plus);
  expect(chooser).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByRole('menuitem',{name:'Upload from your computer'}));
  expect(chooser).toHaveBeenCalledTimes(1);
  fireEvent.doubleClick(plus);
  expect(chooser).toHaveBeenCalledTimes(2);
});
