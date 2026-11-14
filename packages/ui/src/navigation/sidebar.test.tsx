import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceSidebar } from "./sidebar.js";

afterEach(cleanup);
it("shows only one sidebar create action when all sections are empty", () => {
  render(<WorkspaceSidebar workspace="Team" selectedId="" width={385} onWidthChange={() => {}} onSelect={() => {}} onCreateChannel={() => {}} showEmptySections footer={false} channels={[]} />);
  expect(screen.getAllByRole("button", { name: /Add channel/ })).toHaveLength(1);
});
it("can show Slack's empty sidebar sections without a duplicate profile footer", async () => {
  const compose = vi.fn();
  render(<WorkspaceSidebar workspace="Team" selectedId="general" width={385} onWidthChange={() => {}} onSelect={() => {}} onNewMessage={compose} showEmptySections footer={false} channels={[{ id: "general", name: "general", section: "channels" }]} />);
  for (const name of ["Starred", "Channels", "Direct messages", "Apps"]) expect(screen.getByRole("button", { name, exact: true })).toBeTruthy();
  expect(screen.queryByText("LOCAL DEMO")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "New message", exact: true }));
  expect(compose).toHaveBeenCalledOnce();
  await userEvent.type(screen.getByRole("searchbox", { name: "Find a conversation" }), "general");
  expect(screen.queryByRole("button", { name: "Apps", exact: true })).toBeNull();
  expect(screen.getByRole("button", { name: "general", exact: true })).toBeTruthy();
});
it("filters sidebar conversations and hides every item when collapsed", async () => {
  render(
    <WorkspaceSidebar
      workspace="Space studio"
      selectedId="design"
      onSelect={() => {}}
      width={280}
      onWidthChange={() => {}}
      channels={[
        { id: "design", name: "design", section: "channels" },
        { id: "engineering", name: "engineering", section: "channels" },
      ]}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Channels", exact: true }),
  );
  expect(
    screen.queryByRole("button", { name: "design", exact: true }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: "engineering", exact: true }),
  ).toBeNull();
  await userEvent.type(
    screen.getByRole("searchbox", { name: "Find a conversation" }),
    "engineer",
  );
  expect(
    screen.getByRole("button", { name: "engineering", exact: true }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "design", exact: true }),
  ).toBeNull();
});
it("collapses the selected channel and Add channel together without changing selection", async () => {
  const select = vi.fn();
  render(<WorkspaceSidebar workspace="Team" selectedId="general" width={220} onWidthChange={() => {}} onSelect={select} onCreateChannel={() => {}} channels={[{ id: "general", name: "general", section: "channels" }]} />);
  const toggle = screen.getByRole("button", { name: "Channels", exact: true });
  await userEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("button", { name: "general", exact: true })).toBeNull();
  expect(screen.queryByRole("button", { name: /Add channel/ })).toBeNull();
  expect(select).not.toHaveBeenCalled();
  await userEvent.keyboard("{Enter}");
  expect(screen.getByRole("button", { name: "general", exact: true }).getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("button", { name: /Add channel/ })).toBeTruthy();
  await userEvent.keyboard(" ");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("button", { name: "general", exact: true })).toBeNull();
});
it("resizes the sidebar through keyboard controls with observed bounds", () => {
  const widths: number[] = [];
  render(
    <WorkspaceSidebar
      workspace="Space studio"
      selectedId="design"
      onSelect={() => {}}
      channels={[]}
      width={280}
      onWidthChange={(width) => widths.push(width)}
    />,
  );
  const separator = screen.getByRole("separator", { name: "Sidebar width" });
  fireEvent.keyDown(separator, { key: "ArrowRight" });
  fireEvent.keyDown(separator, { key: "Home" });
  fireEvent.keyDown(separator, { key: "End" });
  expect(widths).toEqual([290, 180, 450]);
});

