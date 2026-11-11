import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createApi, type Api } from '../../shared/api/request';
import { SessionClient, type SessionUser } from '../../shared/api/session';
import { serverConfig } from '../../shared/config';
import { secureStore } from '../../shared/storage/secure-store';

type Status = 'loading' | 'unavailable' | 'signed-out' | 'signed-in';
type AuthValue = {
  status: Status; user: SessionUser | null; session: SessionClient; api: Api;
  signIn(email: string, password: string): Promise<void>; signOut(): Promise<void>; retry(): void;
};
const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session] = useState(() => new SessionClient(serverConfig().baseUrl, secureStore));
  const [api] = useState(() => createApi(session));
  const [state, setState] = useState<{ status: Status; user: SessionUser | null }>({ status: 'loading', user: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => session.on('expired', () => setState({ status: 'signed-out', user: null })), [session]);
  useEffect(() => {
    let alive = true;
    session.restore().then(
      user => { if (alive) setState(user ? { status: 'signed-in', user } : { status: 'signed-out', user: null }); },
      // Keep the stored session: the server may only be unreachable.
      () => { if (alive) setState({ status: 'unavailable', user: null }); },
    );
    return () => { alive = false; };
  }, [session, attempt]);
  const signIn = useCallback(async (email: string, password: string) => {
    const user = await session.signIn(email, password);
    setState({ status: 'signed-in', user });
  }, [session]);
  const signOut = useCallback(() => session.signOut(), [session]);
  const retry = useCallback(() => { setState({ status: 'loading', user: null }); setAttempt(value => value + 1); }, []);
  const value = useMemo(() => ({ ...state, session, api, signIn, signOut, retry }), [state, session, api, signIn, signOut, retry]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
