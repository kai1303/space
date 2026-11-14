import { useId, useLayoutEffect, useRef, useState } from 'react';
import { CaretLeft, CaretRight } from '@phosphor-icons/react';
import type { CarouselBlock } from '@space/contracts';
import { IconButton } from '../primitives/primitives.js';

export function AgentCarousel({ title, cards }: Pick<CarouselBlock, 'title' | 'cards'>) {
  const heading = useId();
  const track = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });

  useLayoutEffect(() => {
    const row = track.current!;
    function measure() {
      const start = row.scrollLeft <= 1;
      const end = row.scrollLeft + row.clientWidth >= row.scrollWidth - 1;
      setEdges(old => old.start === start && old.end === end ? old : { start, end });
    }
    measure();
    row.addEventListener('scroll', measure, { passive: true });
    const resize = new ResizeObserver(measure);
    resize.observe(row);
    return () => { row.removeEventListener('scroll', measure); resize.disconnect(); };
  }, [cards.length]);

  function move(direction: -1 | 1) {
    const row = track.current!;
    const leadingEdge = row.getBoundingClientRect().left;
    const offsets = Array.from(row.children, card => card.getBoundingClientRect().left - leadingEdge);
    const distance = direction === 1 ? offsets.find(offset => offset > 1) : offsets.reverse().find(offset => offset < -1);
    row.scrollBy({ left: distance ?? direction * row.clientWidth });
  }

  return <section className="sp-agent-carousel" aria-roledescription="carousel" aria-labelledby={heading}>
    <header>
      <h4 id={heading}>{title}</h4>
      {(!edges.start || !edges.end) && <div className="sp-agent-carousel-controls">
        <IconButton size="sm" label="Previous card" aria-disabled={edges.start} onClick={() => { if (!edges.start) move(-1); }}><CaretLeft /></IconButton>
        <IconButton size="sm" label="Next card" aria-disabled={edges.end} onClick={() => { if (!edges.end) move(1); }}><CaretRight /></IconButton>
      </div>}
    </header>
    <div className="sp-agent-carousel-track" ref={track} tabIndex={edges.start && edges.end ? -1 : 0}
      role="group" aria-label={title + ' cards'} onKeyDown={event => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        move(event.key === 'ArrowLeft' ? -1 : 1);
      }}>
      {cards.map((card, index) => <article key={card.id} className="sp-work-card sp-agent-result"
        aria-label={card.title + ', ' + (index + 1) + ' of ' + cards.length}>
        <h5>{card.title}</h5><p>{card.body}</p>
      </article>)}
    </div>
  </section>;
}
