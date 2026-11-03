import { useEffect, useRef, useState } from "react";
import type Quill from "quill";
import { Reveal } from "./reveal.js";
import { isDefaultComposerSendKey } from "./composer-keyboard.js";
import { MAX_ASSET_BYTES, MAX_MESSAGE_ASSETS, MAX_MESSAGE_DOCUMENT_BYTES } from "@space/contracts";
import {
  PaperPlaneRight,
  Plus,
  Smiley,
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
  CaretDown,
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
  defaultValue,
  acknowledgedDocument,
  defaultAttachments = [],
  attachments,
  onRetryAttachment,
  onDraftChange,
  onAttachmentsChange,
  onSend,
  mentions = [],
  plainText = false,
  attachmentsEnabled = true,
}: {
  channel: string;
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
  ) => void | Promise<void>;
  mentions?: string[];
  plainText?: boolean;
  attachmentsEnabled?: boolean;
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
  const sendRef = useRef<() => void>(() => {});
  async function send() {
    const q = editor.current;
    if (!q || pending.current || filesRef.current.some(file => file.status === "uploading" || file.status === "error")) return;
    const raw = q.getText();
    const plain = raw.trim();
    if (!plain && !filesRef.current.length) return;
    if (raw.length - 1 > 10000) {
      setError(
        "Keep the message under 10,000 characters. Your draft is unchanged.",
      );
      return;
    }
    const document = normalizeDocument(q.getContents());
    if (new TextEncoder().encode(JSON.stringify(document)).byteLength > MAX_MESSAGE_DOCUMENT_BYTES) {
      setError("This message has too much formatting. Split it into smaller messages.");
      return;
    }
    pending.current = true;
    setSending(true);
    setError("");
    q.disable();
    try {
      await callbacks.current.onSend(
        plain,
        document,
        filesRef.current,
      );
      if (editor.current !== q) return;
      q.setText("");
      q.history.clear();
      setFiles([]);
      callbacks.current.onDraftChange?.({ ops: [] });
    } catch {
      if (editor.current === q)
        setError("Could not send. Your draft is still here. Try again.");
    } finally {
      if (editor.current === q) {
        pending.current = false;
        setSending(false);
        q.enable();
        q.focus();
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
        const q = new Editor(node, {
          placeholder: `Message #${channel}`,
          formats: plainText ? [] : [
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
          setFormats(q.getFormat());
          // Preserve over-limit drafts for editing; send() validates before submission.
          callbacks.current.onDraftChange?.(
            normalizeDocument(q.getContents(), Infinity),
          );
        };
        const select = (range: { index: number; length: number } | null) => {
          if (range) {
            selection.current = range;
            setFormats(q.getFormat(range));
          }
        };
        const key = (event: KeyboardEvent) => {
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
  }, [channel, plainText]);
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
  const formatButtons = tools.map(({ name, icon: Icon, format: key, value }) => (
    <IconButton key={name} label={name} size="sm"
      disabled={!ready || sending || (codeBlockActive && !["list", "blockquote", "code-block"].includes(key))}
      aria-pressed={key === "code-block" ? codeBlockActive : formats[key] === value}
      onMouseDown={(e) => e.preventDefault()} onClick={() => format(key, value)}>
      <Icon size={18} />
    </IconButton>
  ));
  return (
    <div className="sp-rich-composer">
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
                {file.status === "error" && <><small role="alert">{file.error ?? "Upload failed"}</small><Button size="sm" aria-label={`Retry upload ${file.name}`} disabled={sending} onClick={() => onRetryAttachment?.(file.id)}>Retry</Button></>}
                <IconButton
                  label={`Remove ${file.name}`}
                  size="sm"
                  disabled={sending}
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
          <Popover className="sp-composer-picker" label="Choose emoji" trigger={<Smiley size={19} />}>
            {close => <>
              {["🙂", "🙌", "💜", "🎉", "👍", "🚀"].map((emoji) => (
                <button
                  type="button"
                  key={emoji}
                  aria-label={`Insert ${emoji}`}
                  disabled={!ready || sending}
                  onClick={() => {
                    insert(emoji);
                    close(false);
                  }}
                >
                  {emoji}
                </button>
              ))}
            </>}
          </Popover>
          {mentions.length > 0 && (
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
            disabled={!ready || sending || filesPending || (!text.trim() && !files.length)}
            onClick={() => void send()}
          >
            <PaperPlaneRight size={19} weight="fill" />
          </IconButton>
          {!plainText && <IconButton label="Schedule for later unavailable in this preview" size="sm" className="sp-schedule-rich" disabled>
            <CaretDown size={12} />
          </IconButton>}
          </div>
        </div>
      </div>
      <div className="sp-rich-help">
        <span>
          {sending
            ? "Sending…"
            : text.length > 9000
              ? `${text.trim().length}/10,000 characters`
              : "Enter to send · Shift + Enter to add a new line"}
        </span>
        {!plainText && attachmentsEnabled && <span>{attachments !== undefined ? "Up to 5 files · 25 MB each" : "Files stay local in this preview"}</span>}
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
