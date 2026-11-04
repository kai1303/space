import { useLayoutEffect, useRef } from 'react';
import { useIsPresent } from 'motion/react';

// Async completions must stop navigating as soon as their page starts exiting.
export function useDestinationPresence() {
 const present=useIsPresent(),current=useRef(present);
 useLayoutEffect(()=>{current.current=present;return()=>{current.current=false;};},[present]);
 return current;
}
