import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ScheduleSend, scheduleError, schedulePresets } from "./schedule-send.js";

afterEach(cleanup);

it("offers tomorrow and next Monday at 9:00 in local time, like Slack", () => {
  const wednesday = new Date(2026, 10, 11, 16, 30);
  const [tomorrow, monday] = schedulePresets(wednesday);
  expect(tomorrow!.label).toMatch(/^Tomorrow at /);
  expect([tomorrow!.at.getDate(), tomorrow!.at.getHours(), tomorrow!.at.getMinutes()]).toEqual([12, 9, 0]);
  expect(monday!.label).toMatch(/^Next Monday at /);
  expect([monday!.at.getDay(), monday!.at.getDate(), monday!.at.getHours()]).toEqual([1, 16, 9]);
});

it("does not repeat Monday when tomorrow is already Monday", () => {
  const sunday = new Date(2026, 10, 15, 20, 0);
  expect(schedulePresets(sunday).map(preset => preset.label)).toHaveLength(1);
});

it("rejects send times that are too soon, too far or invalid", () => {
  const now = Date.now();
  expect(scheduleError(new Date(now + 30_000), now)).toMatch(/minute/);
  expect(scheduleError(new Date(now + 121 * 24 * 60 * 60_000), now)).toMatch(/120 days/);
  expect(scheduleError(new Date("nope"), now)).toMatch(/date and time/);
  expect(scheduleError(new Date(now + 2 * 60_000), now)).toBe("");
});

it("schedules from a preset or a valid custom time", async () => {
  const onSchedule = vi.fn();
  render(<ScheduleSend onSchedule={onSchedule} />);
  const trigger = () => screen.getByLabelText("Schedule for later");
  await userEvent.click(trigger());
  await userEvent.click(screen.getByRole("button", { name: /^Tomorrow at/ }));
  expect(onSchedule).toHaveBeenCalledOnce();
  expect(onSchedule.mock.calls[0]![0].getHours()).toBe(9);

  await userEvent.click(trigger());
  await userEvent.click(screen.getByRole("button", { name: "Custom time…" }));
  const field = screen.getByLabelText("Date and time");
  fireEvent.change(field, { target: { value: "2000-01-01T09:00" } });
  await userEvent.click(screen.getByRole("button", { name: "Schedule message" }));
  expect(screen.getByRole("alert").textContent).toMatch(/minute/);
  expect(onSchedule).toHaveBeenCalledOnce();
  const future = new Date(Date.now() + 3 * 24 * 60 * 60_000);
  const local = new Date(future.getTime() - future.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  fireEvent.change(field, { target: { value: local } });
  await userEvent.click(screen.getByRole("button", { name: "Schedule message" }));
  expect(onSchedule).toHaveBeenCalledTimes(2);
  expect(Math.abs(onSchedule.mock.calls[1]![0].getTime() - future.getTime())).toBeLessThan(60_000);
});
