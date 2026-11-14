import { useEffect, useState } from 'react';
import type { CreateSidebarSection, SidebarSectionsSnapshot, UpdateSidebarSection } from '@space/contracts';
import { errorText } from '../../shared/api/error-text.js';
import { request } from '../../shared/api/request.js';
import { invalidateUpdates, subscribeUpdates } from '../../shared/realtime/live-updates.js';

const empty: SidebarSectionsSnapshot = { sections: [], assignments: [] };

export function useSidebarSections(workspace: string, viewer: string) {
  const key = `${workspace}:${viewer}`;
  const base = `/workspaces/${workspace}/sidebar-sections`;
  const [state, setState] = useState({ key: '', snapshot: empty, error: '' });

  useEffect(() => {
    const controller = new AbortController();
    const stop = subscribeUpdates('sidebar-sections', workspace, async () => {
      try {
        const snapshot = await request<SidebarSectionsSnapshot>(base, undefined, undefined, 'POST', controller.signal, viewer);
        if (!controller.signal.aborted) setState({ key, snapshot, error: '' });
      } catch (reason) {
        if (!controller.signal.aborted) setState({ key, snapshot: empty, error: errorText(reason) });
      }
    }, code => {
      controller.abort();
      setState({ key, snapshot: empty, error: errorText(new Error(code)) });
    });
    return () => { controller.abort(); stop(); };
  }, [base, key, workspace, viewer]);

  async function write(path: string, body: object | undefined, method: 'POST' | 'PUT' | 'PATCH' | 'DELETE') {
    await request(path, body, undefined, method, undefined, viewer);
    await invalidateUpdates('sidebar-sections', workspace);
  }

  const current = state.key === key ? state : undefined;
  return {
    sections: current?.snapshot.sections ?? empty.sections,
    assignments: current?.snapshot.assignments ?? empty.assignments,
    error: current?.error,
    create: (section: CreateSidebarSection) => write(base, section, 'POST'),
    update: (id: string, patch: UpdateSidebarSection) => write(`${base}/${id}`, patch, 'PATCH'),
    remove: (id: string) => write(`${base}/${id}`, undefined, 'DELETE'),
    move: (channel: string, section_id: string | null) =>
      write(`/workspaces/${workspace}/sidebar-section-assignments/${channel}`, { section_id }, 'PUT'),
  };
}
