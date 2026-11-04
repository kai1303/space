import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Message } from "./index.js";

afterEach(cleanup);
describe("Space conversation", () => {
  it("opens the thread from its keyboard-focusable reply row", async () => {
    let opened = 0;
    render(<Message author="Alex" initials="AL" time="10:42" replyCount={2} onReply={() => opened++}>Hello</Message>);
    const reply = screen.getByRole("button", { name: "2 replies View thread" });
    await userEvent.tab();
    expect(document.activeElement).toBe(reply);
    await userEvent.keyboard("{Enter}");
    expect(opened).toBe(1);
    expect(document.activeElement).toBe(reply);
  });
  it("reports reaction intent without changing controlled counts", async () => {
    const reactions: string[] = [];
    render(
      <Message
        author="Alex Morgan"
        initials="AM"
        time="10:42"
        reactions={[{ emoji: "👍", count: 2, active: true }]}
        onReact={(emoji) => reactions.push(emoji)}
      >
        A shared language.
      </Message>,
    );
    const reaction = screen.getByRole("button", { name: "👍 2 reactions" });
    expect(reaction.getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(reaction);
    expect(reactions).toEqual(["👍"]);
    expect(reaction.textContent).toContain("2");
  });
});
