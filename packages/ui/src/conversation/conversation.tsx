import type { ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { ChatCircle } from "@phosphor-icons/react";
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
  reactions = [],
  onReact,
  onReply,
  replyCount = 0,
  tone = "purple",
  arrival = false,
  actions,
  footer,
}: {
  author: string;
  initials: string;
  time: string;
  children: ReactNode;
  agent?: boolean;
  reactions?: Reaction[];
  onReact?: (emoji: string) => void;
  onReply?: () => void;
  replyCount?: number;
  tone?: "purple" | "blue" | "green" | "orange";
  arrival?: boolean;
  actions?: MessageActionHandlers;
  footer?: ReactNode;
}) {
  const reduced = useReducedMotion();
  return (
    <motion.article
      className="sp-message"
      initial={arrival && !reduced ? { opacity: 0 } : false}
      animate={{ opacity: 1 }}
      transition={motionTransition(reduced, 0.14)}
    >
      <Avatar name={author} initials={initials} tone={tone} />
      <div className="sp-message-body">
        <div className="sp-message-meta">
          <strong>{author}</strong>
          {agent && <Badge>Agent</Badge>}
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
          <button type="button" className="sp-thread-link" onClick={onReply}>
            <ChatCircle size={14} />
            {replyCount} {replyCount === 1 ? "reply" : "replies"}<span>View thread</span>
          </button>
        )}
        {footer}
      </div>
      {(onReply || onReact || actions) && <MessageActions author={author} onReply={onReply} onReact={onReact} actions={actions} />}
    </motion.article>
  );
}
