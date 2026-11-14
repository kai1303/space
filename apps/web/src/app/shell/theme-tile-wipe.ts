import './theme-tile-wipe.css';

function rectangle(x: number, y: number, width: number, height: number) {
  return `M${x} ${y}h${width}v${height}h${-width}Z`;
}

// Each row has one fully revealed span and a narrow band of growing tiles at either end.
function revealFrames(width: number, height: number, originX: number, originY: number) {
  const tile = Math.max(14, Math.ceil(width / 140), 2 * Math.ceil(height / 85));
  const rowHeight = Math.ceil(tile / 2);
  const band = 5 * tile;
  const reach = Math.max(originX, width - originX) + Math.max(originY, height - originY);
  return Array.from({ length: 37 }, (_, frame) => {
    const radius = frame / 36 * (reach + band);
    let path = 'M0 0Z';
    for (let y = 0; y < height; y += rowHeight) {
      const remaining = radius - Math.abs(y + rowHeight / 2 - originY);
      if (remaining <= 0) continue;
      const first = Math.max(0, Math.ceil((originX - remaining) / tile - 0.5));
      const last = Math.min(Math.ceil(width / tile) - 1, Math.floor((originX + remaining) / tile - 0.5));
      const solidStart = Math.max(first, Math.ceil((originX - remaining + band) / tile - 0.5));
      const solidEnd = Math.min(last, Math.floor((originX + remaining - band) / tile - 0.5));
      for (let col = first; col <= last; col++) {
        if (col === solidStart && solidStart <= solidEnd) {
          path += rectangle(col * tile, y, (solidEnd - col + 1) * tile, rowHeight);
          col = solidEnd;
          continue;
        }
        const fraction = (remaining - Math.abs((col + 0.5) * tile - originX)) / band;
        const w = Math.round(tile * fraction), h = Math.round(rowHeight * fraction);
        if (w && h) path += rectangle(col * tile + Math.floor((tile - w) / 2), y + Math.floor((rowHeight - h) / 2), w, h);
      }
    }
    return { clipPath: `path('${path}')`, easing: 'steps(1, end)' };
  });
}

export function startThemeTileWipe(button: HTMLElement, applyTheme: () => void, done: () => void) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (!document.startViewTransition || reduced.matches) {
    applyTheme();
    done();
    return;
  }

  const bounds = button.getBoundingClientRect();
  const root = document.documentElement;
  const directions = ['left', 'right', 'up', 'down'] as const;
  root.dataset.themeWipe = directions[Math.floor(Math.random() * directions.length)];
  let cancelled = false;
  const transition = document.startViewTransition(() => { if (!cancelled) applyTheme(); });
  const skip = () => transition.skipTransition();
  window.addEventListener('resize', skip);
  reduced.addEventListener('change', skip);
  // View transitions keep the old workspace visible behind the clipped new workspace.
  void transition.ready.then(() => {
    const frames = revealFrames(window.innerWidth, window.innerHeight, bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    root.animate(frames, { duration: 560, fill: 'both', pseudoElement: '::view-transition-new(root)' });
  }).catch(skip);
  void transition.finished.finally(() => {
    delete root.dataset.themeWipe;
    window.removeEventListener('resize', skip);
    reduced.removeEventListener('change', skip);
    done();
  });
  return () => { cancelled = true; skip(); };
}
