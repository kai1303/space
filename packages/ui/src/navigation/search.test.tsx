import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { parseSearch, searchMessages, toggleSearchFilter } from "./search.js";
import { WorkspaceSearch } from "./search-dialog.js";

afterEach(cleanup);
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
