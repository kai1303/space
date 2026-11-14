import { useEffect, useState } from 'react';
import type { Page } from '@space/contracts';

type Search<T> = (params: URLSearchParams, signal: AbortSignal) => Promise<Page<T>>;

export function useFilePickerPage<T>(search: Search<T>, query: string, cursor: string, delay: number) {
  const [result, setResult] = useState<{ search: Search<T>; query: string; cursor: string; page: Page<T> }>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const current = result?.query === query && result.search === search ? result : undefined;
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    const params = new URLSearchParams(query);
    if (cursor) params.set('after', cursor);
    const timer = setTimeout(() => {
      void search(params, controller.signal).then(page => {
        if (!controller.signal.aborted) setResult({ search, query, cursor, page });
      }).catch(reason => {
        if (controller.signal.aborted) return;
        if (reason instanceof Error && ['unauthorized','forbidden','not_found'].includes(reason.message)) setResult(undefined);
        setError('Couldn’t load files.');
      });
    }, cursor ? 0 : delay);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [search, query, cursor, delay, attempt]);
  return {
    page: current?.page, displayedCursor: current?.cursor, changingPage: !error && !!current && current.cursor !== cursor,
    error, retry: () => setAttempt(value => value + 1),
  };
}
