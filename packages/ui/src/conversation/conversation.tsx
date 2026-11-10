import type { ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { CaretRight, ChatCircle } from "@phosphor-icons/react";
import { motionTransition } from "../motion/motion.js";
import { Avatar, Badge } from "../primitives/primitives.js";
import { MessageActions, type MessageActionHandlers } from "./message-actions.js";

export type Reaction = { emoji: string; count: number; active?: boolean };
export function Message({
  author,
  initials,
  time,
  children,
  agent = false,
  workflow = false,
  app = false,
  reactions = [],
  onReact,
  onReply,
  onAuthorClick,
  replyCount = 0,
  tone = "purple",
  arrival = false,
  actions,
  footer,
  grouped = false,
}: {
  author: string;
  initials: string;
  time: string;
  children: ReactNode;
  agent?: boolean;
  workflow?: boolean;
  app?: boolean;
  reactions?: Reaction[];
  onReact?: (emoji: string) => void;
  onReply?: () => void;
  onAuthorClick?: () => void;
  replyCount?: number;
  tone?: "purple" | "blue" | "green" | "orange";
  arrival?: boolean;
  actions?: MessageActionHandlers;
  footer?: ReactNode;
  grouped?: boolean;
}) {
  const reduced = useReducedMotion();
  return (
    <motion.article
      className={`sp-message${grouped ? " sp-message--grouped" : ""}`}
      initial={arrival && !reduced ? { opacity: 0 } : false}
      animate={{ opacity: 1 }}
      transition={motionTransition(reduced, 0.14)}
    >
      {grouped ? <span className="sp-message-compact-time" aria-hidden="true">{time}</span> : <>{onAuthorClick ? <button type="button" className="sp-message-author-avatar" aria-label={`View ${author}’s profile`} onClick={onAuthorClick}><Avatar name={author} initials={initials} tone={tone}/></button> : <Avatar name={author} initials={initials} tone={tone}/>}</>}
      <div className="sp-message-body">
        <div className={grouped ? "sp-sr-only" : "sp-message-meta"}>
          <strong>{onAuthorClick && !grouped ? <button type="button" className="sp-message-author-name" aria-label={`View ${author}’s profile`} onClick={onAuthorClick}>{author}</button> : author}</strong>
          {workflow && <Badge>Workflow</Badge>}
          {agent && <Badge>Agent</Badge>}{app && <Badge>App</Badge>}
          <span className="sp-message-time">{time}</span>
        </div>
        <div className="sp-message-text">{children}</div>
        {reactions.length > 0 && (
          <div className="sp-reactions" aria-label="Reactions">
            {reactions.map((reaction) => (
              <button
                key={reaction.emoji}
                type="button"
                aria-label={`${reaction.emoji} ${reaction.count} reactions`}
                aria-pressed={reaction.active ?? false}
                disabled={!onReact}
                onClick={() => onReact?.(reaction.emoji)}
              >
                {reaction.emoji}
                <span>{reaction.count}</span>
              </button>
            ))}
          </div>
        )}
        {replyCount > 0 && onReply && (
          <button type="button" className="sp-thread-link" aria-label={`${replyCount} ${replyCount === 1 ? "reply" : "replies"} View thread`} onClick={onReply}>
            <ChatCircle size={14} aria-hidden="true" />
            {replyCount} {replyCount === 1 ? "reply" : "replies"}<span className="sp-thread-link-hint" aria-hidden="true">View thread</span>
            <CaretRight className="sp-thread-link-arrow" size={18} aria-hidden="true" />
          </button>
        )}
        {footer}
      </div>
      {(onReply || onReact || actions) && <MessageActions author={author} onReply={onReply} onReact={onReact} actions={actions} />}
    </motion.article>
  );
}
