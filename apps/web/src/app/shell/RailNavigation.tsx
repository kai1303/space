import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { motion, useReducedMotion } from 'motion/react';
import { NavigationIcon } from '@space/ui/navigation';
import { motionTransition } from '@space/ui/motion';
import './rail-navigation.css';

export type RailDestination = 'spacebot' | 'files' | 'todos' | 'agents';
export type RailPreview = 'spacebot' | 'dms' | 'activity' | 'files' | 'todos';
type Tab = RailDestination | 'home' | 'dms' | 'activity' | 'admin';
type Panel = { tab: RailPreview | 'admin'; anchor: HTMLElement; pinned: boolean; keyboard: boolean };
const labels = { spacebot:'Spacebot', home:'Home', dms:'DMs', activity:'Activity', files:'Files', todos:'To-dos', agents:'Agents & tools', admin:'Admin' } as const;
const order = ['spacebot','home','dms','activity','files','todos','agents','admin'] as const;
const glyphMotion = { idle:{scale:1}, hovered:{scale:1.15} };
const glyphTransition = {duration:.125, ease:[.17,.67,.55,1.09] as const};
const enabledControl = 'button:not(:disabled):not([tabindex="-1"]), a[href], input:not(:disabled), summary, [tabindex="0"]';

export interface RailProps {
  onHome?: () => void;
  onDirectMessages?: () => void;
  onActivity?: () => void;
  onNavigate?: (view: RailDestination) => void;
  adminItems?: {label: string; onSelect: () => void}[];
  renderPreview?: (tab: RailPreview, close: () => void) => ReactNode;
  active: Tab;
  notificationCount?: number;
}

