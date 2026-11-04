import {type ReactNode} from 'react';
import {AnimatePresence,motion,useIsPresent,useReducedMotion} from 'motion/react';
import { motionTransition } from '@space/ui/motion';
export function DestinationTransition({destination,scope='',children}:{destination:string;scope?:string;children:ReactNode}) {
 return <AnimatePresence initial={false} mode="wait"><Page key={destination==='Home'?'Home':`${scope}:${destination}`} destination={destination} scope={scope}>{children}</Page></AnimatePresence>;
}
function Page({destination,scope,children}:{destination:string;scope:string;children:ReactNode}) {
 const present=useIsPresent(),reduced=useReducedMotion();
 return <motion.div className="chat-destination" data-workspace={scope} role="region" aria-label={`${destination} page`} aria-hidden={!present||undefined} inert={!present} initial={reduced?false:{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} transition={motionTransition(reduced,.14)}>{children}</motion.div>;
}
