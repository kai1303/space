import { useRef, useState, useId, useLayoutEffect, type ReactNode } from 'react';
import { Smiley, ClockCounterClockwise, Leaf, Coffee, SoccerBall, Airplane, Lightbulb, Heart, Flag } from '@phosphor-icons/react';
import { Popover } from '../primitives/primitives.js';
import { categoryEmoji, emojiById, emojiCategories, emojiNative, searchEmoji, emojiPreferences, saveEmojiPreferences } from './emoji.js';
export function EmojiPicker({ label = 'Choose emoji', trigger = <Smiley size={19} />, onSelect, disabled = false, restoreFocus = true, className = '' }: {
  label?: string; trigger?: ReactNode; onSelect: (emoji: string) => void; disabled?: boolean; restoreFocus?: boolean; className?: string;
}) {
  return <Popover label={label} trigger={trigger} disabled={disabled} floating className={`sp-emoji-trigger ${className}`} panelClassName="sp-emoji-popover">
    {close => <EmojiOptions label={label} disabled={disabled} onSelect={emoji => { onSelect(emoji); close(restoreFocus); }} />}
  </Popover>;
}
function EmojiOptions({ label, onSelect, disabled }: { label: string; onSelect: (emoji: string) => void; disabled: boolean }) {
  const [query, setQuery] = useState(''), [category, setCategory] = useState('frequent');
  const [prefs, setPrefs] = useState(emojiPreferences), [preview, setPreview] = useState('');
  const grid = useRef<HTMLDivElement>(null);
  const [skinOpen, setSkinOpen] = useState(false);
  const skinButton = useRef<HTMLButtonElement>(null), skinOptions = useRef<HTMLDivElement>(null);
  const skinId = useId(), resultsId = useId();
  useLayoutEffect(() => {
    if (skinOpen) skinOptions.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
  }, [skinOpen, prefs.skin]);
  const skinNames = ['No skin tone', 'Light skin tone', 'Medium-light skin tone', 'Medium skin tone', 'Medium-dark skin tone', 'Dark skin tone'];
  function setSkin(skin: number, close = true) {
    const next = { ...prefs, skin }; setPrefs(next); saveEmojiPreferences(next);
    if (close) { setSkinOpen(false); skinButton.current?.focus(); }
  }
  const icons = [ClockCounterClockwise, Smiley, Leaf, Coffee, SoccerBall, Airplane, Lightbulb, Heart, Flag];
  const defaults = ['white_check_mark', 'eyes', 'raised_hands', 'pray', '+1', 'tada', 'heart', 'rocket', 'wave'];
  const frequent = [...new Set(prefs.recent)].sort((a, b) => prefs.recent.filter(id => id === b).length - prefs.recent.filter(id => id === a).length);
  const groups = query.trim() ? [{ id: 'search', name: 'Search results', items: searchEmoji(query) }]
    : category === 'frequent' ? [{ id: 'frequent', name: 'Frequently Used', items: [...new Set([...frequent, ...defaults])].flatMap(id => { const emoji = emojiById(id); return emoji ? [emoji] : []; }) }, ...emojiCategories.map(([id, name]) => ({ id, name, items: categoryEmoji(id) }))]
    : emojiCategories.filter(([id]) => id === category).map(([id, name]) => ({ id, name, items: categoryEmoji(id) }));
  function pick(id: string) {
    const next = { ...prefs, recent: [id, ...prefs.recent].slice(0, 24) };
    setPrefs(next); setQuery(''); setCategory('frequent'); saveEmojiPreferences(next); onSelect(emojiNative(id, prefs.skin));
  }
  return <section role="dialog" aria-label={label} className="sp-emoji-picker" onKeyDown={event => {
    if (event.key === 'Tab') { event.stopPropagation(); return; }
    if (skinOpen && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setSkinOpen(false); skinButton.current?.focus(); return; }
    if (event.key === 'Escape') return;
    if (skinOptions.current?.contains(event.target as Node) && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const skin = event.key === 'Home' ? 1 : event.key === 'End' ? 6 : (prefs.skin - 1 + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1) + 6) % 6 + 1;
      setSkin(skin, false); return;
    }
    const search = event.target instanceof HTMLInputElement;
    if (search && event.key !== 'ArrowDown') { event.stopPropagation(); return; }
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const buttons = [...(grid.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const offset = event.key === 'ArrowDown' ? 9 : event.key === 'ArrowUp' ? -9 : event.key === 'ArrowLeft' ? -1 : 1;
    const next = search || event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, current + offset));
    buttons[next]?.focus();
  }}>
    <header><strong>Emoji</strong><label className="sp-emoji-search"><span className="sp-sr-only">Search emoji</span><input autoFocus type="search" placeholder="Search all emoji" value={query} onChange={event => { setQuery(event.target.value); grid.current?.scrollTo?.(0, 0); }} /></label></header>
    <div role="tablist" aria-label="Emoji categories" className="sp-emoji-categories">
      {[['frequent', 'Frequently Used'], ...emojiCategories].map(([id, name], index) => { const Icon = icons[index]!; return <button key={id} type="button" id={`${resultsId}-${id}`} role="tab" aria-controls={resultsId} aria-label={name} title={name} aria-selected={category === id && !query} onClick={() => { setCategory(id!); setQuery(''); grid.current?.scrollTo?.(0, 0); }}><Icon size={18} /></button>; })}
    </div>
    <div ref={grid} id={resultsId} role="tabpanel" aria-label={query ? "Search results" : groups[0]?.name} className="sp-emoji-results">
      {groups.map(group => <section key={group.id} aria-label={group.name}><h3>{group.name}</h3><div className="sp-emoji-grid">
        {group.items.map((emoji, index) => { const native = emojiNative(emoji.id, prefs.skin), name = `${native} :${emoji.id}:`; return <button type="button" key={emoji.id} tabIndex={index === 0 ? 0 : -1} disabled={disabled} aria-label={name} title={`${emoji.name} :${emoji.id}:`} onFocus={() => setPreview(emoji.id)} onMouseEnter={() => setPreview(emoji.id)} onClick={() => pick(emoji.id)}>{native}</button>; })}
      </div>{!group.items.length && <p role="status">No emoji found. Try another name.</p>}</section>)}
    </div>
    <footer><span className="sp-emoji-preview">{preview ? `${emojiNative(preview, prefs.skin)} :${preview}:` : 'Find your emoji'}</span><div className="sp-emoji-skin">
      <button ref={skinButton} type="button" className="sp-emoji-skin-trigger" aria-label={`Select your default skin tone, currently selected: ${skinNames[prefs.skin - 1]}.`} aria-expanded={skinOpen} aria-controls={skinId} onClick={() => {
        setSkinOpen(!skinOpen);
      }}><span aria-hidden="true">{emojiNative('hand', prefs.skin)}</span> Skin tone</button>
      {skinOpen && <div ref={skinOptions} id={skinId} role="radiogroup" aria-label="Choose your default skin tone" className="sp-emoji-skin-options">
        {skinNames.map((name, index) => <button key={name} type="button" role="radio" data-skin={index + 1} tabIndex={prefs.skin === index + 1 ? 0 : -1} aria-checked={prefs.skin === index + 1} aria-label={name} title={name} onClick={() => setSkin(index + 1)}>{emojiNative('hand', index + 1)}</button>)}
      </div>}
    </div></footer>
  </section>;
}