export function RailNavigation({active, onNavigate, onDirectMessages, onActivity, onHome, adminItems, renderPreview, notificationCount = 0}: RailProps) {
  const [panel, setPanel] = useState<Panel>();
  const panelRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const stopTimer = useCallback(() => clearTimeout(timer.current), []);
  const close = useCallback(() => { stopTimer(); setPanel(undefined); }, [stopTimer]);
  const id = useId();
  const reduced = useReducedMotion();
  useEffect(() => { close(); return stopTimer; }, [active, close, stopTimer]);

  useLayoutEffect(() => {
    const card = panelRef.current;
    if (!panel || !card) return;
    const {anchor} = panel;
    function position() {
      if (!card) return;
      const rect = anchor.getBoundingClientRect();
      const rail = anchor.closest('nav')?.getBoundingClientRect();
      if (rail && rail.height > 0 && (rect.bottom <= rail.top || rect.top >= rail.bottom)) { close(); return; }
      const left = Math.min((rail?.right ?? rect.right + 9) - 3, window.innerWidth - card.offsetWidth - 4);
      const top = Math.min(rect.top - 44, window.innerHeight - card.offsetHeight - 10);
      card.style.left = Math.max(4, left) + 'px';
      card.style.top = Math.max(4, top) + 'px';
    }
    position();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(position) : undefined;
    observer?.observe(card);
    const rail = anchor.closest('nav');
    rail?.addEventListener('scroll', position);
    window.addEventListener('resize', position);
    if (panel.keyboard) (card.querySelector<HTMLElement>(enabledControl) ?? card).focus();
    return () => { observer?.disconnect(); rail?.removeEventListener('scroll', position); window.removeEventListener('resize', position); };
  }, [panel, close]);

  useEffect(() => {
    const outside = (event: Event) => {
      if (event.target instanceof Node && !panel?.anchor.contains(event.target) && !panelRef.current?.contains(event.target)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        if (panelRef.current?.contains(document.activeElement)) panel?.anchor.focus();
        close();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', escape);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('blur', close);
    };
  }, [panel, close]);

  function leave() {
    stopTimer();
    if (panel && !panel.pinned) timer.current = setTimeout(close, 150);
  }

  const actions = {home:onHome, dms:onDirectMessages, activity:onActivity, files:onNavigate, todos:onNavigate, agents:onNavigate, spacebot:onNavigate, admin:adminItems?.length};
  return <>{order.map(tab => {
    if (tab !== 'home' && !actions[tab]) return null;
    const selected = active === tab;
    const canPeek = !selected && tab !== 'home' && tab !== 'agents' && (tab === 'admin' || !!renderPreview);
    const expanded = panel?.tab === tab;
    const label = labels[tab];
    const contents = <><span className="chat-rail-icon">
      {selected && (reduced ? <span className="chat-rail-active" aria-hidden="true"/> : <motion.span aria-hidden="true" className="chat-rail-active" layoutId="active-rail-item" transition={motionTransition(false,.22)}/>)}
      <span className="chat-rail-glyph"><motion.span className="rail-symbol" variants={glyphMotion} transition={glyphTransition}><NavigationIcon name={tab} active={selected} size={tab === 'spacebot' ? 32 : 20}/></motion.span>
      {tab === 'activity' && notificationCount > 0 && <span className="notification-rail-count" aria-hidden="true">{notificationCount > 99 ? '99+' : notificationCount}</span>}</span>
    </span><span>{label}</span></>;
    const className = 'chat-rail-item' + (selected ? ' is-active' : '') + (expanded ? ' is-peeking' : '');
    const motionProps = {initial:false as const, animate:expanded && !reduced ? 'hovered' : 'idle', whileHover:reduced ? undefined : 'hovered'};
    if (tab === 'home') return <motion.a {...motionProps} key={tab} href="/chat" aria-current={selected ? 'page' : undefined} className={className} onClick={event => { close(); if (onHome) { event.preventDefault(); onHome(); } }}>{contents}</motion.a>;
    return <motion.button {...motionProps} type="button" key={tab} className={className} data-rail-tab={tab} aria-current={selected ? 'page' : undefined}
      aria-label={tab === 'activity' && notificationCount ? `Activity (${notificationCount} unread)` : label}
      aria-haspopup={canPeek ? tab === 'admin' ? 'menu' : 'dialog' : undefined} aria-expanded={canPeek ? expanded : undefined} aria-controls={expanded ? id : undefined}
      onPointerEnter={event => {
        if (event.pointerType === 'touch' || !canPeek || panel?.pinned) return;
        stopTimer();
        if (!expanded) {
          const anchor = event.currentTarget;
          timer.current = setTimeout(() => setPanel({tab, anchor, pinned:false, keyboard:false}), 300);
        }
      }}
      onPointerLeave={leave}
      onKeyDown={event => {
        if (canPeek && (event.key === 'ArrowRight' || event.key === 'ArrowDown')) {
          event.preventDefault(); stopTimer();
          setPanel({tab, anchor:event.currentTarget, pinned:true, keyboard:true});
        }
      }}
      onClick={event => {
        stopTimer();
        if (tab === 'admin') {
          if (expanded && panel.pinned) close();
          else setPanel({tab, anchor:event.currentTarget, pinned:true, keyboard:event.detail === 0});
          return;
        }
        close();
        if (tab === 'dms') onDirectMessages?.();
        else if (tab === 'activity') onActivity?.();
        else onNavigate?.(tab);
      }}>{contents}</motion.button>;
  })}
    {panel && createPortal(<div key={panel.tab} id={id} ref={panelRef} role={panel.tab === 'admin' ? 'menu' : 'dialog'} aria-label={panel.tab === 'admin' ? 'Admin tools' : labels[panel.tab]}
      tabIndex={-1} className={'rail-peek rail-peek--' + panel.tab} onPointerEnter={stopTimer} onPointerLeave={leave}
      onKeyDown={event => {
        if (event.key === 'Tab' && !event.defaultPrevented) {
          // Continue in rail order even though the card is portaled to the body.
          const controls = event.currentTarget.querySelectorAll<HTMLElement>(enabledControl);
          const edge = event.shiftKey ? controls[0] : controls[controls.length - 1];
          if (!edge || edge === document.activeElement) {
            if (event.shiftKey) event.preventDefault();
            panel.anchor.focus();
            close();
          }
          return;
        }
        if (panel.tab !== 'admin' || !['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=menuitem]'));
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + items.length + (event.key === 'ArrowUp' ? -1 : 1)) % items.length;
        items[next]?.focus();
      }}>
      <motion.div className="rail-peek-card" initial={reduced ? false : {opacity:0,x:-8}} animate={{opacity:1,x:0}} transition={{duration:reduced ? 0 : .16,ease:[.25,1,.5,1]}}>
        {panel.tab === 'admin' ? <><header className="rail-peek-header"><h2>Admin tools</h2></header><div className="rail-peek-admin-items">{adminItems?.map(item => <button key={item.label} type="button" role="menuitem" className="rail-peek-row" onClick={() => { panel.anchor.focus(); close(); item.onSelect(); }}>{item.label}</button>)}</div></> : renderPreview?.(panel.tab, close)}
      </motion.div>
    </div>, document.body)}
  </>;
}
