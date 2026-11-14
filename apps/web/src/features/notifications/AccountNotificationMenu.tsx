import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { NotificationSettings } from '@space/contracts';
import { CaretRight } from '@phosphor-icons/react';
import { request } from '../../shared/api/request.js';

export function AccountNotificationMenu({ workspace, actor, onClose }: {
  workspace: string; actor: string; onClose: () => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  function back() { trigger.current?.focus(); setOpen(false); }
  return <div className="account-notifications"
    onPointerEnter={event => { if (event.pointerType === 'mouse') setOpen(true); }}
    onPointerLeave={event => { if (event.pointerType === 'mouse' && !event.currentTarget.querySelector('form :focus, [aria-busy=true]')) setOpen(false); }}
    onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button role="menuitem" ref={trigger} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => setOpen(true)} onKeyDown={event => {
        if (['ArrowRight', 'Enter', ' '].includes(event.key)) {
          event.preventDefault(); setOpen(true);
          requestAnimationFrame(() => {
            const menu = document.getElementById(id);
            (menu?.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? menu)?.focus();
          });
        }
      }}>Notifications <CaretRight size={14} aria-hidden="true"/></button>
    {open && <PauseMenu key={workspace + actor} {...{ id, workspace, actor, back }} onClose={() => { setOpen(false); onClose(); }} anchor={trigger.current!}/>}
  </div>;
}

function PauseMenu({ id, workspace, actor, anchor, onClose, back }: {
  id: string; workspace: string; actor: string; anchor: HTMLElement; onClose: () => void; back: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [until, setUntil] = useState<string | null>();
  const [custom, setCustom] = useState(false), [date, setDate] = useState('');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const path = `/workspaces/${workspace}/notification-settings`;
  const [attempt, setAttempt] = useState(0);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    setError('');
    request<NotificationSettings>(path, undefined, undefined, 'POST', controller.signal, actor)
      .then(value => { if (!controller.signal.aborted) setUntil(value.paused_until); })
      .catch(() => { if (!controller.signal.aborted) setError('Couldn’t load notification settings.'); });
    return () => { mounted.current = false; controller.abort(); };
  }, [path, actor, attempt]);
  useEffect(() => {
    if (!until) return;
    const timer = window.setTimeout(() => setUntil(null), Math.max(0, Date.parse(until) - Date.now()));
    return () => clearTimeout(timer);
  }, [until]);
  useEffect(() => {
    if (document.activeElement === menu.current) menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [until, error]);
  useLayoutEffect(() => {
    const panel = menu.current!;
    // A native popover escapes the account menu’s scroll clipping and retains DOM focus containment.
    panel.showPopover?.();
    function place() {
      const rect = anchor.getBoundingClientRect();
      const left = rect.right + panel.offsetWidth <= innerWidth - 4 ? rect.right : Math.max(4, rect.left - panel.offsetWidth);
      panel.style.left = left + 'px';
      panel.style.top = Math.max(4, Math.min(rect.top, innerHeight - panel.offsetHeight - 4)) + 'px';
    }
    place();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(place);
    observer?.observe(panel);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { observer?.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [anchor]);
  async function save(expires: Date | null) {
    if (busy) return;
    if (expires && !(expires.getTime() > Date.now() && expires.getTime() <= Date.now() + 7 * 86400000)) {
      setError('Choose a future time within seven days.'); return;
    }
    setBusy(true); setError('');
    try {
      await request(path, { paused_until: expires?.toISOString() ?? null }, undefined, 'PATCH', undefined, actor);
      if (mounted.current) onClose();
    } catch { if (mounted.current) { setError('Couldn’t save your notification pause. Try again.'); setBusy(false); } }
  }
  return <div ref={menu} id={id} className="account-pause-menu" popover="manual" tabIndex={-1} role="menu" aria-busy={busy} aria-label="Notifications"
    onKeyDown={event => {
      if (event.key === 'Escape' || event.key === 'ArrowLeft' && event.target instanceof HTMLButtonElement) {
        event.preventDefault(); event.stopPropagation(); back(); return;
      }
      if (event.target instanceof HTMLInputElement || !['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const items = Array.from(menu.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
      items[next]?.focus();
    }}>
    <small>{until && Date.parse(until) > Date.now() ? 'Paused until ' + new Date(until).toLocaleString() : 'Pause notifications'}</small>
    {until && Date.parse(until) > Date.now() && <button role="menuitem" disabled={busy} onClick={() => void save(null)}>Resume notifications</button>}
    {until === undefined && !error && <small role="status">Loading…</small>}
    {[15, 30, 60, 120].map(minutes => <button key={minutes} role="menuitem" disabled={busy || until === undefined}
      onClick={() => void save(new Date(Date.now() + minutes * 60000))}>{minutes < 60 ? minutes + ' minutes' : minutes === 60 ? '1 hour' : '2 hours'}</button>)}
    <button role="menuitem" disabled={busy || until === undefined} onClick={() => setCustom(true)}>Custom…</button>
    {custom && <form onSubmit={event => { event.preventDefault(); void save(new Date(date)); }}>
      <label>Pause until<input autoFocus type="datetime-local" required value={date} onChange={event => setDate(event.target.value)}/></label>
      <button type="submit" disabled={busy}>Pause notifications</button>
    </form>}
    {error && <div role="alert">{error}{until === undefined && <button onClick={() => setAttempt(n => n + 1)}>Retry</button>}</div>}
  </div>;
}
