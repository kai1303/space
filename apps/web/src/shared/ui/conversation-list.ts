import { createContext, useSyncExternalStore } from 'react';

// Phones show one screen at a time. The shell provides a way back to the conversation list.
export const ConversationListContext = createContext<(() => void) | null>(null);

export const PHONE_QUERY = '(max-width: 720px)';
const subscribe = (change: () => void) => {
  if (typeof window.matchMedia !== 'function') return () => {};
  const media = window.matchMedia(PHONE_QUERY);
  media.addEventListener('change', change);
  return () => media.removeEventListener('change', change);
};
const phone = () => typeof window.matchMedia === 'function' && window.matchMedia(PHONE_QUERY).matches;
export const usePhoneLayout = () => useSyncExternalStore(subscribe, phone, () => false);