it("remembers sidebar filters and collapsed sections separately for each workspace", async () => {
  const props = { workspace: "Team", selectedId: "general", width: 385, onWidthChange: () => {}, onSelect: () => {}, showEmptySections: true, footer: false as const, channels: [{ id: "general", name: "general", section: "channels" as const }] };
  const view = render(<WorkspaceSidebar {...props} workspaceId="a" />);
  const input = screen.getByRole("searchbox", { name: "Find a conversation" }) as HTMLInputElement;
  await userEvent.click(screen.getByRole("button", { name: "Channels", exact: true }));
  expect(screen.getByRole("button", { name: "Channels", exact: true }).getAttribute("aria-expanded")).toBe("false");
  view.rerender(<WorkspaceSidebar {...props} workspaceId="b" />);
  expect(screen.getByRole("button", { name: "Channels", exact: true }).getAttribute("aria-expanded")).toBe("true");
  await userEvent.type(input, "other");
  view.rerender(<WorkspaceSidebar {...props} workspaceId="a" />);
  expect(screen.getByRole("searchbox", { name: "Find a conversation" })).toBe(input);
  expect(input.value).toBe("");
  expect(screen.getByRole("button", { name: "Channels", exact: true }).getAttribute("aria-expanded")).toBe("false");
  view.rerender(<WorkspaceSidebar {...props} workspaceId="b" />);
  expect(input.value).toBe("other");
});
it('exposes all Home shortcuts and marks the selected shortcut', async () => {
  const threads = vi.fn(), huddles = vi.fn(), drafts = vi.fn(), saved = vi.fn(), directories = vi.fn();
  render(<WorkspaceSidebar workspace="Team" channels={[]} selectedId="" width={240} onWidthChange={() => {}} onSelect={() => {}} onThreads={threads} onHuddles={huddles} onDrafts={drafts} onSaved={saved} onDirectories={directories} selectedShortcut="saved"/>);
  for (const [name, handler] of [['Threads',threads],['Huddles',huddles],['Drafts & sent',drafts],['Saved',saved],['Directories',directories]] as const) {
    await userEvent.click(screen.getByRole('button',{name,exact:true}));
    expect(handler).toHaveBeenCalledOnce();
  }
  expect(screen.getByRole('button',{name:'Saved',exact:true}).getAttribute('aria-current')).toBe('page');
});

it('uses the agent avatar for sessions in both regular and starred sections',()=>{
 const props={workspace:'Team',selectedId:'session:one',width:280,onWidthChange:()=>{},onSelect:()=>{}};
 const {rerender}=render(<WorkspaceSidebar {...props} channels={[{id:'session:one',name:'Review README',section:'sessions',agentName:'Local Codex'}]}/>);
 expect(screen.getByRole('button',{name:'Review README'}).querySelector('.sp-avatar')?.textContent).toBe('LO');
 rerender(<WorkspaceSidebar {...props} channels={[{id:'session:one',name:'Review README',section:'starred',agentName:'Local Codex'}]}/>);
 expect(screen.getByRole('button',{name:'Review README'}).querySelector('.sp-avatar')?.textContent).toBe('LO');
});

it("opens a channel context menu with the pointer or keyboard without navigating", async () => {
  const select = vi.fn(), details = vi.fn();
  render(<WorkspaceSidebar workspace="Team" selectedId="general" width={220} onWidthChange={() => {}} onSelect={select}
    channels={[{ id:"general", name:"general", section:"channels" }, { id:"builds", name:"builds", section:"starred", actions:[
      {label:"Channel details",select:details},
      {label:"Copy",items:[{label:"Copy link",select:vi.fn()}]},
      {label:"Unstar channel",select:vi.fn()},
    ] }]} />);
  const row = screen.getByRole("button", {name:"builds"});
  fireEvent.contextMenu(row);
  await userEvent.click(await screen.findByRole("menuitem", {name:"Channel details"}));
  expect(screen.queryByRole("button", {name:"Actions for builds"})).toBeNull();
  row.focus();
  await userEvent.keyboard("{Shift>}{F10}{/Shift}");
  expect(document.activeElement).toBe(screen.getByRole("menuitem", {name:"Channel details"}));
  await userEvent.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(screen.getByRole("menuitem", {name:"Copy",exact:true}));
  await userEvent.keyboard("{ArrowRight}");
  expect(document.activeElement).toBe(screen.getByRole("menuitem", {name:"Copy link"}));
  await userEvent.keyboard("{ArrowLeft}");
  expect(document.activeElement).toBe(screen.getByRole("menuitem", {name:"Copy",exact:true}));
  await userEvent.keyboard("{Escape}");
  expect(document.activeElement).toBe(row);
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.keyDown(row, { key: "ContextMenu" });
  await userEvent.click(await screen.findByRole("menuitem", {name:"Channel details"}));
  expect(details).toHaveBeenCalledTimes(2);
  expect(select).not.toHaveBeenCalled();
  await userEvent.click(row);
  expect(select).toHaveBeenCalledWith("builds");
});

