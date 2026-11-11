// Line icons for the ring menu, drawn on a 16 × 16 grid centred on 0,0. Original artwork for Space.
export type GraphIconName = 'expand' | 'collapse' | 'dismiss' | 'open';
const paths: Record<GraphIconName, string> = {
  // Four arrows pointing out from the centre.
  expand: 'M-2,-6H-6V-2 M-6,-6L-2,-2 M2,-6H6V-2 M6,-6L2,-2 M-2,6H-6V2 M-6,6L-2,2 M2,6H6V2 M6,6L2,2',
  // Four arrows pointing in to the centre.
  collapse: 'M-6,-2H-2V-6 M-2,-2L-6,-6 M6,-2H2V-6 M2,-2L6,-6 M-6,2H-2V6 M-2,2L-6,6 M6,2H2V6 M2,2L6,6',
  // A cross.
  dismiss: 'M-5,-5L5,5 M5,-5L-5,5',
  // An arrow leaving a box.
  open: 'M-1,-5H-5V5H5V1 M1,-5H5V-1 M5,-5L-1,1',
};
export const isGraphIcon = (name: string | undefined): name is GraphIconName => !!name && name in paths;
export function GraphIcon({ name, x, y }: { name: GraphIconName; x: number; y: number }) {
  return <path className="sp-graph-ring-icon" transform={`translate(${x},${y}) scale(0.9)`} d={paths[name]} />;
}
