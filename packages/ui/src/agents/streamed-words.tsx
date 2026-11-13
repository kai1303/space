import { memo, useLayoutEffect, useRef, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { useStreamingText, wordFadeMs, words } from './streaming-text.js';

// Keep the settled prefix in one text node and only mount Motion spans near the leading edge.
export const StreamedWords = memo(function StreamedWords({ text, from }: { text: string; from: number }) {
  if (!words || from >= text.length) return text;
  const boundary = words.segment(text).containing(from);
  const start = boundary && boundary.index < from ? boundary.index + boundary.segment.length : from;
  const parts: ReactNode[] = [text.slice(0, start)];
  for (const { segment, index } of words.segment(text.slice(start))) {
    parts.push(segment.trim() ? (
      <motion.span key={start + index} className="sp-agent-word" initial={{ opacity: 0 }} animate={{ opacity: 1 }}
        transition={{ duration: wordFadeMs / 1000, ease: [0.37, 0.55, 0.86, 0.88] }}>{segment}</motion.span>
    ) : segment);
  }
  return <>{parts}</>;
});

export function SessionTitle({title}: {title:string}) {
  const previous = useRef(title);
  const changed = previous.current !== title;
  useLayoutEffect(() => { previous.current = title; }, [title]);
  return <TitleReveal key={title} title={title} changed={changed}/>;
}

function TitleReveal({title, changed}: {title:string; changed:boolean}) {
  const visible = useStreamingText(title, false, changed);
  if (visible.fadeFrom === undefined) return title;
  return <>
    <span className="sp-sr-only">{title}</span>
    <span aria-hidden="true"><StreamedWords text={visible.text} from={visible.fadeFrom}/></span>
  </>;
}
