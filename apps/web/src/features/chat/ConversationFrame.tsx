import { createContext, useContext, useLayoutEffect, useRef, useState, useSyncExternalStore, type ComponentProps, type ReactNode } from 'react';
import { RichComposer } from '@space/ui/composer';
import { createPortal } from 'react-dom';

// The sidebar, split panels and agent tabs position the same primary conversation
// in different parents. Keep its DOM and editor owner alive above those layouts.
function createFrame() {
  const main = document.createElement('main');
  const header = document.createElement('header');
  header.className = 'chat-channel-header';
  const footer = document.createElement('div');
  footer.style.display = 'contents';
  // An empty DM picker has no room controller. Park the editor with no draft or
  // live callbacks until the next controller claims it.
  const idle = <div className="chat-compose" inert>{null}<RichComposer channel="conversation"
    conversationKey="idle" sendDisabled attachmentsEnabled={false} onSend={() => {}}/></div>;
  let composer: ReactNode = null;
  let owner: symbol | null = null;
  const listeners = new Set<() => void>();
  return {
    main, header, footer,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    read: () => composer,
    publish(source: symbol, next: ReactNode) {
      if (next === null && owner !== source) return;
      owner = next === null ? null : source;
      composer = next ?? idle;
      for (const listener of listeners) listener();
    },
  };
}

type Frame = ReturnType<typeof createFrame>;
const FrameContext = createContext<Frame | null>(null);

function MountedComposer({ frame }: { frame: Frame }) {
  return createPortal(useSyncExternalStore(frame.subscribe, frame.read), frame.footer);
}

export function ConversationFrameProvider({ children }: { children: ReactNode }) {
  const [frame] = useState(createFrame);
  return <FrameContext.Provider value={frame}>{children}<MountedComposer frame={frame}/></FrameContext.Provider>;
}

function Placement({ node }: { node: HTMLElement }) {
  const marker = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const anchor = marker.current!;
    anchor.before(node);
    return () => { if (node.nextSibling === anchor) node.remove(); };
  }, [node]);
  return <span hidden ref={marker}/>;
}

export function ConversationMain({ primary = true, retainContents = false, children, className, inert, id, tabIndex = -1, 'aria-hidden': hidden, 'aria-label': label, style }: ComponentProps<'main'> & { primary?: boolean; retainContents?: boolean }) {
  const frame = useContext(FrameContext);
  // A source-message citation can move an agent timeline into a hidden pane.
  // Keep that timeline's React owner and scroll position when its main changes.
  const [content] = useState(() => {
    if (!retainContents) return null;
    const holder = document.createElement('div');
    holder.style.display = 'contents';
    return holder;
  });
  const node = primary && frame ? frame.main : null;
  useLayoutEffect(() => {
    if (!node) return;
    node.className = className ?? '';
    node.id = id ?? '';
    node.tabIndex = tabIndex;
    node.toggleAttribute('inert', !!inert);
    if (hidden) node.setAttribute('aria-hidden', String(hidden)); else node.removeAttribute('aria-hidden');
    if (label) node.setAttribute('aria-label', label); else node.removeAttribute('aria-label');
  }, [node, className, id, tabIndex, inert, hidden, label]);
  const body = content ? <Placement node={content}/> : children;
  return <>{node ? <><Placement node={node}/>{createPortal(body, node)}</>
    : <main {...{ className, inert, id, tabIndex, style }} aria-hidden={hidden} aria-label={label}>{body}</main>}
    {content && createPortal(children, content)}</>;
}

export function FrameHeader({ primary, children }: { primary?: boolean; children: ReactNode }) {
  const frame = useContext(FrameContext);
  if (!primary || !frame) return <header className="chat-channel-header">{children}</header>;
  return <><Placement node={frame.header}/>{createPortal(children, frame.header)}</>;
}

export function FrameComposer({ children }: { children: ReactNode }) {
  const frame = useContext(FrameContext);
  const [owner] = useState(() => Symbol());
  useLayoutEffect(() => { frame?.publish(owner, children); }, [frame, owner, children]);
  useLayoutEffect(() => () => frame?.publish(owner, null), [frame, owner]);
  return frame ? <Placement node={frame.footer}/> : children;
}
