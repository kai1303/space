import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EmojiPicker } from './emoji-picker.js';
import { emojiNative, searchEmoji, replaceEmojiShortcodes, emojiDocument } from './emoji.js';
afterEach(() => { cleanup(); window.localStorage.clear(); });
it('searches aliases, human names and keywords across the complete catalog', () => {
  expect(searchEmoji(':+1:')[0]?.id).toBe('+1');
  expect(searchEmoji('thumbsup')[0]?.id).toBe('+1');
  expect(searchEmoji('rocket').some(e => e.id === 'rocket')).toBe(true);
  expect(searchEmoji('nothing-like-this-xyz')).toEqual([]);
  expect(emojiNative('+1', 4)).toBe('👍🏽');
  expect(emojiNative('rocket', 4)).toBe('🚀');
});
it('converts known shortcodes and skin tones while retaining unknown names and code', () => {
  expect(replaceEmojiShortcodes(':thumbsup::skin-tone-4: :tada: :unknown:')).toBe('👍🏽 🎉 :unknown:');
  expect(emojiDocument({ops:[{insert:':tada:',attributes:{bold:true}},{insert:' :tada:',attributes:{code:true}},{insert:'\n'},{insert:':tada:'},{insert:'\n',attributes:{'code-block':true}}]})).toEqual({ops:[{insert:'🎉',attributes:{bold:true}},{insert:' :tada:',attributes:{code:true}},{insert:'\n'},{insert:':tada:'},{insert:'\n',attributes:{'code-block':true}}]});
});
it('searches in a floating picker, selects a tone and remembers selections', async () => {
  const select = vi.fn();
  render(<EmojiPicker label="Choose emoji" onSelect={select} />);
  const trigger = screen.getByRole('button',{name:'Choose emoji'});
  await userEvent.click(trigger);
  const picker = screen.getByRole('dialog',{name:'Choose emoji'});
  await userEvent.type(within(picker).getByRole('searchbox',{name:'Search emoji'}),'thumbsup');
  await userEvent.click(within(picker).getByRole('button',{name:/Select your default skin tone/}));
  await userEvent.click(within(picker).getByRole('radio',{name:'Medium skin tone',exact:true}));
  await userEvent.click(within(picker).getByRole('button',{name:'👍🏽 :+1:'}));
  expect(select).toHaveBeenCalledWith('👍🏽');
  expect(document.activeElement).toBe(trigger);
  await userEvent.click(trigger);
  expect(screen.getByRole('heading',{name:'Frequently Used'})).toBeTruthy();
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('dialog',{name:'Choose emoji'})).toBeNull();
});
it('treats inherited object names as unknown shortcodes and preserves URLs', () => {
  expect(replaceEmojiShortcodes(':constructor: :__proto__: :toString: https://example.test/:tada:')).toBe(':constructor: :__proto__: :toString: https://example.test/:tada:');
});
it('applies the preferred tone unless the shortcode requests an explicit tone', () => {
  expect(replaceEmojiShortcodes(':thumbsup: :thumbsup::skin-tone-2:', 4)).toBe('👍🏽 👍🏻');
});

it('offers six hand swatches and closes only the tone options on Escape', async () => {
  render(<EmojiPicker onSelect={() => {}} />);
  await userEvent.click(screen.getByRole('button',{name:'Choose emoji'}));
  const tone = screen.getByRole('button',{name:/Select your default skin tone/});
  await userEvent.click(tone);
  expect(screen.getAllByRole('radio')).toHaveLength(6);
  await userEvent.keyboard('{ArrowRight}');
  expect(screen.getByRole('radio',{name:'Light skin tone',exact:true}).getAttribute('aria-checked')).toBe('true');
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('radiogroup')).toBeNull();
  expect(screen.getByRole('dialog',{name:'Choose emoji'})).toBeTruthy();
  expect(document.activeElement).toBe(tone);
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('dialog',{name:'Choose emoji'})).toBeNull();
});
