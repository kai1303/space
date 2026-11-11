import { useCallback, useEffect, useState, type DependencyList } from 'react';
import { errorText } from './request';

// `load` is recreated each render; callers list everything it reads in `deps`.
export function useLoad<T>(load: () => Promise<T>, deps: DependencyList) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt(value => value + 1), []);
  useEffect(() => {
    let alive = true;
    setLoading(true); setError('');
    load().then(
      value => { if (alive) setData(value); },
      reason => { if (alive) setError(errorText(reason)); },
    ).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [...deps, attempt]);
  return { data, error, loading, reload };
}
