import { registerMention } from "./mention-blot.js";
import { useMentions, type FindMentions } from "./use-mentions.js";
import { documentMentions } from "@space/contracts";
import { useEffect, useRef, useState, useId } from "react";
import { EmojiPicker } from "./emoji-picker.js";
import { emojiCompletion, emojiDocument, emojiNative, emojiPreferences } from "./emoji.js";
import type Quill from "quill";
import { Reveal } from "./reveal.js";
import { isDefaultComposerSendKey } from "./composer-keyboard.js";
import { MAX_ASSET_BYTES, MAX_MESSAGE_ASSETS, MAX_MESSAGE_DOCUMENT_BYTES } from "@space/contracts";
import {
  PaperPlaneRight,
  Plus,
  At,
  TextAa,
  TextB,
  TextItalic,
  TextUnderline,
  TextStrikethrough,
  Link,
  ListNumbers,
  ListBullets,
  Quotes,
  Code,
  CodeBlock,
  X,
  File,
  Microphone,
  VideoCamera,
  Lightning,
} from "@phosphor-icons/react";
import { Button, Dialog, IconButton, Popover, TextField } from "./primitives.js";
import {
  normalizeDocument,
  safeLink,
  type Attachment,
  type RichDocument,
} from "./rich-text.js";

export function RichComposer({
  channel,
  placeholder,
  defaultValue,
  acknowledgedDocument,
  defaultAttachments = [],
  attachments,
  onRetryAttachment,
  onDraftChange,
  onAttachmentsChange,
  onSend,
  mentions = [],
  findMentions,
  plainText = false,
  maxLength = 10000,
  attachmentsEnabled = true,
  sendDisabledReason,
}: {
  channel: string;
  placeholder?: string;
  defaultValue?: RichDocument;
  acknowledgedDocument?: RichDocument;
  defaultAttachments?: Attachment[];
  attachments?: Attachment[];
  onRetryAttachment?: (id: string) => void;
  onDraftChange?: (document: RichDocument) => void;
  onAttachmentsChange?: (attachments: Attachment[]) => void;
  onSend: (
    text: string,
    document: RichDocument,
    attachments: Attachment[],
    options?: { broadcast_confirmed: boolean },
  ) => void | Promise<void>;
  mentions?: string[];
  findMentions?: FindMentions;
  plainText?: boolean;
  maxLength?: number;
  attachmentsEnabled?: boolean;
  sendDisabledReason?: string;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const editor = useRef<Quill | null>(null);
  const callbacks = useRef({ onDraftChange, onAttachmentsChange, onSend });
  callbacks.current = { onDraftChange, onAttachmentsChange, onSend };
  const initial = useRef(defaultValue);
  const selection = useRef({ index: 0, length: 0 });
  const pending = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [ready, setReady] = useState(false);
  const seenAcknowledgment = useRef(acknowledgedDocument);
  useEffect(() => {
    const q = editor.current;
    if (!q || !acknowledgedDocument || seenAcknowledgment.current === acknowledgedDocument) return;
    seenAcknowledgment.current = acknowledgedDocument;
    if (JSON.stringify(normalizeDocument(q.getContents())) !== JSON.stringify(acknowledgedDocument)) return;
    q.setText("");
    q.history.clear();
    callbacks.current.onDraftChange?.({ ops: [] });
  }, [acknowledgedDocument, ready]);
  const [text, setText] = useState("");
  const [formats, setFormats] = useState<Record<string, unknown>>({});
  const [showFormats, setShowFormats] = useState(true);
  const [sending, setSending] = useState(false);
  const [sendingVisible, setSendingVisible] = useState(false);
  useEffect(() => {
    if (!sending) { setSendingVisible(false); return; }
    // Quick acknowledgements should not flash a transient progress label.
    const timer = setTimeout(() => setSendingVisible(true), 300);
    return () => clearTimeout(timer);
  }, [sending]);
  const [error, setError] = useState("");
  const [localFiles, setLocalFiles] = useState<Attachment[]>(attachmentsEnabled ? defaultAttachments : []);
  const files = attachments ?? localFiles;
  function setFiles(next: Attachment[]) {
    if (attachments === undefined) setLocalFiles(next);
    callbacks.current.onAttachmentsChange?.(next);
  }
  const filesPending = files.some(file => file.status === "uploading" || file.status === "error");
  const filesRef = useRef(files);
  filesRef.current = files;
  const [linkOpen, setLinkOpen] = useState(false);
  const returnToSelection = useRef(false);
  useEffect(() => {
    if (!linkOpen && returnToSelection.current) {
      returnToSelection.current = false;
      restore();
    }
  }, [linkOpen]);
  const [linkText, setLinkText] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [linkError, setLinkError] = useState("");
  const suggestionsId = useId();
  const [completion, setCompletion] = useState<ReturnType<typeof emojiCompletion>>(null);
  const completionRef = useRef<ReturnType<typeof emojiCompletion>>(null);
  const [emojiIndex, setEmojiIndex] = useState(0);
  const emojiIndexRef = useRef(0);
  function suggest(q: Quill, range = q.getSelection()) {
    const format = range ? q.getFormat(range) : {};
    const next = range && !range.length && !format.code && !format["code-block"] && !format.link ? emojiCompletion(q.getText(), range.index) : null;
    completionRef.current = next?.items.length ? next : null;
    setCompletion(completionRef.current); emojiIndexRef.current = 0; setEmojiIndex(0);
  }
  function completeEmoji(index: number) {
    const q = editor.current, match = completionRef.current, item = match?.items[index];
    if (!q || !match || !item) return;
    const value = emojiNative(item.id, emojiPreferences().skin);
    q.deleteText(match.start, match.length, "user");
    q.insertText(match.start, value, "user");
    q.setSelection(match.start + value.length, 0, "user");
    completionRef.current = null; setCompletion(null);
  }
  useEffect(() => {
    const root = editor.current?.root;
    if (!root) return;
    root.setAttribute('aria-autocomplete', 'list');
    root.setAttribute('aria-controls', suggestionsId);
    root.setAttribute('aria-expanded', String(Boolean(completion)));
    if (completion) root.setAttribute('aria-activedescendant', `${suggestionsId}-${emojiIndex}`);
    else root.removeAttribute('aria-activedescendant');
  }, [completion, emojiIndex, suggestionsId, ready]);
  const [editorVersion, setEditorVersion] = useState(0);
  const mentionsUI = useMentions(editor, ready, channel, findMentions, editorVersion);
  const mentionKeys = useRef(mentionsUI.key); mentionKeys.current = mentionsUI.key;
  const [broadcastWarning, setBroadcastWarning] = useState(false);
  const sendRef = useRef<() => void>(() => {});
  async function send(confirmed = false) {
    const q = editor.current;
    if (!q || pending.current || sendDisabledReason || filesRef.current.some(file => file.status === "uploading" || file.status === "error")) return;
    const raw = q.getText();
    const plain = raw.trim();
    if (!plain && !filesRef.current.length) return;
    if (raw.length - 1 > maxLength) {
      setError(
        `Keep the message under ${maxLength.toLocaleString("en-US")} characters. Your draft is unchanged.`,
      );
      return;
    }
    const document = emojiDocument(normalizeDocument(q.getContents()), emojiPreferences().skin);
    if (new TextEncoder().encode(JSON.stringify(document)).byteLength > MAX_MESSAGE_DOCUMENT_BYTES) {
      setError("This message has too much formatting. Split it into smaller messages.");
      return;
    }
    // Keep stored drafts identical to the submitted document while navigating during send.
    if (JSON.stringify(normalizeDocument(q.getContents())) !== JSON.stringify(document)) q.setContents(document.ops, "user");
    if (!confirmed && mentionsUI.memberCount >= 6 && findMentions && documentMentions(document).some(ref => ref.kind === 'broadcast') && channel !== 'thread') { setBroadcastWarning(true); return; }
    pending.current = true;
    setSending(true);
    setError("");
    q.disable();
    try {
      const plainText = document.ops.map(op => op.insert).join("").trim();
      if (confirmed) await callbacks.current.onSend(plainText, document, filesRef.current, { broadcast_confirmed: true });
      else await callbacks.current.onSend(plainText, document, filesRef.current);
      if (editor.current !== q) return;
      q.setText("");
      q.history.clear();
      setFiles([]);
      callbacks.current.onDraftChange?.({ ops: [] });
    } catch (reason) {
      if (reason instanceof Error && reason.message === 'broadcast_confirmation_required') setBroadcastWarning(true);
      else if (editor.current === q)
        setError("Could not send. Your draft is still here. Try again.");
    } finally {
      if (editor.current === q) {
        pending.current = false;
        setSending(false);
        q.enable();
        const dom = q.root.ownerDocument;
        if (dom.activeElement === dom.body || mount.current?.parentElement?.contains(dom.activeElement)) q.focus();
      }
    }
  }
  sendRef.current = () => void send();
  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    import("quill")
      .then(({ default: Editor }) => {
        if (disposed || !mount.current) return;
        const node = document.createElement("div");
        mount.current.append(node);
        registerMention(Editor);
        const q = new Editor(node, {
          placeholder: placeholder ?? `Message #${channel}`,
          formats: plainText ? ["mention"] : [
            "mention",
            "bold",
            "italic",
            "underline",
            "strike",
            "link",
            "list",
            "blockquote",
            "code",
            "code-block",
          ],
          modules: { toolbar: false, history: { userOnly: true } },
        });
        editor.current = q;
        completionRef.current = null; setCompletion(null);
        pending.current = false;
        setSending(false);
        q.root.setAttribute("role", "textbox");
        q.root.setAttribute("aria-label", `Message ${channel}`);
        q.root.setAttribute("aria-multiline", "true");
        if (initial.current)
          q.setContents(
            normalizeDocument(initial.current, Infinity).ops,
            "silent",
          );
        setText(q.getText());
        const change = () => {
          setText(q.getText());
          suggest(q);
          const range = q.getSelection();
          setFormats(range ? q.getFormat(range) : {});
          // Preserve over-limit drafts for editing; send() validates before submission.
          callbacks.current.onDraftChange?.(
            normalizeDocument(q.getContents(), Infinity),
          );
        };
        const select = (range: { index: number; length: number } | null) => {
          if (range) {
            selection.current = range;
            setFormats(q.getFormat(range));
            suggest(q, range);
          }
        };
        const key = (event: KeyboardEvent) => {
          if (event.isComposing || event.keyCode === 229) return;
          if (mentionKeys.current(event)) return;
          const match = completionRef.current;
          if (match && ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)) {
            event.preventDefault(); event.stopImmediatePropagation();
            if (event.key === "Escape") { completionRef.current = null; setCompletion(null); }
            else if (event.key === "Enter" || event.key === "Tab") completeEmoji(emojiIndexRef.current);
            else { emojiIndexRef.current = (emojiIndexRef.current + (event.key === "ArrowDown" ? 1 : -1) + match.items.length) % match.items.length; setEmojiIndex(emojiIndexRef.current); }
            return;
          }
          if (isDefaultComposerSendKey(event)) {
            event.preventDefault();
            event.stopPropagation();
            sendRef.current();
          }
        };
        q.on("text-change", change);
        q.on("selection-change", select);
        q.root.addEventListener("keydown", key, true);
        setReady(true);
        setEditorVersion(version => version + 1);
        cleanup = () => {
          q.off("text-change", change);
          q.off("selection-change", select);
          q.root.removeEventListener("keydown", key, true);
          q.disable();
          node.remove();
          if (editor.current === q) editor.current = null;
        };
      })
      .catch(() => {
        if (!disposed)
          setError("The editor could not load. Reload this page to try again.");
      });
    return () => {
      disposed = true;
      cleanup();
    };
  }, [channel, plainText, placeholder]);
  function restore() {
    const q = editor.current;
    if (!q) return;
    const range = selection.current;
    q.focus();
    q.setSelection(
      Math.min(range.index, q.getLength() - 1),
      range.length,
      "silent",
    );
    return q;
  }
  function format(name: string, value: unknown) {
    const q = restore();
    if (q) {
      const active = name === "code-block" ? Boolean(formats[name]) : formats[name] === value;
      q.format(name, active ? false : value, "user");
      setFormats(q.getFormat());
    }
  }
  function insert(value: string) {
    const q = restore();
    if (!q) return;
    const r = selection.current;
    q.deleteText(r.index, r.length, "user");
    q.insertText(r.index, value, "user");
    q.setSelection(r.index + value.length, 0, "silent");
  }
  function openLink() {
    const q = editor.current;
    if (!q) return;
    const r = selection.current;
    setLinkText(q.getText(r.index, r.length));
    setLinkUrl(typeof formats.link === "string" ? formats.link : "");
    setLinkError("");
    returnToSelection.current = true;
    setLinkOpen(true);
  }
  const tools = [
    { name: "Bold", icon: TextB, format: "bold", value: true },
    { name: "Italic", icon: TextItalic, format: "italic", value: true },
    {
      name: "Underline",
      icon: TextUnderline,
      format: "underline",
      value: true,
    },
    {
      name: "Strikethrough",
      icon: TextStrikethrough,
      format: "strike",
      value: true,
    },
    {
      name: "Ordered list",
      icon: ListNumbers,
      format: "list",
      value: "ordered",
    },
    {
      name: "Bulleted list",
      icon: ListBullets,
      format: "list",
      value: "bullet",
    },
    { name: "Blockquote", icon: Quotes, format: "blockquote", value: true },
    { name: "Code", icon: Code, format: "code", value: true },
    { name: "Code block", icon: CodeBlock, format: "code-block", value: true },
  ];
  const codeBlockActive = Boolean(formats["code-block"]);
  const formatButtons = tools.map(({ name, icon: Icon, format: key, value }) => {
    const unavailable = !ready || (codeBlockActive && !["list", "blockquote", "code-block"].includes(key));
    return (
    <IconButton key={name} label={name} size="sm"
      disabled={unavailable || sending}
      data-send-disabled={sending && !unavailable || undefined}
      aria-pressed={key === "code-block" ? codeBlockActive : formats[key] === value}
      onMouseDown={(e) => e.preventDefault()} onClick={() => format(key, value)}>
      <Icon size={18} />
    </IconButton>
  ); });
  return (
    <div className="sp-rich-composer" aria-busy={sending || undefined}>
      {mentionsUI.suggestions}
      <Dialog open={broadcastWarning} title="Notify the channel?" onClose={() => setBroadcastWarning(false)}><p>This message can notify {mentionsUI.memberCount || 'all eligible'} channel members. Use channel-wide mentions sparingly.</p><div className="sp-mention-confirm"><Button onClick={() => setBroadcastWarning(false)}>Keep editing</Button><Button variant="primary" onClick={() => { setBroadcastWarning(false); void send(true); }}>Send and notify</Button></div></Dialog>
      {completion && <div className="sp-emoji-suggestions" id={suggestionsId} role="listbox" aria-label="Emoji suggestions">
        {completion.items.map((item, index) => <button id={`${suggestionsId}-${index}`} type="button" role="option" aria-selected={index === emojiIndex} key={item.id} onMouseDown={event => event.preventDefault()} onClick={() => completeEmoji(index)}><span>{emojiNative(item.id, emojiPreferences().skin)}</span><span>:{item.id}:</span></button>)}
      </div>}
      <div className="sp-rich-editor-shell">
        <Reveal open={!plainText && showFormats}>
          <div
            className="sp-rich-toolbar"
            role="toolbar"
            aria-label="Message formatting"
          >
            {formatButtons.slice(0, 4)}
            <span className="sp-rich-format-separator" aria-hidden="true" />
            <IconButton
              label="Add link"
              size="sm"
              disabled={!ready || sending || codeBlockActive}
              data-send-disabled={sending && ready && !codeBlockActive || undefined}
              aria-pressed={typeof formats.link === "string"}
              onMouseDown={(e) => e.preventDefault()}
              onClick={openLink}
            >
              <Link size={18} />
            </IconButton>
            <span className="sp-rich-format-separator" aria-hidden="true" />
            {formatButtons.slice(4, 7)}
            <span className="sp-rich-format-separator" aria-hidden="true" />
            {formatButtons.slice(7)}
          </div>
        </Reveal>
        <div className="sp-rich-editor" ref={mount} />
        {!ready && !error && (
          <p className="sp-rich-loading" role="status">
            Loading editor…
          </p>
        )}
        {files.length > 0 && (
          <div className="sp-attachment-list">
            {files.map((file) => (
              <div key={file.id}>
                <File size={20} />
                <span>
                  {file.name}
                  <small>
                    {Math.max(1, Math.round(file.size / 1024))} KB · {file.status === "ready" ? "Ready" : file.status === "uploading" ? "Uploading…" : file.status === "error" ? "Upload failed" : "local file"}
                  </small>
                </span>
                {file.status === "uploading" && <progress aria-label={`Uploading ${file.name}`} value={file.progress ?? 0} max={100} />}
                {file.status === "error" && <><small role="alert">{file.error ?? "Upload failed"}</small><Button size="sm" aria-label={`Retry upload ${file.name}`} disabled={sending} data-send-disabled={sending || undefined} onClick={() => onRetryAttachment?.(file.id)}>Retry</Button></>}
                <IconButton
                  label={`Remove ${file.name}`}
                  size="sm"
                  disabled={sending}
                  data-send-disabled={sending || undefined}
                  onClick={() =>
                    setFiles(files.filter((f) => f.id !== file.id))
                  }
                >
                  <X size={14} />
                </IconButton>
              </div>
            ))}
          </div>
        )}
        <div
          className="sp-rich-actions"
          role="toolbar"
          aria-label="Composer actions"
        >
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              const incoming = [...(event.target.files ?? [])];
              event.target.value = "";
              if (!attachmentsEnabled || sending) return;
              if (incoming.some(file => file.size < 1 || file.size > MAX_ASSET_BYTES)) {
                setError("Each file must be between 1 byte and 25 MB.");
                return;
              }
              if (incoming.length + files.length > MAX_MESSAGE_ASSETS) {
                setError("Attach up to five files per message.");
                return;
              }
              setError("");
              setFiles([
                ...files,
                ...incoming.map((file) => ({
                  id: crypto.randomUUID(),
                  name: file.name,
                  size: file.size,
                  type: file.type,
                  file,
                  ...(attachments !== undefined ? { status: "uploading" as const, progress: 0 } : {}),
                })),
              ]);
            }}
          />
          {!plainText && <IconButton
            label={attachmentsEnabled ? "Attach files" : "File uploads unavailable"}
            size="sm"
            className="sp-attach-trigger"
            disabled={!ready || sending || !attachmentsEnabled}
            data-send-disabled={sending && ready && attachmentsEnabled || undefined}
            onClick={() => fileInput.current?.click()}
          >
            <Plus size={20} />
          </IconButton>}
          {!plainText && <IconButton
            label="Show formatting"
            size="sm"
            aria-pressed={showFormats}
            onClick={() => setShowFormats(!showFormats)}
          >
            <TextAa size={20} />
          </IconButton>}
          <EmojiPicker label="Choose emoji" disabled={!ready || sending} restoreFocus={false} onSelect={insert} />
          {findMentions && <IconButton label="Mention someone" size="sm" disabled={!ready || sending} onMouseDown={event => event.preventDefault()} onClick={mentionsUI.begin}><At size={19} /></IconButton>}
          {!findMentions && mentions.length > 0 && (
            <Popover className="sp-composer-picker" panelClassName="sp-mention-options" label="Mention someone" trigger={<At size={19} />}>
              {close => <>
                {mentions.map((person) => (
                  <button
                    type="button"
                    key={person}
                    disabled={!ready || sending}
                    onClick={() => {
                      insert(`@${person} `);
                      close(false);
                    }}
                  >
                    {person}
                  </button>
                ))}
              </>}
            </Popover>
          )}
          {!plainText && <><span className="sp-composer-divider" />
          <IconButton
            label="Video recording unavailable in this preview"
            className="sp-unavailable-action"
            size="sm"
            disabled
          >
            <VideoCamera size={18} />
          </IconButton>
          <IconButton
            label="Audio recording unavailable in this preview"
            className="sp-unavailable-action"
            size="sm"
            disabled
          >
            <Microphone size={18} />
          </IconButton>
          <IconButton label="Run shortcut unavailable in this preview" className="sp-unavailable-action" size="sm" disabled>
            <Lightning size={18} />
          </IconButton></>}
          <div className="sp-rich-send-group">
          <IconButton
            label="Send now"
            size="sm"
            className="sp-send-rich"
            disabled={!ready || sending || !!sendDisabledReason || filesPending || (!text.trim() && !files.length)}
            data-send-disabled={sending && ready && !filesPending && Boolean(text.trim() || files.length) || undefined}
            onClick={() => void send()}
          >
            <PaperPlaneRight size={19} weight="fill" />
          </IconButton>
          </div>
        </div>
      </div>
      <div className="sp-rich-help">
        <span role={sendDisabledReason ? "status" : undefined}>
          {sendDisabledReason ?? (sendingVisible
            ? "Sending…"
            : text.length > 9000
              ? `${text.trim().length}/10,000 characters`
              : "Enter to send · Shift + Enter to add a new line")}
        </span>
        {!plainText && attachmentsEnabled && attachments === undefined && <span>Files stay local in this preview</span>}
      </div>
      {error && (
        <p role="alert" className="sp-field-error">
          {error}
        </p>
      )}
      <Dialog
        open={linkOpen}
        title="Add link"
        onClose={() => setLinkOpen(false)}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const url = safeLink(linkUrl);
            if (!url) {
              setLinkError(
                "Use a complete https://, http://, or mailto: link.",
              );
              return;
            }
            const q = restore();
            if (q) {
              const r = selection.current;
              if (r.length && linkText === q.getText(r.index, r.length))
                q.formatText(r.index, r.length, "link", url, "user");
              else {
                if (r.length) q.deleteText(r.index, r.length, "user");
                q.insertText(r.index, linkText || url, { link: url }, "user");
                selection.current = {
                  index: r.index + (linkText || url).length,
                  length: 0,
                };
              }
              setLinkOpen(false);
            }
          }}
        >
          <TextField
            label="Text"
            value={linkText}
            onChange={(e) => setLinkText(e.target.value)}
          />
          <TextField
            label="Link"
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            placeholder="https://example.com"
            error={linkError}
          />
          <div className="sp-link-dialog-actions">
            <Button onClick={() => setLinkOpen(false)}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={!linkUrl}>
              Save
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
