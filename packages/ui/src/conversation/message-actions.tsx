import { useRef, useState } from 'react';
import { ArrowBendUpRight, BellSlash, BookmarkSimple, ChatCircleDots, CheckCircle, Clock, DotsThreeVertical, Link, PencilSimple, PushPin, Smiley, Sparkle, SquaresFour, TextT, Trash, Tray } from '@phosphor-icons/react';
import { EmojiPicker } from '../emoji/emoji-picker.js';
import { IconButton, Menu } from '../primitives/primitives.js';

export type MessageAction = 'selectMessage' | 'discussWithAgent' | 'forward' | 'addTodo' | 'askAgent' | 'edit' | 'markUnread' | 'save' | 'saveMemory' | 'remind' | 'toggleReplyNotifications' | 'copyLink' | 'copyMessage' | 'pin' | 'connectApp' | 'delete';
export type MessageActionHandlers = Partial<Record<MessageAction, () => void | Promise<void>>>;
const menuActions = [
  { key: 'selectMessage', label: 'Select message', icon: CheckCircle },
  { key: 'discussWithAgent', label: 'Discuss with agent', icon: Sparkle },
  { key: 'edit', label: 'Edit message', icon: PencilSimple },
  { key: 'markUnread', label: 'Mark unread', icon: Tray, separatorBefore: true },
  { key: 'save', label: 'Add to saved', icon: BookmarkSimple },
  { key: 'saveMemory', label: 'Save to channel memory', icon: Sparkle },
  { key: 'remind', label: 'Add a reminder', icon: Clock },
  { key: 'toggleReplyNotifications', label: 'Turn off notifications for replies', icon: BellSlash },
  { key: 'copyLink', label: 'Copy link', icon: Link, separatorBefore: true },
  { key: 'copyMessage', label: 'Copy message', icon: TextT },
  { key: 'pin', label: 'Pin to channel', icon: PushPin, separatorBefore: true },
  { key: 'connectApp', label: 'Connect to apps', icon: SquaresFour, separatorBefore: true },
  { key: 'delete', label: 'Delete message…', icon: Trash, separatorBefore: true, danger: true },
] as const;

export function MessageActions({ author, onReply, onReact, actions = {} }: {
  author: string;
  onReply?: () => void;
  onReact?: (emoji: string) => void;
  actions?: MessageActionHandlers;
}) {
  const [notice, setNotice] = useState('');
  const [failed, setFailed] = useState(false);
  const busy = useRef(false);
  async function run(key: MessageAction, label: string) {
    if (busy.current) return;
    busy.current = true; setNotice(''); setFailed(false);
    try { await actions[key]?.(); if (key === 'copyLink' || key === 'copyMessage') setNotice(`${label === 'Copy link' ? 'Link' : 'Message'} copied`); else if (key === 'save') setNotice('Message saved'); else if (key === 'addTodo') setNotice('Added to your to-dos'); }
    catch { setFailed(true); setNotice(`Could not ${label.replace('…', '').toLowerCase()}. Try again.`); }
    finally { busy.current = false; }
  }
  const items = menuActions.filter(item => actions[item.key]).map((item, index) => ({
    label: item.label, icon: <item.icon size={18} />, danger: 'danger' in item && item.danger,
    separatorBefore: index > 0 && 'separatorBefore' in item && item.separatorBefore,
    onSelect: () => { void run(item.key, item.label); },
  }));
  return <>
    <div className="sp-message-actions" role="group" aria-label={`Message actions for ${author}`}>
      {onReact && <>
        {([['✅', 'white check mark'], ['👀', 'eyes'], ['🙌', 'raised hands']] as const).map(([emoji, label]) => <IconButton key={emoji} label={`React with ${label}`} size="sm" onClick={() => onReact(emoji)}><span className="sp-message-quick-emoji" aria-hidden="true">{emoji}</span></IconButton>)}
        <EmojiPicker label="Add reaction…" className="sp-message-emoji-menu" trigger={<Smiley size={20} />} onSelect={onReact} />
      </>}
      {onReply && <IconButton label={`Reply to ${author}`} title="Reply in thread" size="sm" onClick={onReply}><ChatCircleDots size={20} /></IconButton>}
      {actions.forward && <IconButton label="Forward message…" size="sm" onClick={() => { void run('forward', 'Forward message'); }}><ArrowBendUpRight size={20} /></IconButton>}
      {actions.addTodo && <IconButton label="Add to-do" size="sm" onClick={() => { void run('addTodo', 'Add to-do'); }}><CheckCircle size={20} /></IconButton>}
      {actions.askAgent && <IconButton label="Ask an agent" size="sm" onClick={() => { void run('askAgent', 'Ask an agent'); }}><Sparkle size={20} /></IconButton>}
      {items.length > 0 && <Menu label="More actions" menuLabel="Message actions" className="sp-message-menu" floating trigger={<DotsThreeVertical size={20} />} items={items} />}
    </div>
    {notice && <span className={`sp-message-action-notice${failed ? ' is-error' : ''}`} role={failed ? 'alert' : 'status'}>{notice}</span>}
  </>;
}
