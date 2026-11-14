import { useEffect, useRef, useState } from 'react';
import type { RichDocument, SessionTeamView } from '@space/contracts';
import { request } from '../../shared/api/request.js';
import { invalidateUpdates, subscribeUpdates } from '../../shared/realtime/live-updates.js';

type DiscussionPage = Pick<SessionTeamView, 'messages' | 'before' | 'writable'>;

export function useSessionDiscussion(id: string, viewer: string, enabled: boolean) {
  const path = '/agent-sessions/' + id + '/team/discussion';
  const [page, setPage] = useState<DiscussionPage>();
  const [cursor, setCursor] = useState('');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const attempt = useRef<{ text: string; key: string } | undefined>(undefined);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const revoke = () => {
      controller.abort();
      setPage(undefined);
      setError('Team discussion is unavailable.');
    };
    const stop = subscribeUpdates('session-team', id, async () => {
      try {
        const url = cursor ? path + '?before=' + cursor : path;
        const data = await request<DiscussionPage>(url, undefined, undefined, undefined, controller.signal, viewer);
        if (!controller.signal.aborted) {
          setPage(data);
          setError('');
        }
      } catch (reason) {
        if (controller.signal.aborted) return;
        if (reason instanceof Error && ['forbidden', 'unauthorized', 'not_found', 'actor_changed'].includes(reason.message)) revoke();
        else setError('Could not load team discussion.');
      }
    }, revoke);
    return () => {
      controller.abort();
      stop();
    };
  }, [id, viewer, enabled, path, cursor, retry]);

  async function post(text: string, document?: RichDocument) {
    const content = JSON.stringify({text, document});
    if (attempt.current?.text !== content) attempt.current = { text: content, key: crypto.randomUUID() };
    const pending = attempt.current;
    await request(path, { text, document }, pending.key, 'POST', undefined, viewer);
    if (attempt.current === pending) attempt.current = undefined;
    setCursor('');
    await invalidateUpdates('session-team', id);
  }

  return { page, error, post, cursor, setCursor, retry: () => setRetry(n => n + 1) };
}