it("streams only changed session titles and exposes the full name during the reveal", () => {
  vi.useFakeTimers();
  try {
    const sidebar = (name: string) => <WorkspaceSidebar workspace="Team" selectedId="" width={385}
      onWidthChange={()=>{}} onSelect={()=>{}} channels={[{id:'session:one',name,section:'sessions',agentName:'Codex'}]}/>;
    const view = render(sidebar('Original title'));
    expect(screen.getByRole('button',{name:'Original title'}).querySelector('.sp-agent-word')).toBeNull();
    view.rerender(sidebar('Review the upload changes'));
    const button = screen.getByRole('button',{name:'Review the upload changes'});
    act(()=>vi.advanceTimersByTime(80));
    const word = button.querySelector('.sp-agent-word');
    expect(word).toBeTruthy();
    view.rerender(sidebar('Review the upload changes'));
    expect(button.querySelector('.sp-agent-word')).toBe(word);
    view.rerender(sidebar('Revised [literal] title'));
    act(()=>vi.advanceTimersByTime(500));
    act(()=>vi.advanceTimersByTime(750));
    expect(button.querySelector('.sp-channel-name')?.textContent).toBe('Revised [literal] title');
    expect(button.querySelector('.sp-agent-word')).toBeNull();
  } finally { vi.useRealTimers(); }
});

it('moves a dragged session relative to the drop row and exposes archive in its actions', async () => {
  const move = vi.fn(), archive = vi.fn(), select = vi.fn();
  render(<WorkspaceSidebar workspace="Team" selectedId="" width={240} onWidthChange={() => {}} onSelect={select}
    channels={['First','Second'].map(name => ({id:name,name,agentName:'Codex',section:'sessions',
      onMove:move,actions:[{label:'Archive session',select:archive}]}))}/>);
  const source = screen.getByRole('button',{name:'First',exact:true}).closest('[draggable]')!;
  const target = screen.getByRole('button',{name:'Second',exact:true}).closest('[draggable]')!;
  const dataTransfer = {setData:vi.fn(),effectAllowed:'',dropEffect:''};
  fireEvent.dragStart(source,{dataTransfer});
  fireEvent.dragOver(target,{dataTransfer});
  fireEvent.drop(target,{dataTransfer});
  expect(move).toHaveBeenCalledWith('Second','after');
  expect(screen.queryByRole('button',{name:'Actions for First'})).toBeNull();
  screen.getByRole('button',{name:'First',exact:true}).focus();
  await userEvent.keyboard('{Shift>}{F10}{/Shift}');
  await userEvent.click(screen.getByRole('menuitem',{name:'Archive session'}));
  expect(archive).toHaveBeenCalledOnce();
  expect(select).not.toHaveBeenCalled();
});

