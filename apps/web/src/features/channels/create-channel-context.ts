import {createContext} from 'react';

export const DirectoryCreateChannel = createContext<(() => void) | undefined>(undefined);
