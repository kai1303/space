import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Composer } from "./index.js";

afterEach(cleanup);
describe("Space composer", () => {
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
});
