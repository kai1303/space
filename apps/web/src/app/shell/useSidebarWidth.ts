import { useEffect, useState } from 'react';

export function useSidebarWidth() {
  // Captured widths track about 24% of the workspace after its 70px rail and 4px frame.
  const [sidebarRatio, setSidebarRatio] = useState(.24);
  const [layoutWidth, setLayoutWidth] = useState(() => Math.max(1, window.innerWidth - 74));
  // In Desktop the browser shares this viewport with chat. Keep navigation at
  // its chosen width while the browser opens, leaving room for the conversation.
  const [desktopWidth, setDesktopWidth] = useState(() => Math.round(layoutWidth * .24));
  const desktop = !!window.spaceDesktop;
  const preferred = desktop ? Math.min(desktopWidth, layoutWidth - 320) : layoutWidth * sidebarRatio;
  const sidebarWidth = Math.max(180, Math.min(450, Math.round(preferred)));
  const setSidebarWidth = (width: number) => {
    if (desktop) setDesktopWidth(width);
    else setSidebarRatio(width / layoutWidth);
  };
  useEffect(() => {
    const resize = () => setLayoutWidth(Math.max(1, window.innerWidth - 74));
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  return { sidebarWidth, setSidebarWidth };
}
