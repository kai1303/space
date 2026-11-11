import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";

const HOLD_MS = 450;
const SLOP_PX = 10;

// Touch screens open message actions with a long press, like Slack. Mouse and pen keep hover.
export function useLongPress<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const origin = useRef<{ x: number; y: number }>(undefined);
  const cancel = useCallback(() => { clearTimeout(timer.current); origin.current = undefined; }, []);
  const start = useCallback((event: PointerEvent) => {
    if (event.pointerType !== "touch" || (event.target as Element).closest("button, a, summary, input, [contenteditable=true]")) return;
    cancel();
    origin.current = { x: event.clientX, y: event.clientY };
    timer.current = setTimeout(() => { origin.current = undefined; setOpen(true); }, HOLD_MS);
  }, [cancel]);
  const move = useCallback((event: PointerEvent) => {
    const from = origin.current;
    if (from && Math.hypot(event.clientX - from.x, event.clientY - from.y) > SLOP_PX) cancel();
  }, [cancel]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      const target = event.target as Node;
      // Menus opened from the actions are portaled outside the message; keep the actions open for them.
      if (ref.current?.contains(target) || (target instanceof Element && target.closest("[data-sp-popover-panel]"))) return;
      setOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  useEffect(() => cancel, [cancel]);
  return { ref, open, start, move, cancel, close: () => setOpen(false) };
}