it('previews a move across batches, cancels it, and commits only on drop', async () => {
  const move = vi.fn(), names = ['A','B','C','D','E','F','G'];
  render(<WorkspaceSidebar workspace="Team" selectedId="" width={240} onWidthChange={() => {}} onSelect={() => {}}
    sessionBatchSize={5} channels={names.map(id => ({id,name:id,section:'sessions',onMove:move}))}/>);
  const slots = names.map(name => screen.getByRole('button',{name,exact:true}).closest<HTMLElement>('[draggable]')!);
  slots.forEach((slot,index) => vi.spyOn(slot,'getBoundingClientRect').mockReturnValue(new DOMRect(0,index*28,200,28)));
  const dataTransfer = {setData:vi.fn(),effectAllowed:'',dropEffect:''};
  const source = slots[1]!, target = slots[6]!;
  const hover = () => {
    const event = new MouseEvent('dragover',{clientY:192,bubbles:true,cancelable:true});
    Object.defineProperty(event,'dataTransfer',{value:dataTransfer});
    fireEvent(target,event);
  };
  fireEvent.dragStart(source,{dataTransfer});
  hover();
  const neighbor = slots[5]!.firstElementChild as HTMLElement;
  await waitFor(() => expect(neighbor.style.transform).toContain('translateY(-28px)'));
  expect(move).not.toHaveBeenCalled();
  fireEvent.dragEnd(source);
  await waitFor(() => expect(neighbor.style.transform).toBe('none'));
  expect(move).not.toHaveBeenCalled();
  fireEvent.dragStart(source,{dataTransfer});
  hover();
  const drop = new MouseEvent('drop',{clientY:192,bubbles:true,cancelable:true});
  await act(async () => { fireEvent(target,drop); fireEvent.dragEnd(source); });
  expect(move.mock.calls).toEqual([['G','after']]);
});

const sectionProps = {
  workspace: 'Team', selectedId: 'dm', width: 260, onWidthChange: () => {}, onSelect: () => {},
  customSections: [{ id: 'priority', name: 'Priority', collapsed: false }, { id: 'later', name: 'Later', collapsed: true }],
};

it('groups channels and DMs without duplicating a favorite or losing its selection, avatar, or unread count', async () => {
  const props = {
    ...sectionProps,
    channels: [{ id: 'dm', name: 'Mila', section: 'starred' as const, defaultSection: 'direct' as const,
      customSectionId: 'later', initials: 'MM', unread: 2, badgeCount: 2, onMoveToSection: vi.fn() }],
  };
  const toggle = vi.fn();
  render(<WorkspaceSidebar {...props} onToggleSection={toggle}/>);
  const later = screen.getByRole('button', { name: 'Later', exact: true });
  expect(later.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByText('Mila')).toBeNull();
  await userEvent.click(later);
  expect(toggle).toHaveBeenCalledWith('later', false);
  const input = screen.getByRole('searchbox');
  await userEvent.type(input, 'mil');
  expect(later.getAttribute('aria-expanded')).toBe('true');
  expect(screen.queryByRole('button', { name: 'Priority' })).toBeNull();
  const row = screen.getByRole('button', { name: /Mila/ });
  expect(row.closest('section')?.getAttribute('aria-label')).toBe('Later');
  expect(row.getAttribute('aria-current')).toBe('page');
  expect(row.classList.contains('sp-channel--unread')).toBe(true);
  expect(row.querySelector('.sp-sidebar-avatar')?.textContent).toContain('MM');
  expect(screen.getByText('2')).toBeTruthy();
  await userEvent.clear(input);
  expect(later.getAttribute('aria-expanded')).toBe('false');
  expect(toggle).toHaveBeenCalledTimes(1);
});

it('offers named section management and keyboard-accessible move destinations', async () => {
  const move = vi.fn(), create = vi.fn(), rename = vi.fn(), remove = vi.fn();
  render(<WorkspaceSidebar {...sectionProps} onCreateSection={create} onRenameSection={rename} onDeleteSection={remove}
    channels={[{ id: 'general', name: 'general', section: 'channels', defaultSection: 'channels', onMoveToSection: move }]}/>);
  const row = screen.getByRole('button', { name: 'general' });
  row.focus();
  await userEvent.keyboard('{Shift>}{F10}{/Shift}{ArrowRight}');
  expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'Channels' }));
  expect(document.activeElement?.getAttribute('aria-checked')).toBe('true');
  await userEvent.keyboard('{ArrowDown}{Enter}');
  expect(move.mock.calls).toEqual([['priority']]);
  fireEvent.contextMenu(row);
  await userEvent.click(screen.getByRole('menuitem', { name: 'Move to section' }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Create section…' }));
  expect(screen.queryByRole('button', { name: 'Create section' })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Manage Channels' }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Create section' }));
  expect(create.mock.calls).toEqual([['general'], []]);
  const manage = screen.getByRole('button', { name: 'Manage Priority' });
  await userEvent.click(manage);
  await userEvent.click(screen.getByRole('menuitem', { name: 'Rename section…' }));
  expect(rename).toHaveBeenCalledWith('priority');
  await userEvent.click(manage);
  await userEvent.click(screen.getByRole('menuitem', { name: 'Delete section…' }));
  expect(remove).toHaveBeenCalledWith('priority');
});

