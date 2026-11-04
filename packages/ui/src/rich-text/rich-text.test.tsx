import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { normalizeDocument, safeLink, RichContent } from "./rich-text.js";

afterEach(cleanup);
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
it('renders identity-backed mentions as accessible profile controls without activating code examples',async()=>{
 const id='00000000-0000-4000-8000-000000000001',mention={kind:'user' as const,id,label:'Kai'},open=vi.fn();
 const {container}=render(<RichContent viewerId={id} onMentionClick={open} document={{ops:[{insert:'@Kai',attributes:{mention}},{insert:'\n'},{insert:'@Kai',attributes:{mention}},{insert:'\n',attributes:{'code-block':true}}]}}/>);
 const token=screen.getByRole('button',{name:'@Kai'});expect(token.className).toContain('is-self');await userEvent.click(token);expect(open).toHaveBeenCalledWith(mention);
 expect(container.querySelector('pre button')).toBeNull();expect(container.querySelector('pre')?.textContent).toBe('@Kai');
});

it('distinguishes people and agent mention tokens without relying on color alone',()=>{
 const id='00000000-0000-4000-8000-000000000001';
 const {container}=render(<RichContent onMentionClick={()=>{}} document={{ops:[{insert:'@Kai',attributes:{mention:{kind:'user',id,label:'Kai'}}},{insert:' '},{insert:'@Helper',attributes:{mention:{kind:'agent',id,label:'Helper'}}},{insert:'\n'}]}}/>);
 expect(container.querySelector('[data-mention-kind="user"]')).not.toBeNull();
 expect(screen.getByRole('button',{name:'Agent mention: @Helper'}).getAttribute('data-mention-kind')).toBe('agent');
});
