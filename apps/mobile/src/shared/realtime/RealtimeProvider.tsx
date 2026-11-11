import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { serverConfig } from '../config';
import { Centered } from '../ui/Centered';
import { createRealtime, type Realtime, type RealtimeAuth } from './socket-session';

const RealtimeContext = createContext<Realtime | null>(null);

// The single socket owner for a signed-in session. AppState events, not timers, drive it.
export function RealtimeProvider({ session, children }: { session: RealtimeAuth; children: ReactNode }) {
  const [realtime, setRealtime] = useState<Realtime | null>(null);
  useEffect(() => {
    const next = createRealtime(serverConfig().baseUrl, session);
    setRealtime(next);
    if (AppState.currentState !== 'background') next.start();
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') next.start();
      else if (state === 'background') next.stop();
    });
    return () => { subscription.remove(); next.close(); setRealtime(null); };
  }, [session]);
  if (!realtime) return <Centered busy />;
  return <RealtimeContext.Provider value={realtime}>{children}</RealtimeContext.Provider>;
}

export function useRealtime() {
  const value = useContext(RealtimeContext);
  if (!value) throw new Error('useRealtime must be used inside RealtimeProvider');
  return value;
}
