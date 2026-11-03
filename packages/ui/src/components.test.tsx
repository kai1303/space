import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button, Composer, Dialog, Message, Tabs, TextField } from "./index.js";

afterEach(cleanup);
describe("Space components", () => {
  it("notifies dismissal once when native cancel is followed by close", () => {
    let dismissals = 0;
    const { container } = render(
      <Dialog open={false} title="Example" onClose={() => dismissals++}>
        Dialog content
      </Dialog>,
    );
    const dialog = container.querySelector("dialog")!;
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    fireEvent(dialog, new Event("close"));
    expect(dismissals).toBe(1);
  });
  it("does not submit a loading button", async () => {
    let clicks = 0;
    render(
      <Button loading onClick={() => clicks++}>
        Save changes
      </Button>,
    );
    await userEvent.click(screen.getByRole("button"));
    expect(clicks).toBe(0);
    expect(screen.getByRole("button").getAttribute("aria-busy")).toBe("true");
  });
  it("connects field errors to their input", () => {
    render(<TextField label="Channel name" error="Use a channel name." />);
    const input = screen.getByLabelText("Channel name");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(
      document.getElementById(input.getAttribute("aria-describedby")!)
        ?.textContent,
    ).toBe("Use a channel name.");
  });
  it("moves tab focus and selection with arrows and Home/End", async () => {
    const { useState } = await import("react");
    function Example() {
      const [value, setValue] = useState("messages");
      return (
        <Tabs
          label="Channel views"
          value={value}
          onChange={setValue}
          items={[
            { id: "messages", label: "Messages" },
            { id: "files", label: "Files" },
          ]}
        />
      );
    }
    render(<Example />);
    screen.getByRole("tab", { name: "Messages" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(
      screen.getByRole("tab", { name: "Files" }),
    );
    expect(
      screen.getByRole("tab", { name: "Files" }).getAttribute("aria-selected"),
    ).toBe("true");
    await userEvent.keyboard("{Home}");
    expect(document.activeElement).toBe(
      screen.getByRole("tab", { name: "Messages" }),
    );
    await userEvent.keyboard("{End}");
    expect(document.activeElement).toBe(
      screen.getByRole("tab", { name: "Files" }),
    );
  });
  it("rejects whitespace and clears a successfully sent message", async () => {
    const messages: string[] = [];
    render(
      <Composer
        channel="design-system"
        onSend={(text) => {
          messages.push(text);
        }}
      />,
    );
    const input = screen.getByRole("textbox", {
      name: "Message design-system",
    });
    await userEvent.type(input, "   ");
    await userEvent.keyboard("{Enter}");
    expect(messages).toEqual([]);
    await userEvent.clear(input);
    await userEvent.type(input, " Hello team ");
    await userEvent.keyboard("{Enter}");
    expect(messages).toEqual(["Hello team"]);
    expect((input as HTMLTextAreaElement).value).toBe("");
  });
  it("keeps Shift+Enter and IME Enter from sending", () => {
    const messages: string[] = [];
    render(
      <Composer
        channel="general"
        onSend={(text) => {
          messages.push(text);
        }}
      />,
    );
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Draft" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(messages).toEqual([]);
  });
  it("preserves the draft and exposes a send error", async () => {
    render(
      <Composer
        channel="general"
        onSend={async () => {
          throw new Error("Offline");
        }}
      />,
    );
    await userEvent.type(screen.getByRole("textbox"), "Keep this draft");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "Keep this draft",
    );
    expect(screen.getByRole("alert").textContent).toContain("Could not send");
  });
  it("prevents another send while the first is pending", async () => {
    let calls = 0;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    render(
      <Composer
        channel="general"
        onSend={() => {
          calls++;
          return pending;
        }}
      />,
    );
    await userEvent.type(screen.getByRole("textbox"), "Send once");
    await userEvent.keyboard("{Enter}{Enter}");
    expect(calls).toBe(1);
    expect(
      (
        screen.getByRole("button", {
          name: "Send message",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    finish();
    await screen.findByRole("textbox");
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
