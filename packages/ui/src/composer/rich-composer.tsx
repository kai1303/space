import { ClipRecorder } from "./clip-recorder.js";
import { AttachmentDrafts } from "./attachment-drafts.js";
import { formatPastedLinks } from "./pasted-links.js";
import { registerMention } from "./mention-blot.js";
import { useMentions, type FindMentions } from "./use-mentions.js";
import { documentMentions, isEmojiOnlyText } from "@space/contracts";
import { useEffect, useLayoutEffect, useRef, useState, useId, type ReactNode } from "react";
import { EmojiPicker } from "../emoji/emoji-picker.js";
import { emojiCompletion, emojiDocument, emojiNative, emojiPreferences } from "../emoji/emoji.js";
import type Quill from "quill";
import { Reveal } from "../motion/reveal.js";
import { motion, useReducedMotion } from "motion/react";
import { motionTransition } from "../motion/motion.js";
import { isDefaultComposerSendKey } from "./composer-keyboard.js";
import { ScheduleSend, openScheduleMenu } from "./schedule-send.js";
import { MAX_ASSET_BYTES, MAX_MESSAGE_ASSETS, MAX_MESSAGE_DOCUMENT_BYTES } from "@space/contracts";
import {
  UploadSimple,
  File as FileIcon,
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
  Microphone,
  VideoCamera,
  Lightning,
} from "@phosphor-icons/react";
import { Button, Dialog, IconButton, Popover, TextField } from "../primitives/primitives.js";
import {
  normalizeDocument,
  safeLink,
  type Attachment,
  type RichDocument,
} from "../rich-text/rich-text.js";

/** A send failure with a message intended for the person composing the draft. */
export class ComposerSendError extends Error {}

// Keep only local offsets across composer remounts. Draft text stays with the caller.
const draftSelections = new Map<string, { index: number; length: number }>();

function rememberSelection(key: string | undefined, q: Quill) {
  if (!key) return;
  draftSelections.delete(key);
  if (q.getLength() <= 1) return;
  draftSelections.set(key, q.selection.savedRange);
  if (draftSelections.size > 100) draftSelections.delete(draftSelections.keys().next().value!);
}

