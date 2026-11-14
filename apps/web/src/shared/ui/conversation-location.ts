import { createContext, useContext, useLayoutEffect } from 'react';
import { conversationPath } from '@space/contracts';
import { useIsPresent } from 'motion/react';

// A null channel represents a visible workspace screen without a conversation.
// Undefined means another component owns the address (or the view is loading).
export const ConversationLocation = createContext<((path: string | null) => void) | null>(null);

// A mounted conversation can resume its own history entries without rebuilding the workspace.
export type RestoreConversation = (from: string, to: string) => boolean;
export const ConversationHistory = createContext<{ current: RestoreConversation | null } | null>(null);

export function useConversationLocation(channel: string | null | undefined, thread?: string) {
  usePublishedPath(channel ? conversationPath(channel, thread) : channel);
}

export function usePublishedPath(path: string | null | undefined) {
  const publish = useContext(ConversationLocation);
  const present = useIsPresent();
  useLayoutEffect(() => {
    if (present && path !== undefined) publish?.(path);
  }, [present, publish, path]);
}
