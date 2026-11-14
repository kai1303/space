import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence } from "motion/react";
import { PopoverSurface } from "../motion/popover-surface.js";

export type SidebarAction = { key?: string; label: string; divider?: boolean; heading?: string; shortcut?: string; danger?: boolean; checked?: boolean } &
  ({ select: () => void; items?: never } | { items: SidebarAction[] | (() => SidebarAction[]); select?: never });

export function SidebarRowMenu({ name, actions, children }: { name: string; actions: SidebarAction[]; children: ReactNode }) {
  const row = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [point, setPoint] = useState<{ x: number; y: number }>();
  const [submenu, setSubmenu] = useState<string>();
  const subpanel = useRef<HTMLDivElement>(null);
  const keyboardOpen = useRef(false);
  useLayoutEffect(() => {
    const sub = subpanel.current;
    const anchor = sub?.parentElement?.querySelector('button');
    if (!sub || !anchor) return;
    const bounds = anchor.getBoundingClientRect();
    sub.style.left = Math.max(4, bounds.right + sub.offsetWidth > innerWidth - 4 ? bounds.left - sub.offsetWidth : bounds.right) + 'px';
    sub.style.top = Math.max(4, Math.min(bounds.top, innerHeight - sub.offsetHeight - 4)) + 'px';
    if (keyboardOpen.current) sub.querySelector('button')?.focus();
    keyboardOpen.current = false;
  }, [submenu]);
  const touch = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const suppressClick = useRef(false);
  function clearTouch() { clearTimeout(touch.current); }
  useEffect(() => clearTouch, []);

  useLayoutEffect(() => {
    const menu = panel.current;
    if (!point || !menu) return;
    setSubmenu(undefined);
    const left = Math.max(8, Math.min(point.x, window.innerWidth - menu.offsetWidth - 8));
    const top = Math.max(8, Math.min(point.y, window.innerHeight - menu.offsetHeight - 8));
    menu.style.left = left + "px";
    menu.style.top = top + "px";
    menu.style.transformOrigin = `${point.x - left}px ${point.y - top}px`;
    menu.querySelector("button")?.focus({ preventScroll: true });
    const dismiss = (event: Event) => {
      if (!(event.target instanceof Node) || !menu.contains(event.target)) setPoint(undefined);
    };
    const dismissOnScroll = (event: Event) => {
      const target = event.target;
      if (target === window || target === document || (target instanceof Element && target.contains(row.current))) {
        setPoint(undefined);
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("focusin", dismiss);
    window.addEventListener("scroll", dismissOnScroll, true);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("focusin", dismiss);
      window.removeEventListener("scroll", dismissOnScroll, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [point]);

  function close() {
    setPoint(undefined);
    row.current?.querySelector("button")?.focus({ preventScroll: true });
  }
  function entry(action: SidebarAction, nested = false) {
    const expanded = !nested && !!action.items && submenu === action.label;
    const children = expanded ? (typeof action.items === 'function' ? action.items() : action.items) : undefined;
    return <span key={action.key ?? action.label} className="sp-menu-item-group"
      onPointerEnter={nested ? undefined : event => { if (event.pointerType === 'mouse') setSubmenu(action.items ? action.label : undefined); }}>
      {action.divider && <hr role="separator"/>}
      {action.heading && <small className="sp-menu-group-title">{action.heading}</small>}
      <button type="button" role={action.checked === undefined ? "menuitem" : "menuitemradio"} aria-checked={action.checked}
        aria-haspopup={action.items ? "menu" : undefined} aria-expanded={action.items ? expanded : undefined}
        className={action.danger ? 'sp-menu-danger' : undefined} tabIndex={-1}
        onClick={() => { if (action.items) setSubmenu(action.label); else { close(); action.select(); } }}
        onKeyDown={event => {
          if (action.items && ['ArrowRight','Enter',' '].includes(event.key)) {
            event.preventDefault(); keyboardOpen.current = true;
            if (expanded) subpanel.current?.querySelector('button')?.focus(); else setSubmenu(action.label);
          }
        }}>{action.label}{action.items && <span aria-hidden="true">›</span>}{action.checked && <span aria-hidden="true">✓</span>}
        {action.shortcut && <kbd>{action.shortcut}</kbd>}</button>
      <AnimatePresence>{expanded && <PopoverSurface key={action.label} ref={node => {
        if (!node) return;
        subpanel.current = node;
        return () => { if (subpanel.current === node) subpanel.current = null; };
      }} className="sp-menu-content sp-sidebar-context-menu" role="menu" aria-label={action.label}>
        {children?.map(item => entry(item, true))}
      </PopoverSurface>}</AnimatePresence>
    </span>;
  }
  return <>
    <div ref={row} onContextMenu={event => {
      event.preventDefault();
      clearTouch();
      setPoint({ x: event.clientX, y: event.clientY });
    }} onKeyDown={event => {
      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
      event.preventDefault();
      const bounds = event.currentTarget.getBoundingClientRect();
      setPoint({ x: bounds.left, y: bounds.bottom });
    }} onPointerDown={event => {
      clearTouch();
      suppressClick.current = false;
      if (event.pointerType !== "touch") return;
      const location = { x: event.clientX, y: event.clientY };
      touch.current = setTimeout(() => { suppressClick.current = true; setPoint(location); }, 500);
    }} onPointerUp={clearTouch} onPointerMove={clearTouch} onPointerCancel={clearTouch}
      onClickCapture={event => { if (suppressClick.current) { event.stopPropagation(); suppressClick.current = false; } }}>
      {children}
    </div>
    {typeof document !== "undefined" && createPortal(<AnimatePresence>
      {point && <PopoverSurface role="menu" className="sp-menu-content sp-sidebar-context-menu" ref={panel} fadeOnly={actions.some(action => !!action.items)} aria-label={`Actions for ${name}`}
        onKeyDown={event => {
          const target = event.target as HTMLElement;
          if (subpanel.current?.contains(target) && ["ArrowLeft","Escape"].includes(event.key)) {
            event.preventDefault(); subpanel.current.parentElement?.querySelector("button")?.focus(); setSubmenu(undefined); return;
          }
          if (event.key === "Escape" || event.key === "Tab") {
            if (event.key === "Escape") event.preventDefault();
            close();
            return;
          }
          const buttons = Array.from(target.closest('[role="menu"]')!.querySelectorAll<HTMLButtonElement>(":scope > span > button"));
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          let next: number;
          switch (event.key) {
            case "Home": next = 0; break;
            case "End": next = buttons.length - 1; break;
            case "ArrowDown": next = (index + 1) % buttons.length; break;
            case "ArrowUp": next = (index + buttons.length - 1) % buttons.length; break;
            default: return;
          }
          event.preventDefault();
          buttons[next]?.focus();
        }}>
        {actions.map(action => entry(action))}
      </PopoverSurface>}
    </AnimatePresence>, document.body)}
  </>;
}
