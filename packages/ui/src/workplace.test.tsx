import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { parseSearch, searchMessages, toggleSearchFilter } from "./search.js";
import { normalizeDocument, safeLink, RichContent } from "./rich-text.js";
import { WorkspaceSidebar } from "./sidebar.js";
import { WorkspaceSearch } from "./search-dialog.js";

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
it("preserves leading blank lines inside a formatted code block", () => {
  const { container } = render(<RichContent document={{ ops: [{ insert: "\n\nconst ready = true;\n", attributes: { "code-block": true } }] }} />);
  expect(container.querySelector("pre")?.textContent).toBe("\n\nconst ready = true;");
});
it("can preserve an over-limit local draft while bounding display documents", () => {
  const draft = { ops: [{ insert: "x".repeat(11000) + "\n" }] };
  expect(normalizeDocument(draft, Infinity).ops[0]?.insert).toHaveLength(11001);
  expect(normalizeDocument(draft).ops[0]?.insert).toHaveLength(10001);
});
it("keeps adjacent code lines in one code block and groups list items", () => {
  const { container } = render(
    <RichContent
      document={{
        ops: [
          { insert: "first\nsecond\n", attributes: { "code-block": true } },
          { insert: "One" },
          { insert: "\n", attributes: { list: "bullet" } },
          { insert: "Two" },
          { insert: "\n", attributes: { list: "bullet" } },
        ],
      }}
    />,
  );
  expect(container.querySelectorAll("pre")).toHaveLength(1);
  expect(container.querySelector("pre")?.textContent).toBe("first\nsecond");
  expect(container.querySelectorAll("ul li")).toHaveLength(2);
});
it("does not activate unseen message suggestions for an empty query", () => {
  let selections = 0;
  let searches = 0;
  const { container } = render(
    <WorkspaceSearch
      open={false}
      onClose={() => {}}
      messages={[{ id: "1", channel: "design", author: "Alex", text: "Hello" }]}
      channel="design"
      onSearch={() => searches++}
      onSelect={() => selections++}
    />,
  );
  const input = container.querySelector("input")!;
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(selections).toBe(0);
  expect(searches).toBe(0);
});
it("finds links whose URL is stored in rich attributes rather than visible text", () => {
  const messages = [
    {
      id: "link",
      channel: "design",
      author: "You",
      text: "View guidelines",
      links: ["https://example.test/guide"],
    },
  ];
  expect(searchMessages(messages, "has:link").map((m) => m.id)).toEqual([
    "link",
  ]);
  expect(searchMessages(messages, "example.test").map((m) => m.id)).toEqual([
    "link",
  ]);
});
it("searches literal URLs and replaces same-kind quick filters exactly", () => {
  expect(parseSearch("https://example.test/guide").terms).toEqual([
    "https://example.test/guide",
  ]);
  expect(toggleSearchFilter('in:general "shared language"', "in:design")).toBe(
    '"shared language" in:design',
  );
  expect(toggleSearchFilter("in:design-system2", "in:design-system")).toBe(
    "in:design-system",
  );
  expect(toggleSearchFilter("in:design has:link", "has:link")).toBe(
    "in:design",
  );
});
it("parses quoted filters and keeps every free-text term", () => {
  expect(
    parseSearch(
      'in:#design from:"Alex Morgan" "shared language" has:link is:thread',
    ),
  ).toEqual({
    terms: ["shared language"],
    channel: "design",
    from: "alex morgan",
    hasLink: true,
    threadsOnly: true,
  });
});
it("reports malformed and unsupported filters rather than broadening a search", () => {
  expect(parseSearch('from:"Alex').error).toBeTruthy();
  expect(parseSearch("has:file").error).toBeTruthy();
  expect(parseSearch("in:").error).toBeTruthy();
});
it("combines channel, author, link and thread conditions", () => {
  const messages = [
    {
      id: "1",
      channel: "design",
      author: "Alex Morgan",
      text: "Shared language https://example.test",
      thread: true,
    },
    {
      id: "2",
      channel: "general",
      author: "Alex Morgan",
      text: "Shared language https://example.test",
      thread: true,
    },
    { id: "3", channel: "design", author: "You", text: "Shared language" },
  ];
  expect(
    searchMessages(
      messages,
      'in:design from:"Alex Morgan" has:link is:thread shared',
    ).map((m) => m.id),
  ).toEqual(["1"]);
  expect(searchMessages(messages, "from:me", "You").map((m) => m.id)).toEqual([
    "3",
  ]);
  expect(searchMessages(messages, "unknown:filter")).toEqual([]);
});
it("accepts web/mail links and rejects executable or embedded URLs", () => {
  expect(safeLink("https://example.test/path")).toBe(
    "https://example.test/path",
  );
  expect(safeLink("mailto:hello@example.test")).toBe(
    "mailto:hello@example.test",
  );
  expect(safeLink("javascript:alert(1)")).toBeUndefined();
  expect(safeLink("data:text/html,<script>")).toBeUndefined();
});
it("retains formatting while removing embeds and unrecognized attributes", () => {
  expect(
    normalizeDocument({
      ops: [
        {
          insert: "Hello",
          attributes: { bold: true, color: "red", link: "javascript:alert(1)" },
        },
        { insert: { image: "private" } },
        { insert: "\n" },
      ],
    }),
  ).toEqual({
    ops: [{ insert: "Hello", attributes: { bold: true } }, { insert: "\n" }],
  });
});
it("renders rich text as escaped React content with safe links", () => {
  const { container } = render(
    <RichContent
      document={{
        ops: [
          { insert: "<script>hi</script>", attributes: { bold: true } },
          { insert: " link", attributes: { link: "https://example.test" } },
          { insert: "\n" },
        ],
      }}
    />,
  );
  expect(container.querySelector("script")).toBeNull();
  expect(container.querySelector("strong")?.textContent).toBe(
    "<script>hi</script>",
  );
  expect(screen.getByRole("link").getAttribute("rel")).toContain("noopener");
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
