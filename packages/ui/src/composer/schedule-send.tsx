import { useRef, useState } from "react";
import { CaretDown, Clock } from "@phosphor-icons/react";
import { Button, Popover } from "../primitives/primitives.js";

const DAY = 24 * 60 * 60_000;
const MIN_LEAD = 60_000;
const MAX_LEAD = 120 * DAY;

function at9(date: Date) { const next = new Date(date); next.setHours(9, 0, 0, 0); return next; }

// Slack's presets: tomorrow morning, and next Monday morning (in the person's local time).
export function schedulePresets(now = new Date()) {
  const tomorrow = at9(new Date(now.getTime() + DAY));
  const monday = at9(now);
  monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7 || 7));
  const format = (date: Date, prefix: string) => `${prefix} at ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  const presets = [{ label: format(tomorrow, "Tomorrow"), at: tomorrow }];
  if (monday.getTime() !== tomorrow.getTime()) presets.push({ label: format(monday, "Next Monday"), at: monday });
  return presets;
}

export function scheduleError(at: Date, now = Date.now()) {
  if (!Number.isFinite(at.getTime())) return "Choose a date and time.";
  if (at.getTime() < now + MIN_LEAD) return "Choose a time at least a minute from now.";
  if (at.getTime() > now + MAX_LEAD) return "Choose a time within 120 days.";
  return "";
}

const localInput = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

export function ScheduleSend({ disabled, onSchedule }: { disabled?: boolean; onSchedule: (at: Date) => void }) {
  const [custom, setCustom] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const root = useRef<HTMLSpanElement>(null);
  return <span ref={root} className="sp-schedule-send">
    <Popover label="Schedule for later" panelLabel="Schedule message" floating align="end" disabled={disabled}
      className="sp-schedule-menu" panelClassName="sp-menu-content sp-schedule-menu-content"
      triggerClassName="sp-button sp-button--ghost sp-button--sm sp-icon-button sp-schedule-trigger" trigger={<CaretDown size={14} weight="bold" aria-hidden="true" />}>
      {close => <div className="sp-schedule-panel">
        <strong>Schedule message</strong>
        {schedulePresets().map(preset => <button type="button" key={preset.label} className="sp-schedule-option"
          onClick={() => { close(true); onSchedule(preset.at); }}><Clock size={16} aria-hidden="true" />{preset.label}</button>)}
        {!custom ? <button type="button" className="sp-schedule-option" onClick={() => { setCustom(true); setValue(localInput(at9(new Date(Date.now() + DAY)))); setError(""); }}>Custom time…</button>
          : <form className="sp-schedule-custom" noValidate onSubmit={event => {
              event.preventDefault();
              const at = new Date(value);
              const problem = scheduleError(at);
              if (problem) { setError(problem); return; }
              setCustom(false); close(true); onSchedule(at);
            }}>
            <label>Date and time<input type="datetime-local" value={value} min={localInput(new Date(Date.now() + MIN_LEAD))} onChange={event => { setValue(event.target.value); setError(""); }} /></label>
            {error && <p role="alert">{error}</p>}
            <Button type="submit" size="sm" variant="primary">Schedule message</Button>
          </form>}
      </div>}
    </Popover>
  </span>;
}

// Phones: holding the send button opens the same menu, like Slack.
export function openScheduleMenu(container: Element | null) {
  container?.querySelector<HTMLElement>(".sp-schedule-send summary")?.click();
}
