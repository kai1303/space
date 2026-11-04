import { useRef, type ReactNode } from 'react';
import { CaretDown, Check } from '@phosphor-icons/react';
import { Popover } from './primitives.js';

export type MultiSelectOption = { value: string; label: string; icon?: ReactNode };

/** Checkbox menu: selecting a row applies immediately and leaves the menu open. */
export function MultiSelectMenu({ label, summary, options, value, onChange }: {
  label: string;
  summary: string;
  options: readonly MultiSelectOption[];
  value: readonly string[];
  onChange: (value: string[]) => void;
}) {
  const search = useRef({ text: '', time: 0 });
  const rows = useRef<HTMLDivElement>(null);
  const changed = options.some(option => !value.includes(option.value));
  return <Popover label={`${label}: ${summary}`} panelLabel={label} role="menu" floating align="start"
    className="sp-menu sp-multiselect" panelClassName="sp-multiselect-panel" triggerClassName="sp-multiselect-trigger"
    trigger={<>{summary}<CaretDown size={12} aria-hidden="true" /></>}>
    {() => <div ref={rows} onKeyDown={event => {
      if (event.key.length !== 1 || event.key === ' ' || event.altKey || event.ctrlKey || event.metaKey) return;
      const now = Date.now(), key = event.key.toLocaleLowerCase();
      const previous = now - search.current.time < 500 ? search.current.text : '';
      const text = previous === key ? key : previous + key;
      search.current = { text, time: now };
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const start = text.length > 1 ? Math.max(current, 0) : current + 1;
      const target = buttons.map((_, offset) => buttons[(start + offset) % buttons.length]!).find(button => button.textContent?.trim().toLocaleLowerCase().startsWith(text));
      if (target) { event.preventDefault(); event.stopPropagation(); target.focus(); }
    }}>
      {options.map(option => {
        const checked = value.includes(option.value);
        return <button key={option.value} type="button" role="menuitemcheckbox" aria-checked={checked} tabIndex={-1}
          onClick={() => onChange(options.filter(item => item.value === option.value ? !checked : value.includes(item.value)).map(item => item.value))}>
          <span className="sp-multiselect-check" aria-hidden="true">{checked && <Check size={16} />}</span>
          <span className="sp-multiselect-icon" aria-hidden="true">{option.icon}</span>
          <span>{option.label}</span>
        </button>;
      })}
      {changed && <><hr role="separator" /><button className="sp-multiselect-reset" type="button" role="menuitem" tabIndex={-1} onClick={() => {
        onChange(options.map(option => option.value));
        rows.current?.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]')?.focus();
      }}>Reset Filters</button></>}
    </div>}
  </Popover>;
}
