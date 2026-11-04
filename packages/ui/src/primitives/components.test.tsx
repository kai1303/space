import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button, Dialog, Tabs, TextField } from "./index.js";

afterEach(cleanup);
describe("Space primitives", () => {
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
});
