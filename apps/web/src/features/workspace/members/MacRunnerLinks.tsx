import { useEffect, useState } from 'react';
import type { LocalProvider } from '@space/contracts';

export function MacRunnerLinks({ workspace, provider }: { workspace: string; provider: LocalProvider }) {
  const [architectures, setArchitectures] = useState<string[]>([]);
  const download = import.meta.env.VITE_SPACE_MAC_DOWNLOAD_URL;
  useEffect(() => {
    if (download) return;
    const controller = new AbortController();
    void fetch('/downloads/macos.json', { signal: controller.signal }).then(async response => {
      if (!response.ok) return;
      const list: unknown = await response.json();
      if (Array.isArray(list) && !controller.signal.aborted) setArchitectures(['arm64', 'x64', 'universal'].filter(arch => list.includes(arch)));
    }).catch(() => {});
    return () => controller.abort();
  }, [download]);
  const query = new URLSearchParams({ origin: window.location.origin, workspace, provider });
  return <div className="space-mac-runner-links">
    <a href={`space-desktop://connect?${query}`}>Open Space Desktop</a>
    {download ? <a href={download}>Download for Mac</a> : architectures.map(arch =>
      <a key={arch} href={`/downloads/Space-${arch}.dmg`} download>Download for {arch === 'arm64' ? 'Apple silicon' : arch === 'x64' ? 'Intel Mac' : 'Mac'}</a>)}
  </div>;
}
