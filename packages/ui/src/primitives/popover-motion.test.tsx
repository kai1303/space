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

it('leaves text editing keys and Tab navigation inside a form popover alone', async () => {
  const user = (await import('@testing-library/user-event')).default;
  render(<Popover label="Filter form" floating trigger="Filter">{()=> <><input aria-label="Filter text"/><button>Apply filter</button></>}</Popover>);
  fireEvent.click(screen.getByRole('button',{name:'Filter form'}));
  const input=screen.getByRole('textbox',{name:'Filter text'});
  input.focus();
  expect(fireEvent.keyDown(input,{key:'Home'})).toBe(true);
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole('button',{name:'Apply filter'}));
  expect(screen.getByRole('button',{name:'Filter form'}).getAttribute('aria-expanded')).toBe('true');
});

it('dismisses when keyboard focus moves outside and skips disabled menu actions', async () => {
  render(<><Popover label="Account actions" role="menu" floating trigger="Account">{()=> <><button disabled role="menuitem">Unavailable</button><button role="menuitem">Available</button></>}</Popover><button>Outside</button></>);
  const trigger=screen.getByRole('button',{name:'Account actions'});
  fireEvent.keyDown(trigger,{key:'ArrowDown'});
  await waitFor(()=>expect(document.activeElement).toBe(screen.getByRole('menuitem',{name:'Available'})));
  act(()=>screen.getByRole('button',{name:'Outside'}).focus());
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
});

it('positions using layout dimensions instead of the animated scale',()=>{
  const rect=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(){return {left:200,right:300,top:100,bottom:130,width:90,height:90,x:200,y:100,toJSON(){}};});
  const width=vi.spyOn(HTMLElement.prototype,'offsetWidth','get').mockReturnValue(100);
  const height=vi.spyOn(HTMLElement.prototype,'offsetHeight','get').mockReturnValue(100);
  try{
    render(<Menu label="Stable menu" floating items={[{label:'One',onSelect:()=>{}}]}/>);
    fireEvent.click(screen.getByRole('button',{name:'Stable menu'}));
    expect(screen.getByRole('menu').style.left).toBe('200px');
  }finally{rect.mockRestore();width.mockRestore();height.mockRestore();}
});
