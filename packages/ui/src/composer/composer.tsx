import { useRef, useState } from "react";
import { ArrowUp, Code, TextB, TextItalic } from "@phosphor-icons/react";
import { replaceEmojiShortcodes, emojiPreferences } from "../emoji/emoji.js";
import { EmojiPicker } from "../emoji/emoji-picker.js";
import { IconButton } from "../primitives/primitives.js";

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
      await onSend(replaceEmojiShortcodes(value, emojiPreferences().skin));
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
          <EmojiPicker label="Insert smile emoji" disabled={sending} restoreFocus={false} onSelect={emoji => insert(emoji, "")} />
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
