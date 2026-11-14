import { useId, useState } from 'react';
import { Button, Dialog } from '@space/ui/primitives';
import { SCHEDULE_MAX_LEAD_MS } from '@space/contracts';

const minute = 60_000;
const localDate = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * minute).toISOString().slice(0, 10);
const clockTime = (hour: number, minutes: number) => [hour, minutes].map(n => String(n).padStart(2, '0')).join(':');
const suggestions = Array.from({length:96}, (_, i) => clockTime(Math.floor(i / 4), i % 4 * 15));

export function DraftScheduleDialog({current, onClose, onSchedule}: {
  current: boolean; onClose: () => void; onSchedule: (at: Date) => void;
}) {
  const [initial] = useState(() => {
    const next = new Date(Math.floor(Date.now() / minute) * minute + 5 * minute);
    if (next.getMinutes()) next.setHours(next.getHours() + 1, 0, 0, 0);
    return next;
  });
  const [day, setDay] = useState(() => localDate(initial));
  const [time, setTime] = useState(() => clockTime(initial.getHours(), initial.getMinutes()));
  const id = useId();
  const selected = new Date(day + 'T' + time);
  const now = Math.floor(Date.now() / minute) * minute;
  const problem = !current ? 'This draft changed. Review it before scheduling.'
    : !Number.isFinite(selected.getTime()) ? 'Choose a date and time.'
    : localDate(selected) !== day || clockTime(selected.getHours(),selected.getMinutes()) !== time ? 'Choose a time that exists in your time zone.'
    : selected.getTime() < now + 5 * minute ? 'Choose a time at least five minutes from now.'
    : selected.getTime() > now + SCHEDULE_MAX_LEAD_MS ? 'Choose a time within 120 days.' : '';
  const zone = Intl.DateTimeFormat(undefined, {timeZoneName:'long'}).formatToParts(Number.isFinite(selected.getTime()) ? selected : initial)
    .find(part => part.type === 'timeZoneName')?.value;
  return <Dialog open title="Schedule message" onClose={onClose}>
    <form className="draft-schedule-form" onSubmit={event => {
      event.preventDefault();
      if (!problem) onSchedule(selected);
    }}>
      <p>Time zone: {zone}</p>
      <div className="draft-schedule-fields">
        <label>Date<input type="date" required value={day} min={localDate(new Date(now))} max={localDate(new Date(now + SCHEDULE_MAX_LEAD_MS))}
          onChange={event => setDay(event.target.value)}/></label>
        <label>Time<input type="time" required value={time} list={id} onChange={event => setTime(event.target.value)}/></label>
        <datalist id={id}>{suggestions.map(value => <option key={value} value={value}/>)}</datalist>
      </div>
      {problem && <p role="status">{problem}</p>}
      <div className="draft-send-footer">
        <Button type="button" onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={!!problem}>Schedule Message</Button>
      </div>
    </form>
  </Dialog>;
}
