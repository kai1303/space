import { useLayoutEffect, useRef, useState } from 'react';
import type { SidekickSource } from '@space/contracts';
import type { Snapshot } from '../../shared/ui/view-state.js';
import type { ConversationView } from './view-state.js';

type Panel = {kind:'thread'; id:string} | {kind:'session'} | {kind:'sidekick'; source:SidekickSource} | {kind:'files'};
export function useConversationPanels(view: Snapshot<ConversationView> | undefined, requestedThread?: string, mentionTarget?: string) {
  const restored = requestedThread || mentionTarget ? undefined : view?.current;
  // Keep the session mounted while hidden so an unfinished turn survives navigation.
  const [sessionView, setSessionView] = useState(restored?.sessionView);
  const [panel, setPanel] = useState<Panel | undefined>(() => {
    const thread = requestedThread ?? restored?.thread;
    if (thread) return {kind:'thread', id:thread};
    if (restored?.sessionOpen && restored.sessionView) return {kind:'session'};
  });
  const thread = panel?.kind === 'thread' ? panel.id : undefined;
  const sessionOpen = panel?.kind === 'session';
  useLayoutEffect(() => {
    if (view) view.current = {thread, sessionView, sessionOpen};
  }, [view, thread, sessionView, sessionOpen]);

  const threadPanel = useRef<HTMLElement>(null), sessionPanel = useRef<HTMLElement>(null), sidekickPanel = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLElement | null>(null), focused = useRef<HTMLElement | null>(null);
  function open(next: Panel) {
    const source = document.activeElement;
    if (source instanceof HTMLElement && !source.closest('.chat-thread, dialog')) trigger.current = source;
    setPanel(next);
  }
  useLayoutEffect(() => {
    const element = panel?.kind === 'sidekick' ? sidekickPanel.current : sessionOpen ? sessionPanel.current : thread ? threadPanel.current : null;
    if (element) element.focus({preventScroll:true});
    else if (focused.current && (document.activeElement === document.body || focused.current.contains(document.activeElement))) {
      const source = trigger.current;
      const target = source?.isConnected && !source.closest('[inert], [hidden], [aria-hidden="true"]') ? source : document.getElementById('chat-messages');
      target?.focus({preventScroll:true});
    }
    focused.current = element;
  }, [panel, sessionOpen, thread, sessionView?.selected]);

  return {
    thread, sessionOpen, sessionView, threadPanel, sessionPanel, sidekickPanel,
    filesOpen: panel?.kind === 'files', sidekick: panel?.kind === 'sidekick' ? panel : undefined,
    close: () => setPanel(undefined),
    clear: () => { setPanel(undefined); setSessionView(undefined); },
    openThread: (id:string) => open({kind:'thread', id}),
    openSessions: (thread:string, selected:string, artifact?:NonNullable<import('@space/contracts').SessionReport['artifact']>) => { setSessionView(previous => ({thread, selected, artifact, artifactRequest:(previous?.artifactRequest ?? 0) + 1})); open({kind:'session'}); },
    openFiles: () => open({kind:'files'}),
    openSidekick: (source:SidekickSource) => open({kind:'sidekick', source}),
  };
}
