import { createContext, useContext, useLayoutEffect } from 'react';
import { useIsPresent } from 'motion/react';

// A null channel represents a visible workspace screen without a conversation.
// Undefined means another component owns the address (or the view is loading).
export const ConversationLocation = createContext<((channel: string | null, thread?: string) => void) | null>(null);

export function useConversationLocation(channel: string | null | undefined, thread?: string) {
  const publish = useContext(ConversationLocation);
  const present = useIsPresent();
  useLayoutEffect(() => {
    if (present && channel !== undefined) publish?.(channel, thread);
  }, [present, publish, channel, thread]);
}
