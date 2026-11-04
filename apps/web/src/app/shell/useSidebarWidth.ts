import { useEffect, useState } from 'react';

export function useSidebarWidth() {
  // Captured widths track about 24% of the workspace after its 70px rail and 4px frame.
  const [sidebarRatio, setSidebarRatio] = useState(.24);
  const [layoutWidth, setLayoutWidth] = useState(() => Math.max(1, window.innerWidth - 74));
  const sidebarWidth = Math.max(180, Math.min(450, Math.round(layoutWidth * sidebarRatio)));
  const setSidebarWidth = (width: number) => setSidebarRatio(width / layoutWidth);
  useEffect(() => {
    const resize = () => setLayoutWidth(Math.max(1, window.innerWidth - 74));
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  return { sidebarWidth, setSidebarWidth };
}
