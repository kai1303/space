import { useEffect, type ReactNode } from 'react';
import { retainRealtimeSession } from './socket-session.js';

export function SocketSession({ children }: { children: ReactNode }) {
  useEffect(() => retainRealtimeSession(), []);
  return children;
}
