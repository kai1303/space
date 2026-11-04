import type { ReactNode } from 'react';

export function ConversationHeading({title,icon,leading,status,onClick,label}: {
 title:string;icon:ReactNode;leading?:ReactNode;status?:string;onClick?:()=>void;label?:string;
}) {
 const identity=<>{icon}<h1>{title}</h1></>;
 return <div className="sp-conversation-heading">{leading}<div className="sp-conversation-identity">{onClick?<button className="sp-conversation-title" aria-label={label} onClick={onClick}>{identity}</button>:<div className="sp-conversation-title">{identity}</div>}{status&&<span className="sp-conversation-status" role="status">{status}</span>}</div></div>;
}
export function ConversationDateDivider({date,previous}:{date:string;previous?:string}) {
 return previous&&new Date(previous).toDateString()===new Date(date).toDateString()?null:<div className="sp-conversation-date"><span>{new Date(date).toLocaleDateString([], { weekday:'long', month:'long', day:'numeric' })}</span></div>;
}
