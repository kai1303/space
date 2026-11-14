import { useEffect, useState, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { CaretRight, ChatCircle } from "@phosphor-icons/react";
import { motionTransition } from "../motion/motion.js";
import { Avatar, Badge } from "../primitives/primitives.js";
import { MessageActions, type MessageActionHandlers } from "./message-actions.js";
import { useLongPress } from "./long-press.js";

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
  replyParticipants = [], participantCount = replyParticipants.length, lastReplyAt, hasReplyDraft = false, threadOpen,
  tone = "purple",
  arrival = false,
  animateActions = false,
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
  replyParticipants?: { id: string; kind?: string; name: string; image?: string | null }[];
  participantCount?: number;
  lastReplyAt?: string | null;
  hasReplyDraft?: boolean;
  threadOpen?: boolean;
  tone?: "purple" | "blue" | "green" | "orange";
  arrival?: boolean | "glide" | "fade";
  animateActions?: boolean;
  actions?: MessageActionHandlers;
  footer?: ReactNode;
  grouped?: boolean;
}) {
  const replyLabel = [replyCount > 0 && `${replyCount} ${replyCount === 1 ? "reply" : "replies"}`, hasReplyDraft && "1 draft"].filter(Boolean).join(" & ");
  const lastReply = lastReplyAt ? new Date(lastReplyAt) : null;
  const reduced = useReducedMotion();
  const glide = arrival !== "fade";
  const press = useLongPress();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  useEffect(() => {
    const row = press.ref.current;
    if (!animateActions || !row) return;
    // Native details toggle does not bubble. Keep the toolbar visible while its portaled menu owns focus.
    const sync = () => setPopoverOpen(!!row.querySelector('.sp-message-actions details[open]'));
    const enter = (event: PointerEvent) => { if (event.pointerType !== 'touch') setHovered(true); };
    const leave = () => setHovered(false);
    row.addEventListener('pointerenter', enter);
    row.addEventListener('pointerleave', leave);
    row.addEventListener('toggle', sync, true);
    return () => {
      row.removeEventListener('pointerenter', enter);
      row.removeEventListener('pointerleave', leave);
      row.removeEventListener('toggle', sync, true);
    };
  }, [animateActions, press.ref]);
  const actionsVisible = animateActions ? hovered || focused || popoverOpen || press.open : undefined;
  return (
    <motion.article
      ref={press.ref}
      onFocusCapture={animateActions ? () => setFocused(true) : undefined}
      onBlurCapture={animateActions ? event => setFocused(event.currentTarget.contains(event.relatedTarget)) : undefined}
      data-actions-open={press.open || undefined}
      onPointerDown={press.start} onPointerMove={press.move} onPointerUp={press.cancel} onPointerCancel={press.cancel}
      className={`sp-message${grouped ? " sp-message--grouped" : ""}`}
      initial={arrival && !reduced ? { opacity: 0, ...(glide && { x: -14 }) } : false}
      animate={{ opacity: 1, x: 0 }}
      transition={motionTransition(reduced, glide ? 0.26 : 0.14)}
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
        {replyLabel && onReply && (
          <button type="button" className="sp-thread-link" aria-label={`${replyLabel} View thread`} aria-expanded={threadOpen} onClick={onReply}>
            {replyParticipants.length ? <span className="sp-thread-link-faces">
              {replyParticipants.slice(0, 5).map((person, index) => <span className="sp-thread-link-face" key={`${person.kind}:${person.id}:${person.name}`} title={person.name}>
                <Avatar name={person.name} initials={person.name.trim().split(/\s+/).slice(0, 2).map(word => word[0]).join("")} image={person.image} size="sm"/>
                {index === 4 && participantCount > 5 && <span className="sp-thread-link-more">+{participantCount - 5}</span>}
              </span>)}
            </span> : <ChatCircle size={16} aria-hidden="true"/>}
            <strong>{replyLabel}</strong>
            <span className="sp-thread-link-detail">
              {lastReply && Number.isFinite(lastReply.getTime()) && <time dateTime={lastReplyAt!} title={lastReply.toLocaleString()}>
                Last reply {lastReply.toLocaleString(undefined, lastReply.toDateString() === new Date().toDateString()
                  ? {hour: "numeric", minute: "2-digit"} : {month: "short", day: "numeric", year: lastReply.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined})}
              </time>}
              <span className="sp-thread-link-hint" aria-hidden="true">View thread</span>
            </span>
            <CaretRight className="sp-thread-link-arrow" size={18} aria-hidden="true" />
          </button>
        )}
        {footer}
      </div>
      {(onReply || onReact || actions) && <MessageActions visible={actionsVisible} author={author} onReply={onReply} onReact={onReact} actions={actions} />}
    </motion.article>
  );
}
