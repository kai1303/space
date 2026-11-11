import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatShell } from './ChatShell.js';
import { WorkspaceActions } from './WorkspaceActions.js';

vi.mock('../../features/auth/AuthScreen.js', () => ({ SignOutButton: () => <button>Sign out</button> }));
const motionPreference=vi.hoisted(()=>({reduced:false}));
vi.mock('motion/react',async original=>({...await original<typeof import('motion/react')>(),useReducedMotion:()=>motionPreference.reduced}));
afterEach(()=>{cleanup();motionPreference.reduced=false;});
const workspaces = [{ id: 'one', name: 'Team' }, { id: 'two', name: 'Another team' }];

it('opens the personal browser from the desktop top bar', async () => {
  const openBrowser = vi.fn();
  vi.stubGlobal('spaceDesktop', { openBrowser });
  try {
    render(<ChatShell name="Team" user="Kai"><main>Conversation</main></ChatShell>);
    await userEvent.click(screen.getByRole('button', { name: 'Open browser' }));
    expect(openBrowser).toHaveBeenCalledOnce();
  } finally { vi.unstubAllGlobals(); }
});

it('opens workspace actions from the name and keeps switching in the rail', async () => {
  const members = vi.fn(), settings = vi.fn();
  render(<WorkspaceActions workspace={workspaces[0]!} onMembers={members} onSettings={settings}/>);
  const trigger = screen.getByRole('button', { name: 'Team Actions' });
  trigger.focus();
  await userEvent.keyboard('{ArrowDown}');
  const invite = await screen.findByRole('menuitem', { name: 'Invite people to Team' });
  await waitFor(() => expect(document.activeElement).toBe(invite));
  expect(screen.getByText(`${window.location.host}/chat?workspace=one`)).toBeTruthy();
  expect(screen.queryByRole('menuitem', { name: 'Team' })).toBeNull();
  await userEvent.click(screen.getByRole('menuitem', { name: 'Workspace members' }));
  expect(members).toHaveBeenCalledOnce();
  await userEvent.click(trigger);
  await userEvent.click(screen.getByRole('menuitem', { name: 'Workspace settings' }));
  expect(settings).toHaveBeenCalledOnce();
});

