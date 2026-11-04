import { afterEach, expect, it, vi } from "vitest";
import { highlightCode } from "./syntax-highlight.js";

afterEach(() => vi.restoreAllMocks());

it("rejects incomplete tokenization so callers can keep the plain-text fallback", async () => {
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  // Load the grammar before simulating an exhausted per-line time budget.
  await highlightCode("const value = 1;", "typescript");
  clock.mockImplementation(() => now += 501);
  await expect(highlightCode('const value = "hello";\nconsole.log(value);', "typescript"))
    .rejects.toThrow("syntax_highlight_timeout");
  clock.mockReturnValue(now);
  const recovered = await highlightCode('const value = "hello";\nconsole.log(value);', "typescript");
  expect(recovered.flat().filter(token => token.role === "string").map(token => token.content))
    .toEqual(["hello"]);
});
