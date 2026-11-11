import { createContext } from 'react';

export type ChannelSearchHeader = { label: string; edit: () => void };
export const ChannelSearchHeaderContext = createContext<((header: ChannelSearchHeader | null) => void) | null>(null);
