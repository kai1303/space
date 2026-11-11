import { ArrowSquareOut, ArrowsInSimple, ArrowsOutSimple, X, type Icon } from '@phosphor-icons/react';

// Ring menu icons come from Phosphor, the icon set used across Space.
const icons = { expand: ArrowsOutSimple, collapse: ArrowsInSimple, open: ArrowSquareOut, dismiss: X } satisfies Record<string, Icon>;
export type GraphIconName = keyof typeof icons;
export const isGraphIcon = (name: string | undefined): name is GraphIconName => !!name && name in icons;
const SIZE = 16;
export function GraphIcon({ name, x, y }: { name: GraphIconName; x: number; y: number }) {
  const Glyph = icons[name];
  return <Glyph className="sp-graph-ring-icon" x={x - SIZE / 2} y={y - SIZE / 2} width={SIZE} height={SIZE} weight="bold" aria-hidden="true" />;
}
