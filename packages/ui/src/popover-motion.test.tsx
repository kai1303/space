import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Menu, Popover } from './primitives.js';

afterEach(cleanup);
it.each([false, true])('retains the exiting menu, makes it inert, and restores focus (portal: %s)', async floating => {
  const select = vi.fn();
  render(<Menu label="Actions" floating={floating} items={[{ label: 'Choose', onSelect: select }]} />);
  const trigger = screen.getByRole('button', { name: 'Actions' });
  fireEvent.click(trigger);
  const panel = screen.getByRole('menu');
  fireEvent.click(screen.getByRole('menuitem', { name: 'Choose' }));
  expect(select).toHaveBeenCalledOnce();
  expect(panel.isConnected).toBe(true);
  expect(panel.hasAttribute('inert')).toBe(true);
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  await waitFor(() => expect(panel.isConnected).toBe(false));
  await waitFor(() => expect(trigger.closest('details')?.open).toBe(false));
});
it('can reopen during exit, dismiss with Escape, and close on outside click', async () => {
  render(<Popover label="Emoji" trigger="Open">{close => <button onClick={close}>Pick</button>}</Popover>);
  const trigger = screen.getByRole('button', { name: 'Emoji' });
  fireEvent.click(trigger);
  fireEvent.click(trigger);
  fireEvent.click(trigger);
  expect(screen.getByRole('button', { name: 'Pick' })).toBeTruthy();
  fireEvent.keyDown(screen.getByRole('button', { name: 'Pick' }), { key: 'Escape' });
  expect(document.activeElement).toBe(trigger);
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(trigger);
  fireEvent.pointerDown(document.body);
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
});

it('repositions a floating menu when its content grows near the viewport edge', async () => {
  let resize: ResizeObserverCallback | undefined, height = 100;
  const viewportHeight = window.innerHeight;
  vi.stubGlobal('ResizeObserver', class { constructor(callback: ResizeObserverCallback) { resize = callback; } observe() {} disconnect() {} });
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    return { left: 100, right: 200, top: 250, bottom: 280, width: 100, height: this.getAttribute('role') === 'menu' ? height : 30, x:100,y:250,toJSON(){} };
  });
  Object.defineProperty(window,'innerHeight',{configurable:true,value:400});
  try {
    render(<Menu label="Growing menu" floating items={[{label:'Item',onSelect:()=>{}}]} />);
    fireEvent.click(screen.getByRole('button',{name:'Growing menu'}));
    const panel=screen.getByRole('menu');
    expect(panel.style.top).toBe('286px');
    expect(resize).toBeTypeOf('function');
    height=300;
    act(()=>resize!([],{} as ResizeObserver));
    expect(panel.style.top).toBe('8px');
  } finally { rect.mockRestore(); vi.unstubAllGlobals(); Object.defineProperty(window,'innerHeight',{configurable:true,value:viewportHeight}); }
});
