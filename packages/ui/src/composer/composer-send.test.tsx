import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RichComposer } from './rich-composer.js';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')); };
  Object.defineProperties(Range.prototype, {
    getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
    getClientRects: { configurable: true, value: () => [] },
  });
});
afterEach(cleanup);
it('hides the idle hint without hiding a disabled-send status', async()=>{
 const {rerender}=render(<RichComposer channel="agent session" showKeyboardHint={false} attachmentsEnabled={false} onSend={vi.fn()}/>);
 await screen.findByRole('textbox',{name:'Message agent session'});
 expect(screen.queryByText(/Enter to send/)).toBeNull();
 rerender(<RichComposer channel="agent session" showKeyboardHint={false} attachmentsEnabled={false} sendDisabledReason="Waiting for approval" onSend={vi.fn()}/>);
 expect(screen.getByRole('status').textContent).toBe('Waiting for approval');
});
it('keeps Enter and Send disabled silently while channel permissions load', async () => {
  const send = vi.fn();
  const props = { channel: 'general', showKeyboardHint: false, attachmentsEnabled: false, onSend: send };
  const view = render(<RichComposer {...props} sendDisabled />);
  const editor = await screen.findByRole('textbox', { name: 'Message general' });
  await userEvent.type(editor, 'Keep my draft{Enter}');
  expect(send).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Send now' })).toHaveProperty('disabled', true);
  expect(view.container.querySelector('.sp-rich-help')).toBeNull();
  view.rerender(<RichComposer {...props}/>);
  fireEvent.keyDown(editor, { key: 'Enter' });
  await waitFor(() => expect(send).toHaveBeenCalledOnce());
});
afterAll(() => { Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect'); Reflect.deleteProperty(Range.prototype, 'getClientRects'); });
it('keeps the mounted composer visually stable during a quick send without allowing a duplicate', async () => {
  let finish!: () => void;
  const submitted = new Promise<void>(resolve => { finish = resolve; });
  const send = vi.fn(() => submitted);
  const { container } = render(<RichComposer channel="general" onSend={send} />);
  const editor = await screen.findByRole('textbox', { name: 'Message general' });
  await userEvent.type(editor, 'A quick message');
  const bold = screen.getByRole('button', { name: 'Bold', exact: true });
  const controls = container.querySelectorAll('button').length;
  fireEvent.keyDown(editor, { key: 'Enter' });
  expect(screen.queryByText('Sending…')).toBeNull();
  expect(container.querySelector('.sp-rich-composer')?.getAttribute('aria-busy')).toBe('true');
  expect(container.querySelectorAll('button')).toHaveLength(controls);
  expect(bold.getAttribute('data-send-disabled')).toBe('true');
  expect((bold as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(editor, { key: 'Enter' });
  expect(send).toHaveBeenCalledOnce();
  await act(async () => { finish(); await submitted; });
  expect(screen.getByRole('textbox', { name: 'Message general' })).toBe(editor);
  expect(editor.textContent?.trim()).toBe('');
  expect(document.activeElement).toBe(editor);
  expect(container.querySelector('.sp-rich-composer')?.hasAttribute('aria-busy')).toBe(false);
});
it('preserves the draft and restores controls when sending fails', async () => {
  let fail!: (reason: Error) => void;
  const submitted = new Promise<void>((_, reject) => { fail = reject; });
  render(<RichComposer channel="general" onSend={() => submitted} />);
  const editor = await screen.findByRole('textbox', { name: 'Message general' });
  await userEvent.type(editor, 'Keep this draft');
  fireEvent.keyDown(editor, { key: 'Enter' });
  await act(async () => { fail(new Error('offline')); await submitted.catch(() => {}); });
  expect(editor.textContent).toContain('Keep this draft');
  expect(editor.getAttribute('contenteditable')).toBe('true');
  expect(screen.getByRole('alert').textContent).toContain('Your draft is still here');
  expect((screen.getByRole('button', { name: 'Bold', exact: true }) as HTMLButtonElement).disabled).toBe(false);
});

it.each([false,true])('does not steal focus after a delayed send: failed=%s',async failed=>{
  let finish!:()=>void, fail!:(reason:Error)=>void;
  const submitted=new Promise<void>((resolve,reject)=>{finish=resolve;fail=reject;});
  render(<><RichComposer channel="general" onSend={()=>submitted}/><input aria-label="Find a conversation"/></>);
  const editor=await screen.findByRole('textbox',{name:'Message general'});
  await userEvent.type(editor,'Delayed message');
  fireEvent.keyDown(editor,{key:'Enter'});
  const search=screen.getByRole('textbox',{name:'Find a conversation'});
  await userEvent.type(search,'another channel');
  expect(document.activeElement).toBe(search);
  await act(async()=>{if(failed)fail(new Error('offline'));else finish();await submitted.catch(()=>{});});
  expect(document.activeElement).toBe(search);
});
it('enforces a smaller session message limit while keeping its draft',async()=>{
 const send=vi.fn();render(<RichComposer channel="agent session" maxLength={4} onSend={send}/>);
 const editor=await screen.findByRole('textbox',{name:'Message agent session'});
 await userEvent.type(editor,'12345');fireEvent.keyDown(editor,{key:'Enter'});
 expect(screen.getByRole('alert').textContent).toContain('under 4 characters');expect(send).not.toHaveBeenCalled();expect(editor.textContent).toContain('12345');
});

it('supports identity-backed mention references in a plain session composer without formatting controls',async()=>{
 const send=vi.fn(),agent={kind:'agent' as const,id:'00000000-0000-4000-8000-000000000099',label:'Helper',detail:'Agent'};
 render(<RichComposer channel="agent session" plainText findMentions={async()=>({items:[agent],member_count:2})} onSend={send}/>);
 await screen.findByRole('textbox',{name:'Message agent session'});
 await userEvent.click(screen.getByRole('button',{name:'Mention someone'}));
 await userEvent.click(await screen.findByRole('option',{name:/Helper/}));
 const editor=screen.getByRole('textbox',{name:'Message agent session'});
 expect(editor.querySelector('[data-mention-kind="agent"]')).not.toBeNull();
 expect(screen.queryByRole('button',{name:'Bold',exact:true})).toBeNull();
 fireEvent.keyDown(editor,{key:'Enter'});
 expect(send).toHaveBeenCalledWith('@Helper',expect.objectContaining({ops:expect.arrayContaining([expect.objectContaining({attributes:expect.objectContaining({mention:expect.objectContaining({kind:'agent',id:agent.id})})})])}),[]);
});
it.each([false,true])('opens mention suggestions when typing @ and filters as typing continues: plainText=%s',async plainText=>{
 const find=vi.fn(async()=>({items:[{kind:'user' as const,id:'00000000-0000-4000-8000-000000000001',label:'Kai',detail:'Member'}],member_count:2}));
 render(<RichComposer channel="hi" plainText={plainText} findMentions={find} onSend={vi.fn()}/>);
 const editor=await screen.findByRole('textbox',{name:'Message hi'});
 await userEvent.type(editor,'@');
 expect(await screen.findByRole('option',{name:/Kai/})).toBeTruthy();
 expect(find).toHaveBeenCalledWith('');
 expect(editor.getAttribute('aria-expanded')).toBe('true');
 await userEvent.keyboard('Kai');
 await screen.findByRole('option',{name:/Kai/});
 expect(find).toHaveBeenLastCalledWith('Kai');
 await userEvent.keyboard('{Escape}');
 expect(screen.queryByRole('listbox',{name:'Mention suggestions'})).toBeNull();
 expect(editor.textContent).toContain('@Kai');
});

it('keeps the highlighted mention in sync with pointer and keyboard selection',async()=>{
 const send=vi.fn();
 const items=[{kind:'user' as const,id:'00000000-0000-4000-8000-000000000001',label:'Kai',detail:'Member'}, {kind:'agent' as const,id:'00000000-0000-4000-8000-000000000002',label:'Helper',detail:'Agent'}];
 render(<RichComposer channel="hi" findMentions={async()=>({items,member_count:2})} onSend={send}/>);
 const editor=await screen.findByRole('textbox',{name:'Message hi'});
 await userEvent.type(editor,'@');
 const helper=await screen.findByRole('option',{name:/Helper/});
 fireEvent.pointerMove(helper);
 expect(helper.getAttribute('aria-selected')).toBe('true');
 expect(editor.getAttribute('aria-activedescendant')).toBe(helper.id);
 await userEvent.keyboard('{Enter}');
 expect(send).not.toHaveBeenCalled();
 expect(editor.textContent).toContain('@Helper');
 expect(screen.queryByRole('listbox',{name:'Mention suggestions'})).toBeNull();
});

it('can hide unavailable actions while preserving editing controls', async () => {
  render(<RichComposer channel="Alex" showUnavailableActions={false} onSend={() => {}} />);
  await screen.findByRole('textbox', { name: 'Message Alex' });
  expect(screen.getByRole('button', { name: 'Bold', exact: true })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /recording unavailable/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /Run shortcut/ })).toBeNull();
});

it('updates conversation labels without replacing the editor or losing its current draft', async () => {
  const initial = { ops: [{ insert: 'Initial draft\n' }] };
  const view = render(<RichComposer channel="Before" placeholder="Message Before" defaultValue={initial} onSend={() => {}} />);
  const before = await screen.findByRole('textbox', { name: 'Message Before' });
  await userEvent.type(before, ' More unsent text');
  const typed = before.textContent;
  view.rerender(<RichComposer channel="After" placeholder="Message After" defaultValue={{ ops: [{ insert: typed! }] }} onSend={() => {}} />);
  const after = await screen.findByRole('textbox', { name: 'Message After' });
  expect(after).toBe(before);
  expect(after.textContent).toBe(typed);
  expect(after.getAttribute('data-placeholder')).toBe('Message After');
  expect(document.activeElement).toBe(after);
});
it('keeps an in-flight send pending while the conversation label changes', async () => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const send = vi.fn(() => pending);
  const view = render(<RichComposer channel="Before" onSend={send} />);
  const editor = await screen.findByRole('textbox', { name: 'Message Before' });
  await userEvent.type(editor, 'Only send once');
  fireEvent.keyDown(editor, { key: 'Enter' });
  view.rerender(<RichComposer channel="After" onSend={send} />);
  const after = await screen.findByRole('textbox', { name: 'Message After' });
  expect(after).toBe(editor);
  expect(after.getAttribute('contenteditable')).toBe('false');
  fireEvent.keyDown(after, { key: 'Enter' });
  expect(send).toHaveBeenCalledOnce();
  await act(async () => { finish(); await pending; });
  await waitFor(() => expect(after.textContent?.trim()).toBe(''));
});

it('offers a reply only on focus and accepts it with Tab as an ordinary draft', async () => {
  const load = vi.fn(async () => 'Could you share the link?');
  const send = vi.fn(), draft = vi.fn();
  render(<RichComposer channel="thread" loadReplySuggestion={load} onDraftChange={draft} onSend={send} />);
  const editor = await screen.findByRole('textbox', { name: 'Message thread' });
  expect(load).not.toHaveBeenCalled();
  await userEvent.click(editor);
  await screen.findByText('Tab to accept');
  expect(editor.textContent?.trim()).toBe('');
  expect(draft).not.toHaveBeenCalled();
  expect((screen.getByRole('button', { name: 'Send now' }) as HTMLButtonElement).disabled).toBe(true);
  await userEvent.keyboard('{Tab}');
  expect(editor.textContent).toBe('Could you share the link?');
  expect(draft).toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  await userEvent.keyboard(' Thanks!{Enter}');
  expect(send).toHaveBeenCalledWith('Could you share the link? Thanks!', expect.anything(), []);
});

it('discards a late suggestion after a newer reply or typing', async () => {
  let finishOld!: (value: string) => void, finishNew!: (value: string) => void;
  const old = vi.fn(() => new Promise<string>(resolve => { finishOld = resolve; }));
  const next = vi.fn(() => new Promise<string>(resolve => { finishNew = resolve; }));
  const composer = (load: () => Promise<string>) => <RichComposer channel="thread" loadReplySuggestion={load} onSend={vi.fn()} />;
  const view = render(composer(old));
  const editor = await screen.findByRole('textbox', { name: 'Message thread' });
  await userEvent.click(editor);
  await waitFor(() => expect(old).toHaveBeenCalledOnce());
  view.rerender(composer(next));
  await waitFor(() => expect(next).toHaveBeenCalledOnce());
  await act(async () => finishOld('Outdated'));
  expect(screen.queryByText('Tab to accept')).toBeNull();
  await userEvent.type(editor, 'My reply');
  await act(async () => finishNew('Late'));
  expect(screen.queryByText('Tab to accept')).toBeNull();
  expect(editor.textContent).toBe('My reply');
});

it.each(['channel', 'thread'] as const)('uses %s scope for broadcasts regardless of the editor label', async scope => {
  const send = vi.fn();
  const find = async () => ({ items: [{kind:'broadcast' as const, id:'channel', label:'channel', detail:'Everyone'}], member_count:6 });
  render(<RichComposer channel="thread" scope={scope} findMentions={find} onSend={send}/>);
  const editor = await screen.findByRole('textbox', {name:'Message thread'});
  await userEvent.click(screen.getByRole('button', {name:'Mention someone'}));
  await userEvent.click(await screen.findByRole('option', {name:/channel/i}));
  fireEvent.keyDown(editor, {key:'Enter'});
  if (scope === 'channel') {
    expect(send).not.toHaveBeenCalled();
    await userEvent.click(await screen.findByRole('button', {name:'Send and notify'}));
    expect(send.mock.calls[0]?.[3]).toEqual({broadcast_confirmed:true});
  }
  expect(send).toHaveBeenCalledOnce();
});
