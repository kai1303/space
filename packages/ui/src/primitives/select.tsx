import { Children, Fragment, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState, type ComponentProps, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CaretDown, Check, MagnifyingGlass } from '@phosphor-icons/react';
import { AnimatePresence } from 'motion/react';
import { PopoverSurface } from '../motion/popover-surface.js';

type Option = { value: string; label: string; disabled: boolean };
export type SelectProps = Omit<ComponentProps<'select'>, 'multiple' | 'size' | 'ref' | 'value' | 'defaultValue'> & {
  'aria-label': string;
  value?: string | number;
  defaultValue?: string | number;
  searchable?: boolean;
};
function text(children: ReactNode): string {
  return Children.toArray(children).map(child => isValidElement<{ children?: ReactNode }>(child) ? text(child.props.children) : String(child)).join('');
}
function readOptions(children: ReactNode, disabled = false): Option[] {
  return Children.toArray(children).flatMap(child => {
    if (!isValidElement<{ children?: ReactNode; value?: string | number; label?: string; disabled?: boolean }>(child)) return [];
    if (child.type === Fragment || child.type === 'optgroup') return readOptions(child.props.children, disabled || !!child.props.disabled);
    if (child.type !== 'option') return [];
    const label = child.props.label ?? text(child.props.children);
    return [{ value: String(child.props.value ?? label), label, disabled: disabled || !!child.props.disabled }];
  });
}

