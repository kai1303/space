import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
