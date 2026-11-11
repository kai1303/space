import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { GraphCanvas, type GraphLink, type GraphNode } from '@space/ui/graph';

const palette = { channel: 'var(--sp-accent)', thread: 'var(--sp-success)', session: 'var(--sp-warning)' };
function Demo({ threads, parallel }: { threads: number; parallel?: boolean }) {
  const [selected, setSelected] = useState<string>();
  const [expanded, setExpanded] = useState(new Set<string>());
  const toggle = (id: string) => setExpanded(old => { const next = new Set(old); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const nodes: GraphNode[] = [{ id: 'c', kind: 'channel', caption: '#payments' }];
  const links: GraphLink[] = [];
  for (let i = 0; i < threads; i++) {
    nodes.push({ id: `t${i}`, kind: 'thread', caption: `Thread ${i} · in progress` });
    links.push({ id: `ct${i}`, source: 'c', target: `t${i}`, label: 'HAS' });
    if (expanded.has(`t${i}`)) for (const agent of ['Codex', 'Claude']) {
      nodes.push({ id: `s${i}${agent}`, kind: 'session', caption: agent, muted: agent === 'Claude' });
      links.push({ id: `ts${i}${agent}`, source: `t${i}`, target: `s${i}${agent}`, label: 'HAS_SESSION' });
    }
  }
  if (parallel) links.push({ id: 'extra', source: 'c', target: 't0', label: 'MENTIONS' });
  return <div style={{ height: 520 }}><GraphCanvas label="Demo graph" nodes={nodes} links={links} palette={palette} selectedId={selected} expandedIds={expanded}
    onSelect={setSelected} onToggleExpand={toggle}
    menu={id => [{ label: expanded.has(id) ? 'Collapse' : 'Expand', icon: expanded.has(id) ? '−' : '+', onClick: () => toggle(id) }, { label: 'Hide', icon: '✕', onClick: () => setSelected(undefined) }]}
    details={selected ? <p>Selected <strong>{nodes.find(n => n.id === selected)?.caption}</strong></p> : undefined} /></div>;
}
const meta = { title: 'Graph/GraphCanvas', component: Demo } satisfies Meta<typeof Demo>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Small: Story = { args: { threads: 3 } };
export const Crowded: Story = { args: { threads: 40 } };
export const ParallelLinks: Story = { args: { threads: 3, parallel: true } };
