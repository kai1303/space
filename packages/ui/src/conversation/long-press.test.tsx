import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Message } from "./conversation.js";

afterEach(() => { cleanup(); vi.useRealTimers(); });
const message = () => screen.getByRole("article");
const press = (element: Element, type: string, init: { x?: number; y?: number; pointerType?: string } = {}) =>
  fireEvent(element, Object.assign(new Event(type, { bubbles: true }), { pointerType: init.pointerType ?? "touch", clientX: init.x ?? 0, clientY: init.y ?? 0 }));

it("opens message actions after a touch long press and closes them on an outside tap", () => {
  vi.useFakeTimers();
  render(<><Message author="Kai" initials="KA" time="09:00" onReact={() => {}}>Hello</Message><p>Outside</p></>);
  press(screen.getByText("Hello"), "pointerdown");
  act(() => vi.advanceTimersByTime(300));
  expect(message().hasAttribute("data-actions-open")).toBe(false);
  act(() => vi.advanceTimersByTime(200));
  expect(message().hasAttribute("data-actions-open")).toBe(true);
  press(screen.getByText("Outside"), "pointerdown");
  expect(message().hasAttribute("data-actions-open")).toBe(false);
});

it("ignores scrolling, mouse presses and presses on controls", () => {
  vi.useFakeTimers();
  render(<Message author="Kai" initials="KA" time="09:00" onReact={() => {}}>Hello</Message>);
  press(screen.getByText("Hello"), "pointerdown");
  press(screen.getByText("Hello"), "pointermove", { y: 30 });
  act(() => vi.advanceTimersByTime(600));
  press(screen.getByText("Hello"), "pointerdown", { pointerType: "mouse" });
  act(() => vi.advanceTimersByTime(600));
  press(screen.getByRole("button", { name: "React with eyes" }), "pointerdown");
  act(() => vi.advanceTimersByTime(600));
  expect(message().hasAttribute("data-actions-open")).toBe(false);
});