/** Single selection with a native backing control for validation and form submission. */
export function Select({ children, value, defaultValue, searchable, className = '', id, autoFocus, 'aria-label': label, 'aria-describedby': description, 'aria-invalid': invalid, onChange, onInvalid, ...props }: SelectProps) {
  const uid = useId(), listId = `${uid}-list`;
  const native = useRef<HTMLSelectElement>(null), trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null);
  const [uncontrolled, setUncontrolled] = useState(String(defaultValue ?? ''));
  const [validationMessage, setValidationMessage] = useState('');
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [active, setActive] = useState('');
  const [position, setPosition] = useState({ top: 0, left: 0, width: 0, maxHeight: 320 });
  const typeahead = useRef({ text: '', time: 0 });
  const options = readOptions(children);
  const selected = options.find(option => option.value === String(value ?? uncontrolled)) ?? options.find(option => !option.disabled);
  const filtered = options.filter(option => option.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const enabled = filtered.filter(option => !option.disabled);
  const highlighted = enabled.find(option => option.value === active) ?? enabled[0];
  const activeId = highlighted ? `${uid}-option-${options.indexOf(highlighted)}` : undefined;
  const canSearch = searchable ?? options.length > 10;
  const blocked = () => !!native.current?.matches(':disabled');
  function close(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }
  function show() {
    if (blocked()) return;
    setQuery(''); setActive(selected?.value ?? ''); setOpen(true);
    typeahead.current = { text: '', time: 0 };
  }
  function choose(option: Option) {
    if (blocked() || option.disabled || !native.current) return;
    // Dispatch through the actual control so callers receive a real select change event.
    native.current.value = option.value;
    native.current.dispatchEvent(new Event('change', { bubbles: true }));
    close(true);
  }
  function navigate(event: KeyboardEvent) {
    if (event.key === 'Escape' && !open) return;
    event.stopPropagation(); // Nested menus must not handle the select's navigation.
    if (event.key === 'Escape' && open) { event.preventDefault(); close(true); return; }
    if (event.key === 'Tab') { if (open) close(true); return; }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      if (event.target === search.current && (event.key === 'Home' || event.key === 'End')) return;
      event.preventDefault();
      if (!open) { show(); return; }
      const index = enabled.findIndex(option => option.value === highlighted?.value);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + enabled.length) % enabled.length;
      setActive(enabled[next]?.value ?? ''); return;
    }
    if (event.key === 'Enter' || (event.key === ' ' && event.target !== search.current)) {
      event.preventDefault();
      if (!open) show(); else if (highlighted) choose(highlighted);
      return;
    }
    if (event.target !== search.current && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      if (!open) show();
      const now = Date.now(), key = event.key.toLocaleLowerCase();
      const previous = now - typeahead.current.time < 700 ? typeahead.current.text : '';
      const prefix = previous === key ? key : previous + key;
      typeahead.current = { text: prefix, time: now };
      const matches = options.filter(option => !option.disabled);
      const current = matches.findIndex(option => option.value === active);
      const start = prefix.length > 1 ? Math.max(current, 0) : current + 1;
      const match = matches.map((_, offset) => matches[(start + offset) % matches.length]!).find(option => option.label.toLocaleLowerCase().startsWith(prefix));
      if (match) setActive(match.value);
    }
  }
  useLayoutEffect(() => {
    if (open && blocked()) close();
    if (validationMessage && native.current?.validity.valid) setValidationMessage('');
  });
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      if (!anchor) return;
      const below = window.innerHeight - anchor.bottom - 12, above = anchor.top - 12;
      const upward = below < 200 && above > below;
      const maxHeight = Math.max(80, Math.min(320, upward ? above : below));
      // Measure layout height so the entry scale cannot move an upward-opening list.
      const height = Math.min(panel.current?.offsetHeight ?? maxHeight, maxHeight);
      const width = Math.min(Math.max(anchor.width, 220), window.innerWidth - 16);
      setPosition({ width, maxHeight, left: Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8)), top: upward ? Math.max(8, anchor.top - height - 6) : anchor.bottom + 6 });
    };
    place();
    if (canSearch) search.current?.focus();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(place);
    if (panel.current) observer?.observe(panel.current);
    if (trigger.current) observer?.observe(trigger.current);
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !panel.current?.contains(target)) close();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      observer?.disconnect();
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, canSearch]);
  useEffect(() => {
    if (open && activeId) document.getElementById(activeId)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, activeId]);
  useEffect(() => {
    const form = native.current?.form;
    const reset = () => { setUncontrolled(String(defaultValue ?? '')); setValidationMessage(''); close(); };
    form?.addEventListener('reset', reset);
    return () => form?.removeEventListener('reset', reset);
  }, [defaultValue]);
  const popup = <AnimatePresence>{open && <PopoverSurface key={uid} ref={panel} className="sp-select-panel" style={{ position: 'fixed', ...position }} onKeyDown={navigate}>
    {canSearch && <div className="sp-select-search"><MagnifyingGlass size={16} aria-hidden="true" /><input ref={search} role="combobox" aria-label={`Search ${label}`} aria-controls={listId} aria-expanded="true" aria-autocomplete="list" aria-activedescendant={activeId} value={query} onChange={event => { setQuery(event.target.value); setActive(''); }} placeholder="Search…" /></div>}
    <div id={listId} role="listbox" aria-label={label} className="sp-select-options">
      {filtered.map(option => <button key={option.value} id={`${uid}-option-${options.indexOf(option)}`} type="button" role="option" aria-selected={option.value === selected?.value} aria-disabled={option.disabled || undefined} disabled={option.disabled} tabIndex={-1} data-active={option === highlighted || undefined} onPointerDown={event => event.preventDefault()} onPointerMove={() => { if (!option.disabled) setActive(option.value); }} onClick={() => choose(option)}>
        <span>{option.label}</span><span aria-hidden="true">{option.value === selected?.value && <Check size={16} />}</span>
      </button>)}
      {!filtered.length && <div role="status" className="sp-select-empty">No matches</div>}
    </div>
  </PopoverSurface>}</AnimatePresence>;
  return <span className={`sp-select ${className}`}>
    <button ref={trigger} id={id} type="button" role="combobox" className="sp-select-trigger" autoFocus={autoFocus} disabled={props.disabled} aria-label={label} aria-describedby={[description, validationMessage ? `${uid}-error` : undefined].filter(Boolean).join(' ') || undefined} aria-invalid={invalid ?? (validationMessage ? true : undefined)} aria-required={props.required || undefined} aria-haspopup="listbox" aria-controls={open ? listId : undefined} aria-expanded={open} aria-activedescendant={open && !canSearch ? activeId : undefined} onKeyDown={navigate} onClick={() => open ? close() : show()}>
      <span>{selected?.label ?? 'Choose…'}</span><CaretDown size={14} aria-hidden="true" />
    </button>
    <select {...props} ref={native} hidden aria-hidden="true" tabIndex={-1} value={value ?? uncontrolled} onChange={event => { setUncontrolled(event.target.value); setValidationMessage(event.target.validity.valid ? '' : event.target.validationMessage); onChange?.(event); }} onInvalid={event => { event.preventDefault(); setValidationMessage(event.currentTarget.validationMessage); onInvalid?.(event); trigger.current?.focus(); show(); }}>{options.map(option => <option key={option.value} value={option.value} label={option.label} disabled={option.disabled} />)}</select>
    {validationMessage && <span id={`${uid}-error`} role="alert" className="sp-select-error">{validationMessage}</span>}
    {trigger.current && createPortal(popup, trigger.current.closest('[data-sp-popover-panel], dialog') ?? document.body)}
  </span>;
}
