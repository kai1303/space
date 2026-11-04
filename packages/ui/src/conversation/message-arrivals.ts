import { useEffect, useRef } from "react";

// Context identifies the visible conversation; null means its feed is hidden.
export function useMessageArrivals(
  messages: readonly { id: string }[],
  context: string | null,
) {
  const ids = new Set(messages.map((message) => message.id));
  const previous = useRef({ ids, context });
  const arrivals = new Set(
    context !== null && context === previous.current.context
      ? [...ids].filter((id) => !previous.current.ids.has(id))
      : [],
  );
  useEffect(() => {
    previous.current = { ids, context };
  });
  return arrivals;
}