export function RichComposer({
  channel,
  conversationKey,
  scope = "channel",
  placeholder, editorLabel,
  loadReplySuggestion,
  defaultValue,
  draftValue,
  acknowledgedDocument,
  defaultAttachments = [],
  attachments,
  onRetryAttachment,
  onDraftChange,
  onAttachmentsChange,
  onSend,
  onSchedule,
  mentions = [],
  findMentions,
  plainText = false,
  maxLength = 10000,
  attachmentsEnabled = true,
  audioClipsEnabled = false,
  videoClipsEnabled = false,
  formattingEnabled = true,
  emojiEnabled = true,
  sendDisabledReason,
  sendDisabled = false,
  showUnavailableActions = true,
  showKeyboardHint = true,
  feedbackAtSendButton = false,
  attachedFormattingToolbar = false,
  submitLabel, submitIcon, submitAccessory, onAlternateSend,
  renderFilePicker,
  renderExtraActions, renderAddMenuItems, renderBeforeSend,
  addMenuVariant = "standard",
  autoFocus = false,
  onEditReady,
}: {
  channel: string;
  conversationKey?: string;
  scope?: "channel" | "thread";
  placeholder?: string;
  editorLabel?: string;
  loadReplySuggestion?: (signal: AbortSignal) => Promise<string | null>;
  defaultValue?: RichDocument;
  /** Live draft for this destination. Pass null for a cleared draft. */
  draftValue?: RichDocument | null;
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
  /** Shows Slack's schedule menu beside Send. Resolves once the server has stored the schedule. */
  onSchedule?: (text: string, document: RichDocument, attachments: Attachment[], at: Date) => Promise<void>;
  mentions?: string[];
  findMentions?: FindMentions;
  plainText?: boolean;
  maxLength?: number;
  attachmentsEnabled?: boolean;
  audioClipsEnabled?: boolean;
  videoClipsEnabled?: boolean;
  formattingEnabled?: boolean;
  emojiEnabled?: boolean;
  sendDisabledReason?: string;
  sendDisabled?: boolean;
  showUnavailableActions?: boolean;
  showKeyboardHint?: boolean;
  feedbackAtSendButton?: boolean;
  attachedFormattingToolbar?: boolean;
  submitLabel?: string;
  submitIcon?: ReactNode;
  submitAccessory?: ReactNode;
  onAlternateSend?: (text:string, document:RichDocument, attachments:Attachment[])=>void | Promise<void>;
  renderFilePicker?: (insert: (files: File[]) => void, close: () => void, remaining: number, upload: () => void) => ReactNode;
  addMenuVariant?: "standard" | "agent-session";
  renderAddMenuItems?: (close: (restoreFocus?: boolean) => void) => ReactNode;
  renderBeforeSend?: (insertText: (value: string) => void, disabled: boolean) => ReactNode;
  renderExtraActions?: (insertText: (value: string) => void, disabled: boolean) => ReactNode;
  autoFocus?: boolean;
  onEditReady?: () => void;
}) {
  const agentAddMenu = addMenuVariant === "agent-session";
  const mount = useRef<HTMLDivElement>(null);
  const editor = useRef<Quill | null>(null);
  const callbacks = useRef({ onDraftChange, onAttachmentsChange, onSend, onSchedule });
  callbacks.current = { onDraftChange, onAttachmentsChange, onSend, onSchedule };
  const initial = useRef(draftValue === undefined ? defaultValue : draftValue);
  const restoreOnFocus = useRef(false);
  const editRevision = useRef(0);
  const liveKey = useRef(draftValue === undefined ? undefined : conversationKey);
  const seenDraft = useRef(draftValue);
  const deferredDraft = useRef<RichDocument | null | undefined>(undefined);
  const applyDraft = useRef<(value: RichDocument | null) => void>(undefined);
  const labels = useRef({ channel, placeholder, editorLabel });
  labels.current = { channel, placeholder, editorLabel };
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
    clearSubmittedDraft(q);
  }, [acknowledgedDocument, ready]);
  const [text, setText] = useState("");
  const emojiOnly = isEmojiOnlyText(text);
  const reducedMotion = useReducedMotion();
  const [formats, setFormats] = useState<Record<string, unknown>>({});
  // Phones start with a slim composer; "Show formatting" brings the toolbar back.
  const [showFormats, setShowFormats] = useState(() => !(typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(max-width: 720px)").matches));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [localFiles, setLocalFiles] = useState<Attachment[]>(attachmentsEnabled ? defaultAttachments : []);
  const files = attachments ?? localFiles;
  function setFiles(next: Attachment[]) {
    if (attachments === undefined) setLocalFiles(next);
    callbacks.current.onAttachmentsChange?.(next);
  }
  const [picking, setPicking] = useState(false);
  const [draggingFiles, setDraggingFiles] = useState(false);
  function addFiles(incoming: File[]) {
    if (!incoming.length || plainText || !attachmentsEnabled || !ready || sending) return;
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
  }
  const filesPending = files.some(file => file.status === "uploading" || file.status === "error");
  const filesRef = useRef(files);
  filesRef.current = files;
  const [focused, setFocused] = useState(false);
  const [reply, setReply] = useState<{ source: typeof loadReplySuggestion; text: string }>();
  const blocked = sendDisabled || !!sendDisabledReason;
  const waitingForUploads = useRef<{
    keys: string[]; resolve: (files: Attachment[]) => void; reject: (error: Error) => void;
  } | null>(null);
  useEffect(() => {
    const waiting = waitingForUploads.current;
    if (!waiting) return;
    const batch = waiting.keys.map(key => files.find(file => (file.draftId ?? file.id) === key));
    if (blocked || batch.some(file => !file || file.status === "error")) {
      waitingForUploads.current = null;
      waiting.reject(new ComposerSendError(blocked ? "Posting unavailable." : "An attachment failed. Retry or remove it, then send again."));
    } else if (batch.every(file => file?.status !== "uploading")) {
      waitingForUploads.current = null;
      waiting.resolve(batch as Attachment[]);
    }
  }, [files, blocked]);
  useEffect(() => () => {
    waitingForUploads.current?.reject(new Error("Composer closed"));
    waitingForUploads.current = null;
  }, []);
  const eligible = !!loadReplySuggestion && focused && text === "\n" && !files.length && !sending && !blocked;
  const visibleReply = eligible && reply?.source === loadReplySuggestion ? reply?.text : undefined;
  const replyRef = useRef(visibleReply);
  replyRef.current = visibleReply;
  useEffect(() => {
    setReply(undefined);
    if (!eligible || !loadReplySuggestion) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const value = await loadReplySuggestion(controller.signal);
        if (!controller.signal.aborted && value) setReply({ source: loadReplySuggestion, text: value });
      } catch { /* Suggestions are optional; the editor stays usable. */ }
    }, 500);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [eligible, loadReplySuggestion]);
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
  const feedbackId = useId();
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
  useEffect(() => {
    const q = editor.current;
    if (!editorVersion || !q || !onEditReady) return;
    // A thread's footer stays inert until its history is ready.
    const focusWhenAvailable = () => {
      const container = q.root.closest('[inert]');
      if (container) {
        observer.observe(container, { attributes: true, attributeFilter: ['inert'] });
        return;
      }
      observer.disconnect();
      q.focus();
      if (q.hasFocus()) onEditReady();
    };
    const observer = new MutationObserver(focusWhenAvailable);
    focusWhenAvailable();
    return () => observer.disconnect();
  }, [editorVersion, onEditReady, conversationKey]);
  useEffect(() => {
    const root = editor.current?.root;
    if (!root) return;
    root.setAttribute('aria-label', editorLabel ?? `Message ${channel}`);
    root.setAttribute('data-placeholder', visibleReply ? '' : placeholder ?? `Message #${channel}`);
  }, [channel, placeholder, editorLabel, editorVersion, visibleReply]);
  const mentionsUI = useMentions(editor, ready, conversationKey ?? channel, findMentions, editorVersion);
  const mentionKeys = useRef(mentionsUI.key); mentionKeys.current = mentionsUI.key;
  const [broadcastWarning, setBroadcastWarning] = useState(false);
  const sendRef = useRef<(alternate?:boolean) => void>(() => {});
  const alternateEnabled=useRef(false);
  alternateEnabled.current=!!onAlternateSend;
  // Touch long-press on Send opens the schedule menu; the click that ends the press must not also send.
  const holdTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const heldSend = useRef(false);
  useEffect(() => () => clearTimeout(holdTimer.current), []);
  const destination = useRef(conversationKey);
  const generation = useRef(0);
  useLayoutEffect(() => {
    if (destination.current === conversationKey) return;
    if (editor.current) rememberSelection(liveKey.current, editor.current);
    liveKey.current = draftValue === undefined ? undefined : conversationKey;
    deferredDraft.current = undefined;
    seenDraft.current = draftValue;
    destination.current = conversationKey;
    generation.current++;
    waitingForUploads.current?.reject(new Error("Conversation changed"));
    waitingForUploads.current = null;
    pending.current = false;
    setSending(false);
    clearTimeout(holdTimer.current);
    heldSend.current = false;
    seenAcknowledgment.current = acknowledgedDocument;
    initial.current = draftValue === undefined ? defaultValue : draftValue;
    const q = editor.current;
    if (q) {
      q.enable();
      const focused = q.hasFocus();
      q.setContents(normalizeDocument(initial.current, Infinity).ops, "silent");
      restoreDraftSelection(q, focused);
      q.history.clear();
      setText(q.getText());
    }
    completionRef.current = null;
    returnToSelection.current = false;
    setFormats({});
    setCompletion(null);
    setLinkOpen(false);
    setLinkText("");
    setLinkUrl("");
    setLinkError("");
    setBroadcastWarning(false);
    setPicking(false);
    setDraggingFiles(false);
    setError("");
    setReply(undefined);
    setLocalFiles(defaultAttachments);
  }, [conversationKey, draftValue, defaultValue, acknowledgedDocument, defaultAttachments]);

  useLayoutEffect(() => {
    liveKey.current = draftValue === undefined ? undefined : conversationKey;
    if (draftValue === seenDraft.current) return;
    const previous = seenDraft.current;
    seenDraft.current = draftValue;
    if (draftValue === undefined || JSON.stringify(draftValue) === JSON.stringify(previous)) return;
    initial.current = draftValue;
    const q = editor.current;
    if (q?.composition.isComposing) deferredDraft.current = draftValue;
    else applyDraft.current?.(draftValue);
  }, [conversationKey, draftValue]);

  function restoreDraftSelection(q: Quill, focused: boolean) {
    const saved = liveKey.current ? draftSelections.get(liveKey.current) : undefined;
    const end = q.getLength() - 1;
    const index = Math.min(saved?.index ?? (liveKey.current ? end : 0), end);
    const range = { index, length: Math.min(saved?.length ?? 0, end - index) };
    selection.current = q.selection.savedRange = range;
    restoreOnFocus.current = !focused && !!liveKey.current;
    if (focused) q.setSelection(range, "silent");
  }

  function clearSubmittedDraft(q: Quill) {
    q.setText("", "silent");
    q.history.clear();
    setText(q.getText());
    setFormats({});
    setCompletion(null);
    completionRef.current = null;
    callbacks.current.onDraftChange?.({ ops: [] });
  }

  // A scheduled send passes `at`; it shares validation, clearing and error handling with Send now.
  async function send(confirmed = false, at?: Date, alternate=false) {
    const q = editor.current;
    if (!q || pending.current || blocked || filesRef.current.some(file => file.status === "error" || (at && file.status === "uploading"))) return;
    const version = generation.current;
    const isCurrent = () => editor.current === q && generation.current === version;
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
    if (!confirmed && !at && mentionsUI.memberCount >= 6 && findMentions && documentMentions(document).some(ref => ref.kind === 'broadcast') && scope === 'channel') { setBroadcastWarning(true); return; }
    pending.current = true;
    setSending(true);
    setError("");
    q.disable();
    try {
      const plainText = document.ops.map(op => op.insert).join("").trim();
      const alternateSubmit=alternate ? onAlternateSend : undefined;
      const normalSubmit=callbacks.current.onSend;
      const selected = filesRef.current;
      const batch = selected.some(file => file.status === "uploading")
        ? await new Promise<Attachment[]>((resolve, reject) => {
            waitingForUploads.current = { keys: selected.map(file => file.draftId ?? file.id), resolve, reject };
          })
        : selected;
      if (!isCurrent()) return;
      if (at && callbacks.current.onSchedule) await callbacks.current.onSchedule(plainText, document, batch, at);
      else if (confirmed) await callbacks.current.onSend(plainText, document, batch, { broadcast_confirmed: true });
      else await (alternateSubmit ?? normalSubmit)(plainText, document, batch);
      if (!isCurrent()) return;
      if (JSON.stringify(normalizeDocument(q.getContents(), Infinity)) === JSON.stringify(document))
        clearSubmittedDraft(q);
      const sentIds = new Set(selected.map(file => file.draftId ?? file.id));
      setFiles(filesRef.current.filter(file => !sentIds.has(file.draftId ?? file.id)));
    } catch (reason) {
      if (!isCurrent()) return;
      if (reason instanceof Error && reason.message === 'broadcast_confirmation_required') setBroadcastWarning(true);
      else
        setError(reason instanceof ComposerSendError ? reason.message : "Could not send. Your draft is still here. Try again.");
    } finally {
      if (isCurrent()) {
        pending.current = false;
        setSending(false);
        q.enable();
        const dom = q.root.ownerDocument;
        if (dom.activeElement === dom.body || mount.current?.parentElement?.contains(dom.activeElement)) q.focus();
      }
    }
  }
  sendRef.current = alternate => void send(false,undefined,alternate);
  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    import("quill")
      .then(({ default: Editor, Delta }) => {
        if (disposed || !mount.current) return;
        const node = document.createElement("div");
        mount.current.append(node);
        registerMention(Editor);
        const q = new Editor(node, {
          placeholder: labels.current.placeholder ?? `Message #${labels.current.channel}`,
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
        if (!plainText) formatPastedLinks(q, Delta);
        editor.current = q;
        completionRef.current = null; setCompletion(null);
        pending.current = false;
        setSending(false);
        q.root.setAttribute("role", "textbox");
        q.root.setAttribute("aria-label", labels.current.editorLabel ?? `Message ${labels.current.channel}`);
        q.root.setAttribute("aria-multiline", "true");
        if (initial.current)
          q.setContents(
            normalizeDocument(initial.current, Infinity).ops,
            "silent",
          );
        restoreDraftSelection(q, false);
        applyDraft.current = value => {
          const next = new Delta(normalizeDocument(value, Infinity).ops);
          const last = next.ops.at(-1)?.insert;
          if (typeof last !== "string" || !last.endsWith("\n")) next.insert("\n");
          const changes = q.getContents().diff(next);
          if (!changes.ops.length) return; // Local echo. Preserve selection, formatting and undo.
          const focused = q.hasFocus();
          const range = q.getSelection() ?? q.selection.savedRange;
          q.updateContents(changes, "silent");
          const end = q.getLength() - 1;
          const index = Math.min(changes.transformPosition(range.index), end);
          const extent = Math.min(changes.transformPosition(range.index + range.length), end);
          selection.current = q.selection.savedRange = {index, length: extent - index};
          restoreOnFocus.current = !focused;
          if (focused) q.setSelection(selection.current, "silent");
          q.history.clear();
          setText(q.getText());
          setFormats(focused ? q.getFormat(selection.current) : {});
          suggest(q, focused ? selection.current : null);
          setBroadcastWarning(false);
        };
        const compositionEnd = () => queueMicrotask(() => {
          if (disposed || deferredDraft.current === undefined) return;
          const value = deferredDraft.current;
          deferredDraft.current = undefined;
          applyDraft.current?.(value);
        });
        setText(q.getText());
        const change = () => {
          editRevision.current++;
          // The committed IME change is the newest local edit.
          deferredDraft.current = undefined;
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
          const replyText = replyRef.current;
          if (replyText && q.getLength() === 1 && q.hasFocus() && !pending.current && !filesRef.current.length &&
              !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey &&
              (event.key === "Tab" || event.key === "Escape")) {
            event.preventDefault();
            event.stopImmediatePropagation();
            replyRef.current = undefined;
            setReply(undefined);
            if (event.key === "Tab") {
              q.insertText(0, replyText, "user");
              q.setSelection(replyText.length, 0, "silent");
            }
            return;
          }
          if (alternateEnabled.current && event.key==='Enter' && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey) {
            event.preventDefault();
            event.stopPropagation();
            sendRef.current(true);
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
        q.root.addEventListener("compositionend", compositionEnd);
        setReady(true);
        if (autoFocus) q.focus();
        setEditorVersion(version => version + 1);
        cleanup = () => {
          rememberSelection(liveKey.current, q);
          applyDraft.current = undefined;
          deferredDraft.current = undefined;
          q.root.removeEventListener("compositionend", compositionEnd);
          q.off("text-change", change);
          q.off("selection-change", select);
          q.root.removeEventListener("keydown", key, true);
          initial.current = normalizeDocument(q.getContents(), Infinity);
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
  }, [plainText]);
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
    { name: "Bold", icon: TextB, iconSize: 22, format: "bold", value: true },
    { name: "Italic", icon: TextItalic, iconSize: 23, format: "italic", value: true },
    {
      name: "Underline",
      icon: TextUnderline,
      iconSize: 22,
      format: "underline",
      value: true,
    },
    {
      name: "Strikethrough",
      icon: TextStrikethrough,
      iconSize: 20,
      format: "strike",
      value: true,
    },
    {
      name: "Ordered list",
      icon: ListNumbers,
      iconSize: 20,
      format: "list",
      value: "ordered",
    },
    {
      name: "Bulleted list",
      icon: ListBullets,
      iconSize: 24,
      format: "list",
      value: "bullet",
    },
    { name: "Blockquote", icon: Quotes, iconSize: 22, format: "blockquote", value: true },
    { name: "Code", icon: Code, iconSize: 18, format: "code", value: true },
    { name: "Code block", icon: CodeBlock, iconSize: 20, format: "code-block", value: true },
  ];
  const codeBlockActive = Boolean(formats["code-block"]);
  const formatButtons = tools.map(({ name, icon: Icon, iconSize, format: key, value }) => {
    const unavailable = !ready || (codeBlockActive && !["list", "blockquote", "code-block"].includes(key));
    return (
    <IconButton key={name} label={name} size="sm"
      disabled={unavailable || sending}
      data-send-disabled={sending && !unavailable || undefined}
      aria-pressed={key === "code-block" ? codeBlockActive : formats[key] === value}
      onMouseDown={(e) => e.preventDefault()} onClick={() => format(key, value)}>
      <Icon size={iconSize} />
    </IconButton>
  ); });
  const formattingToolbar = (
    <div
      className={attachedFormattingToolbar ? "sp-rich-toolbar sp-rich-toolbar--attached" : "sp-rich-toolbar"}
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
        <Link size={19} />
      </IconButton>
      <span className="sp-rich-format-separator" aria-hidden="true" />
      {formatButtons.slice(4, 7)}
      <span className="sp-rich-format-separator" aria-hidden="true" />
      {formatButtons.slice(7)}
    </div>
  );
  return (
    <div className={feedbackAtSendButton ? "sp-rich-composer sp-rich-composer--send-feedback" : "sp-rich-composer"} aria-busy={sending || undefined}>
      {mentionsUI.suggestions}
      <Dialog open={broadcastWarning} title="Notify the channel?" onClose={() => setBroadcastWarning(false)}><p>This message can notify {mentionsUI.memberCount || 'all eligible'} channel members. Use channel-wide mentions sparingly.</p><div className="sp-mention-confirm"><Button onClick={() => setBroadcastWarning(false)}>Keep editing</Button><Button variant="primary" onClick={() => { setBroadcastWarning(false); void send(true); }}>Send and notify</Button></div></Dialog>
      {completion && <div className="sp-emoji-suggestions" id={suggestionsId} role="listbox" aria-label="Emoji suggestions">
        {completion.items.map((item, index) => <button id={`${suggestionsId}-${index}`} type="button" role="option" aria-selected={index === emojiIndex} key={item.id} onMouseDown={event => event.preventDefault()} onClick={() => completeEmoji(index)}><span>{emojiNative(item.id, emojiPreferences().skin)}</span><span>:{item.id}:</span></button>)}
      </div>}
      {picking && attachmentsEnabled && renderFilePicker?.(incoming=>{addFiles(incoming);setPicking(false);editor.current?.focus();},()=>{setPicking(false);editor.current?.focus();},MAX_MESSAGE_ASSETS-files.length,()=>{setPicking(false);fileInput.current?.click();})}
      <div className="sp-rich-editor-shell" data-file-drop={draggingFiles || undefined}
        data-attached-formatting={attachedFormattingToolbar && formattingEnabled && !plainText ? (showFormats ? "open" : "closed") : undefined}
        onDragOverCapture={event=>{
          if (!event.dataTransfer.types.includes('Files')) return;
          event.preventDefault(); event.stopPropagation();
          const allowed=attachmentsEnabled && !plainText && ready && !sending;
          event.dataTransfer.dropEffect=allowed ? 'copy' : 'none'; setDraggingFiles(allowed);
        }}
        onDragLeave={event=>{if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDraggingFiles(false);}}
        onDropCapture={event=>{
          if (!event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();event.stopPropagation();setDraggingFiles(false);addFiles(Array.from(event.dataTransfer.files));
        }}
        onPasteCapture={event=>{
          if (!event.clipboardData.files.length) return;
          event.preventDefault();event.stopPropagation();addFiles(Array.from(event.clipboardData.files));
        }}>
        {!plainText && formattingEnabled && <Reveal open={showFormats} fadeOnExit={attachedFormattingToolbar}>{formattingToolbar}</Reveal>}
        <div className="sp-rich-input" onPointerDown={() => { restoreOnFocus.current = false; }} onFocus={event => {
          const q = editor.current;
          if (q && event.target === q.root) {
            if (restoreOnFocus.current) {
              const range = selection.current;
              const version = generation.current;
              const revision = editRevision.current;
              queueMicrotask(() => {
                // A toolbar action can focus the editor and insert text before this runs.
                if (editor.current === q && generation.current === version && editRevision.current === revision && q.hasFocus()) q.setSelection(range, "silent");
              });
            }
            restoreOnFocus.current = false;
            setFocused(true);
          }
        }} onBlur={() => setFocused(false)}>
          <motion.div className="sp-rich-editor" ref={mount} initial={false}
            animate={{ fontSize: emojiOnly ? 32 : 15, lineHeight: emojiOnly ? "38.4px" : "22px" }}
            transition={motionTransition(reducedMotion, 0.16)} />
          {visibleReply && <div className="sp-reply-suggestion" role="status">
            {visibleReply} <small>Tab to accept</small>
          </div>}
        </div>
        {!ready && !error && (
          <p className="sp-rich-loading" role="status">
            Loading editor…
          </p>
        )}
        {sending && files.some(file => file.status === "uploading") && <span role="status" className="sp-draft-send-pending">Sending after upload…</span>}
        {files.length > 0 && <AttachmentDrafts files={files} onChange={setFiles} disabled={sending} onRetry={onRetryAttachment} />}
        <div
          key={conversationKey}
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
              addFiles(incoming);
            }}
          />
          {!plainText && (attachmentsEnabled || renderAddMenuItems) && <span className="sp-attach-menu" title={attachmentsEnabled ? "Attach · Double-click to upload" : "Add"}
            onDoubleClick={event => { if (attachmentsEnabled && ready && !sending && (event.target as Element).closest('summary')) fileInput.current?.click(); }}>
            <Popover label={agentAddMenu || renderAddMenuItems ? "Add to message" : "Attach files"} panelLabel={agentAddMenu || renderAddMenuItems ? "Add to message" : "Attach"} className="sp-composer-picker" triggerClassName="sp-attach-trigger"
              floating align="start" role="menu" panelClassName={agentAddMenu ? "sp-menu-content sp-attach-options sp-agent-add-options" : "sp-menu-content sp-attach-options"} disabled={!ready || sending} trigger={<Plus size={20}/>}>
              {close => {
                const browse = attachmentsEnabled && renderFilePicker && <button type="button" role="menuitem" onClick={()=>{close(false);setPicking(true);}}>
                  <FileIcon size={17}/>{agentAddMenu ? "Browse Space files" : "File"}
                </button>;
                const upload = attachmentsEnabled && <button type="button" role="menuitem" onClick={()=>{close();fileInput.current?.click();}}>
                  <UploadSimple size={17}/>{agentAddMenu ? "Upload from computer" : "Upload from your computer"}
                </button>;
                return <>
                  {agentAddMenu ? upload : browse}
                  {agentAddMenu ? browse : upload}
                  {agentAddMenu && attachmentsEnabled && renderAddMenuItems && <hr role="separator"/>}
                  {renderAddMenuItems?.(close)}
                </>;
              }}
            </Popover>
          </span>}
          {!plainText && !attachmentsEnabled && !renderAddMenuItems && showUnavailableActions && <IconButton label="File uploads unavailable" className="sp-attach-trigger" size="sm" disabled><Plus size={20}/></IconButton>}
          {!plainText && formattingEnabled && <IconButton
            label="Show formatting"
            size="sm"
            aria-pressed={showFormats}
            onClick={() => setShowFormats(!showFormats)}
          >
            <TextAa size={20} />
          </IconButton>}
          {emojiEnabled && <EmojiPicker label="Choose emoji" disabled={!ready || sending} restoreFocus={false} onSelect={insert} />}
          {findMentions && <IconButton label="Mention someone" size="sm" disabled={!ready || sending} onMouseDown={event => event.preventDefault()} onClick={mentionsUI.begin}><At size={19} /></IconButton>}
          {!findMentions && mentions.length > 0 && (
            <Popover floating disabled={!ready || sending} className="sp-composer-picker" panelClassName="sp-menu-content sp-mention-options" label="Mention someone" trigger={<At size={19} />}>
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
          {!plainText && showUnavailableActions && <span className="sp-composer-divider" />}
          {!plainText && (['video', 'audio'] as const).map(kind => {
            const enabled = kind === 'video' ? videoClipsEnabled : audioClipsEnabled;
            if (enabled && attachmentsEnabled) return <ClipRecorder key={kind} kind={kind}
              disabled={!ready || sending || blocked || files.length >= MAX_MESSAGE_ASSETS} onAttach={file => addFiles([file])}/>;
            return showUnavailableActions && <IconButton key={kind}
              label={enabled ? 'Recording clips requires file uploads' : `${kind === 'video' ? 'Video' : 'Audio'} recording unavailable in this preview`}
              className="sp-unavailable-action" size="sm" disabled>{kind === 'video' ? <VideoCamera size={18}/> : <Microphone size={18}/>}</IconButton>;
          })}
          {!plainText && showUnavailableActions && <IconButton label="Run shortcut unavailable in this preview" className="sp-unavailable-action" size="sm" disabled>
            <Lightning size={18} />
          </IconButton>}
          {renderExtraActions?.(insert, !ready || sending)}
          <div className="sp-rich-send-group"
            tabIndex={feedbackAtSendButton && sendDisabledReason ? 0 : undefined}
            role={feedbackAtSendButton && sendDisabledReason ? "group" : undefined}
            aria-label={feedbackAtSendButton && sendDisabledReason ? "Send unavailable" : undefined}
            aria-describedby={feedbackAtSendButton && sendDisabledReason ? feedbackId : undefined}>
          {submitAccessory}
          {renderBeforeSend?.(insert, !ready || sending)}
          <IconButton
            label={submitLabel ?? "Send now"}
            size="sm"
            className="sp-send-rich"
            disabled={!ready || sending || blocked || files.some(file => file.status === "error") || (!text.trim() && !files.length)}
            data-send-disabled={sending && ready && !filesPending && Boolean(text.trim() || files.length) || undefined}
            onClick={() => { if (heldSend.current) { heldSend.current = false; return; } void send(); }}
            onPointerDown={onSchedule ? event => {
              if (event.pointerType !== "touch") return;
              const group = event.currentTarget.parentElement;
              clearTimeout(holdTimer.current);
              holdTimer.current = setTimeout(() => { heldSend.current = true; openScheduleMenu(group); }, 450);
            } : undefined}
            onPointerUp={() => clearTimeout(holdTimer.current)}
            onPointerLeave={() => clearTimeout(holdTimer.current)}
            onContextMenu={onSchedule ? event => event.preventDefault() : undefined}
          >
            {submitIcon ?? submitLabel ?? <PaperPlaneRight size={19} weight="fill" />}
          </IconButton>
          {onSchedule && <ScheduleSend disabled={!ready || sending || blocked || filesPending || (!text.trim() && !files.length)} onSchedule={at => void send(false, at)} />}
          </div>
        </div>
      </div>
      {(showKeyboardHint || sendDisabledReason || text.length > 9000 || (!plainText && attachmentsEnabled && attachments === undefined)) && <div className="sp-rich-help" id={feedbackId}>
        <span role={sendDisabledReason ? "status" : undefined}>
          {sendDisabledReason ?? (text.length > 9000
            ? `${text.trim().length}/10,000 characters`
            : showKeyboardHint ? "Enter to send · Shift + Enter to add a new line" : null)}
        </span>
        {!plainText && attachmentsEnabled && attachments === undefined && <span>Files stay local in this preview</span>}
      </div>}
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
