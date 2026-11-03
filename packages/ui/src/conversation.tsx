import { useRef, useState, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { motionTransition } from "./motion.js";
import {
  ArrowUp,
  Code,
  Smiley,
  TextB,
  TextItalic,
  ChatCircle,
} from "@phosphor-icons/react";
import { Avatar, Badge, IconButton } from "./primitives.js";
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
}) {
  const reduced = useReducedMotion();
  return (
    <motion.article
      className="sp-message"
      initial={arrival && !reduced ? { opacity: 0, y: 8 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={motionTransition(reduced)}
    >
      <Avatar name={author} initials={initials} tone={tone} />
      <div className="sp-message-body">
        <div className="sp-message-meta">
          <strong>{author}</strong>
          {agent && <Badge>APP</Badge>}
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
      </div>
      {(onReply || onReact || actions) && <MessageActions author={author} onReply={onReply} onReact={onReact} actions={actions} />}
    </motion.article>
  );
}

export function Composer({
  channel,
  onSend,
  compact = false,
}: {
  channel: string;
  onSend: (text: string) => void | Promise<void>;
  compact?: boolean;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const pending = useRef(false);
  async function send() {
    const value = text.trim();
    if (!value || pending.current) return;
    pending.current = true;
    setSending(true);
    setError("");
    try {
      await onSend(value);
      setText("");
    } catch {
      setError("Could not send. Your draft is saved here. Try again.");
    } finally {
      pending.current = false;
      setSending(false);
      input.current?.focus();
    }
  }
  function insert(before: string, after = before) {
    const node = input.current;
    if (!node) return;
    const start = node.selectionStart,
      end = node.selectionEnd;
    setText(
      text.slice(0, start) +
        before +
        text.slice(start, end) +
        after +
        text.slice(end),
    );
    requestAnimationFrame(() => {
      node.focus();
      node.setSelectionRange(start + before.length, end + before.length);
    });
  }
  return (
    <div
      className={`sp-composer-wrap ${compact ? "sp-composer-wrap--compact" : ""}`}
    >
      <div className={`sp-composer ${error ? "sp-composer--error" : ""}`}>
        <div
          className="sp-composer-format"
          role="group"
          aria-label="Insert Markdown formatting"
        >
          <IconButton
            label="Insert bold Markdown"
            size="sm"
            disabled={sending}
            onClick={() => insert("**")}
          >
            <TextB size={17} />
          </IconButton>
          <IconButton
            label="Insert italic Markdown"
            size="sm"
            disabled={sending}
            onClick={() => insert("_")}
          >
            <TextItalic size={17} />
          </IconButton>
          <IconButton
            label="Insert code Markdown"
            size="sm"
            disabled={sending}
            onClick={() => insert("`")}
          >
            <Code size={17} />
          </IconButton>
          <span className="sp-composer-format-note">Markdown shortcuts</span>
        </div>
        <textarea
          ref={input}
          value={text}
          readOnly={sending}
          aria-label={`Message ${channel}`}
          placeholder={`Message #${channel}`}
          rows={compact ? 2 : 3}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing &&
              event.nativeEvent.keyCode !== 229
            ) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div className="sp-composer-bottom">
          <IconButton
            label="Insert smile emoji"
            size="sm"
            disabled={sending}
            onClick={() => insert("🙂", "")}
          >
            <Smiley size={19} />
          </IconButton>
          <span className="sp-composer-help">
            {sending
              ? "Sending…"
              : "Enter to send · Shift + Enter for a new line"}
          </span>
          <IconButton
            label="Send message"
            size="sm"
            className="sp-send"
            disabled={!text.trim() || sending}
            onClick={() => void send()}
          >
            <ArrowUp size={18} weight="bold" />
          </IconButton>
        </div>
      </div>
      {error && (
        <p role="alert" className="sp-field-error">
          {error}
        </p>
      )}
    </div>
  );
}