it('opens workspace switching from the rail and connects navigation history controls', async () => {
  const change = vi.fn(), back = vi.fn(), forward = vi.fn(), visit = vi.fn();
  render(<ChatShell name="Team" user="Kai" workspaces={workspaces} workspace="one" onWorkspaceChange={change} onBack={back} onForward={forward} history={[{ label: '#general · Team', onSelect: visit }]}><main>Conversation</main></ChatShell>);
  await userEvent.click(screen.getByRole('button', { name: 'Switch workspaces… (Team)' }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Another team' }));
  expect(change).toHaveBeenCalledWith('two');
  await userEvent.click(screen.getByRole('button', { name: 'Back in history' }));
  await userEvent.click(screen.getByRole('button', { name: 'Forward in history' }));
  expect(back).toHaveBeenCalledOnce(); expect(forward).toHaveBeenCalledOnce();
  await userEvent.click(screen.getByRole('button', { name: 'Show history' }));
  await userEvent.click(screen.getByRole('menuitem', { name: '#general · Team' }));
  expect(visit).toHaveBeenCalledOnce();
});

it('matches the eight-item rail while keeping search in the topbar and Admin as a menu', async () => {
  const navigate = vi.fn(), manage = vi.fn();
  render(<ChatShell name="Team" user="Kai" onHome={() => {}} onDirectMessages={() => {}} onActivity={() => {}} onSearch={() => {}} onMembers={() => {}} onNavigate={navigate} activeDestination="files" adminItems={[{label:'Manage members',onSelect:manage}]}><main>Files</main></ChatShell>);
  const rail = screen.getByRole('navigation', {name:'Main navigation'});
  const {within} = await import('@testing-library/react');
  for (const name of ['Spacebot','DMs','Activity','Files','To-dos','Agents & tools','Admin']) expect(within(rail).getByRole('button',{name,exact:true})).toBeTruthy();
  expect(within(rail).getByRole('link',{name:'Home'}).getAttribute('aria-current')).toBeNull();
  expect(within(rail).queryByRole('button',{name:'Search',exact:true})).toBeNull();
  expect(within(rail).queryByRole('button',{name:'Members',exact:true})).toBeNull();
  expect(screen.getByRole('button',{name:'Files',exact:true}).getAttribute('aria-current')).toBe('page');
  await userEvent.click(screen.getByRole('button',{name:'Agents & tools',exact:true}));
  expect(navigate).toHaveBeenCalledWith('agents');
  await userEvent.click(screen.getByRole('button',{name:'Admin',exact:true}));
  await userEvent.click(screen.getByRole('menuitem',{name:'Manage members'}));
  expect(manage).toHaveBeenCalledOnce();
});

it('moves one active highlight between rail icons without replacing navigation controls',()=>{
 const props={name:'Team',user:'Kai',onHome:()=>{},onDirectMessages:()=>{},onActivity:()=>{},onNavigate:()=>{}};
 const view=render(<ChatShell {...props}><main>Home</main></ChatShell>);
 const home=screen.getByRole('link',{name:'Home',exact:true}),dms=screen.getByRole('button',{name:'DMs',exact:true});
 expect(home.querySelector('.chat-rail-active')).toBeTruthy();
 view.rerender(<ChatShell {...props} directMessagesActive><main>DMs</main></ChatShell>);
 expect(screen.getByRole('link',{name:'Home',exact:true})).toBe(home);
 expect(screen.getByRole('button',{name:'DMs',exact:true})).toBe(dms);
 expect(home.querySelector('.chat-rail-active')).toBeNull();expect(dms.querySelector('.chat-rail-active')).toBeTruthy();
 expect(view.container.querySelectorAll('[aria-current="page"] .chat-rail-active')).toHaveLength(1);
 const highlight=dms.querySelector('.chat-rail-active');
 view.rerender(<ChatShell {...props} directMessagesActive notificationCount={3}><main>DMs update</main></ChatShell>);
 expect(dms.querySelector('.chat-rail-active')).toBe(highlight);
 expect(highlight?.getAttribute('aria-hidden')).toBe('true');
});

it('uses an immediate highlight when reduced motion is requested',()=>{
 motionPreference.reduced=true;
 const props={name:'Team',user:'Kai',onHome:()=>{},onActivity:()=>{}};
 const view=render(<ChatShell {...props}><main>Home</main></ChatShell>);
 view.rerender(<ChatShell {...props} activityActive><main>Activity</main></ChatShell>);
 const highlight=screen.getByRole('button',{name:'Activity',exact:true}).querySelector('.chat-rail-active') as HTMLElement;
 expect(highlight).toBeTruthy();expect(highlight.style.transform).toBe('');expect(highlight.getAnimations?.()??[]).toHaveLength(0);
 expect(screen.getByRole('link',{name:'Home',exact:true}).querySelector('.chat-rail-active')).toBeNull();
});

it('expands the phone tab bar with More and collapses it after choosing a destination', async () => {
  const navigate = vi.fn();
  render(<ChatShell name="Team" user="Kai" onHome={() => {}} onDirectMessages={() => {}} onActivity={() => {}} onNavigate={navigate}><main>Home</main></ChatShell>);
  const rail = screen.getByRole('navigation', { name: 'Main navigation' });
  const more = screen.getByRole('button', { name: 'More', exact: true });
  expect(more.getAttribute('aria-expanded')).toBe('false');
  await userEvent.click(more);
  expect(more.getAttribute('aria-expanded')).toBe('true');
  expect(rail.classList.contains('chat-rail--more-open')).toBe(true);
  await userEvent.click(screen.getByRole('button', { name: 'Files', exact: true }));
  expect(navigate).toHaveBeenCalledWith('files');
  expect(more.getAttribute('aria-expanded')).toBe('false');
  await userEvent.click(more);
  await userEvent.keyboard('{Escape}');
  expect(more.getAttribute('aria-expanded')).toBe('false');
});

it('on phones makes Home the conversation list, offers a way back to it and moves the account to the top bar', async () => {
  const media = { matches: true, addEventListener: () => {}, removeEventListener: () => {} };
  vi.stubGlobal('matchMedia', vi.fn(() => media));
  try {
    const { ConversationListContext } = await import('../../shared/ui/conversation-list.js');
    const { useContext } = await import('react');
    function Back() { const open = useContext(ConversationListContext); return open ? <button onClick={open}>Back to conversations</button> : null; }
    const props = { name: 'Team', user: 'Kai', onHome: vi.fn(), onDirectMessages: () => {}, onActivity: () => {} };
    const view = render(<ChatShell {...props} directMessagesActive><Back/></ChatShell>);
    const app = view.container.querySelector('.chat-app')!;
    expect(app.classList.contains('chat-app--sidebar-open')).toBe(false);
    expect(view.container.querySelector('.chat-phone-account')).toBeTruthy();
    expect(view.container.querySelector('.chat-rail-bottom .space-user-settings')).toBeNull();
    await userEvent.click(screen.getByRole('link', { name: 'Home', exact: true }));
    expect(props.onHome).toHaveBeenCalledOnce();
    view.rerender(<ChatShell {...props}><Back/></ChatShell>);
    expect(app.classList.contains('chat-app--sidebar-open')).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Back to conversations' }));
    expect(app.classList.contains('chat-app--sidebar-open')).toBe(true);
  } finally { vi.unstubAllGlobals(); }
});

it('keeps the desktop layout without a back button or a top bar account', () => {
  const view = render(<ChatShell name="Team" user="Kai" onHome={() => {}}><main>Home</main></ChatShell>);
  expect(view.container.querySelector('.chat-phone-account')).toBeNull();
  expect(view.container.querySelector('.chat-rail-bottom .space-user-settings')).toBeTruthy();
});

it('on phones a swipe from the left edge presses the top screen back button', async () => {
  const media = { matches: true, addEventListener: () => {}, removeEventListener: () => {} };
  vi.stubGlobal('matchMedia', vi.fn(() => media));
  try {
    const { fireEvent } = await import('@testing-library/react');
    const channelBack = vi.fn(), threadBack = vi.fn();
    const view = render(<ChatShell name="Team" user="Kai" onHome={() => {}}><main>
      <button className="chat-conversation-back" onClick={channelBack}>Back to conversations</button>
      <button className="chat-conversation-back" onClick={threadBack}>Back to #general</button>
    </main></ChatShell>);
    for (const button of view.container.querySelectorAll('.chat-conversation-back')) button.getClientRects = () => [{}] as unknown as DOMRectList;
    const app = view.container.querySelector('.chat-app')!;
    const swipe = (x0: number, x1: number, dy = 0) => {
      fireEvent.touchStart(app, { touches: [{ clientX: x0, clientY: 300 }] });
      fireEvent.touchEnd(app, { changedTouches: [{ clientX: x1, clientY: 300 + dy }] });
    };
    swipe(120, 260);
    swipe(8, 40);
    swipe(8, 200, 90);
    expect(threadBack).not.toHaveBeenCalled();
    swipe(8, 200);
    expect(threadBack).toHaveBeenCalledOnce();
    expect(channelBack).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});
