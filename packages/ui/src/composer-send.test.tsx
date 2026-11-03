import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RichComposer } from './rich-composer.js';

beforeAll(() => {
  Object.defineProperties(Range.prototype, {
    getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
    getClientRects: { configurable: true, value: () => [] },
  });
});
afterEach(cleanup);
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