it('drops on an empty collapsed section and on a member of a populated section, then restores a favorite to Starred', () => {
  const move = vi.fn();
  const member = { id: 'other', name: 'Standup', section: 'channels' as const, customSectionId: 'priority' };
  const row = { id: 'dm', name: 'Mila', section: 'starred' as const, defaultSection: 'direct' as const, onMoveToSection: move };
  const renderSidebar = (customSectionId?: string) => <WorkspaceSidebar {...sectionProps} channels={[{ ...row, customSectionId }, member]} />;
  const view = render(renderSidebar());
  const transfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' };
  function start() {
    const source = screen.getByRole('button', { name: 'Mila' }).closest('[draggable]')!;
    fireEvent.dragStart(source, { dataTransfer: transfer });
    return source;
  }
  function drop(target: HTMLElement) {
    fireEvent.dragOver(target, { dataTransfer: transfer });
    expect(target.closest('section')?.getAttribute('data-drop-target')).toBe('true');
    fireEvent.drop(target, { dataTransfer: transfer });
  }
  const later = screen.getByRole('button', { name: 'Later', exact: true });
  fireEvent.drop(later, { dataTransfer: transfer });
  const source = start();
  fireEvent.dragOver(later, { dataTransfer: transfer });
  fireEvent.dragEnd(source);
  expect(move).not.toHaveBeenCalled();
  start();
  drop(later);
  start();
  drop(screen.getByRole('button', { name: 'Standup' }));
  view.rerender(renderSidebar('priority'));
  expect(screen.queryByRole('button', { name: 'Starred' })).toBeNull();
  start();
  drop(screen.getByRole('button', { name: 'Starred' }));
  expect(move.mock.calls).toEqual([['later'], ['priority'], [null]]);
});

it('keeps session reordering separate from moving a conversation in Starred', () => {
  const reorder = vi.fn(), assign = vi.fn();
  render(<WorkspaceSidebar {...sectionProps} channels={[
    { id: 'session:one', name: 'First', section: 'starred', agentName: 'Codex', onMove: reorder },
    { id: 'dm', name: 'Mila', section: 'starred', defaultSection: 'direct', onMoveToSection: assign },
  ]}/>);
  const transfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' };
  const session = screen.getByRole('button', {name:'First'}).closest('[draggable]')!;
  fireEvent.dragStart(session, { dataTransfer: transfer });
  fireEvent.drop(screen.getByRole('button', { name: 'Mila' }), { dataTransfer: transfer });
  fireEvent.drop(screen.getByRole('button', { name: 'Later', exact: true }), { dataTransfer: transfer });
  expect(reorder).not.toHaveBeenCalled();
  expect(assign).not.toHaveBeenCalled();
});

it('keeps the destination list open while scrolling it and dismisses it when the sidebar scrolls', async () => {
  const customSections = Array.from({ length: 40 }, (_, i) => ({ id: String(i), name: `Group ${i}`, collapsed: false }));
  const move = vi.fn();
  render(<WorkspaceSidebar {...sectionProps} customSections={customSections} channels={[
    { id: 'dm', name: 'Mila', section: 'direct', defaultSection: 'direct', onMoveToSection: move },
  ]}/>);
  const row = screen.getByRole('button', { name: 'Mila' });
  const open = () => {
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to section' }));
    return screen.getByRole('menu', { name: 'Move to section' });
  };
  const timeline = document.body.appendChild(document.createElement('div'));
  fireEvent.scroll(timeline);
  timeline.remove();
  expect(open()).toBeTruthy();
  fireEvent.scroll(open());
  await userEvent.click(screen.getByRole('menuitemradio', { name: 'Group 39', exact: true }));
  expect(move).toHaveBeenCalledWith('39');
  open();
  fireEvent.scroll(screen.getByRole('navigation', { name: 'Workspace conversations' }));
  expect(screen.queryByRole('menu', { name: 'Move to section' })).toBeNull();
});
