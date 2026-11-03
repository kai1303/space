import { parseMention, mentionOperations, type MentionReference } from "@space/contracts";
import { emojiDocument } from "./emoji.js";
import { Fragment, type ReactNode } from "react";
import type { RichAttributes, RichDocument } from "@space/contracts";
export type { RichAttributes, RichDocument } from "@space/contracts";
export type Attachment = {
  id: string;
  name: string;
  size: number;
  type: string;
  file?: File;
  status?: "uploading" | "ready" | "error";
  progress?: number;
  error?: string;
};
export function safeLink(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (["https:", "http:", "mailto:"].includes(url.protocol)) return url.href;
  } catch {}
  return undefined;
}
export function normalizeDocument(
  input: unknown,
  maxCharacters = 10001,
): RichDocument {
  const source =
    input &&
    typeof input === "object" &&
    "ops" in input &&
    Array.isArray(input.ops)
      ? input.ops
      : [];
  let remaining = maxCharacters; // Includes Quill's terminal newline for submitted messages.
  const ops: RichDocument["ops"] = [];
  for (const item of source.slice(
    0,
    Number.isFinite(maxCharacters) ? 20000 : source.length,
  )) {
    if (!item || typeof item.insert !== "string" || !remaining) continue;
    const insert = item.insert.slice(0, remaining);
    remaining -= insert.length;
    const attributes: RichAttributes = {};
    const a = item.attributes ?? {};
    for (const key of [
      "bold",
      "italic",
      "underline",
      "strike",
      "code",
      "blockquote",
    ] as const)
      if (a[key] === true) attributes[key] = true;
    if (a.mention) {
      try { const mention = parseMention(a.mention); if (insert === `@${mention.label}`) attributes.mention = mention; } catch { /* Malformed draft references stay plain text. */ }
    }
    if (typeof a.link === "string") {
      const link = safeLink(a.link);
      if (link) attributes.link = link;
    }
    if (a.list === "ordered" || a.list === "bullet") attributes.list = a.list;
    if (a["code-block"] === true || typeof a["code-block"] === "string")
      attributes["code-block"] = true;
    ops.push(
      Object.keys(attributes).length ? { insert, attributes } : { insert },
    );
  }
  return { ops };
}
export function documentText(document: RichDocument) {
  return document.ops.map((op) => op.insert).join("");
}
export function RichContent({ document, onMentionClick, viewerId }: { document: RichDocument; onMentionClick?: (mention: MentionReference) => void; viewerId?: string }) {
  const safe = emojiDocument(normalizeDocument(document));
  const active = new Set(mentionOperations(safe).map(item => item.index));
  const lines: { content: ReactNode[]; attributes: RichAttributes }[] = [];
  let content: ReactNode[] = [];
  let key = 0;
  for (const [opIndex, op] of safe.ops.entries()) {
    const parts = op.insert.split("\n");
    parts.forEach((part, index) => {
      if (part) {
        let node: ReactNode = part;
        const a = op.attributes ?? {};
        if (a.mention && active.has(opIndex) && !a.code && !a.link) {
          const mention = a.mention, className = `sp-mention-token${mention.kind === 'user' && mention.id === viewerId ? ' is-self' : ''}`;
          node = onMentionClick && mention.kind !== 'broadcast' ? <button type="button" className={className} onClick={() => onMentionClick(mention)}>{part}</button> : <span className={className}>{part}</span>;
        }
        if (a.code) node = <code>{node}</code>;
        if (a.bold) node = <strong>{node}</strong>;
        if (a.italic) node = <em>{node}</em>;
        if (a.underline) node = <u>{node}</u>;
        if (a.strike) node = <s>{node}</s>;
        if (a.link)
          node = (
            <a href={a.link} target="_blank" rel="noopener noreferrer">
              {node}
            </a>
          );
        content.push(<Fragment key={key++}>{node}</Fragment>);
      }
      if (index < parts.length - 1) {
        lines.push({ content, attributes: op.attributes ?? {} });
        content = [];
      }
    });
  }
  if (content.length) lines.push({ content, attributes: {} });
  const rendered: ReactNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.attributes.list) {
      const ordered = line.attributes.list === "ordered";
      const items: ReactNode[] = [];
      do {
        items.push(<li key={i}>{lines[i]!.content}</li>);
        i++;
      } while (
        i < lines.length &&
        lines[i]!.attributes.list === line.attributes.list
      );
      i--;
      rendered.push(
        ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>,
      );
    } else if (line.attributes["code-block"]) {
      const code: ReactNode[] = [];
      let firstLine = true;
      do {
        if (!firstLine) code.push("\n");
        firstLine = false;
        code.push(...lines[i]!.content);
        i++;
      } while (i < lines.length && lines[i]!.attributes["code-block"]);
      i--;
      rendered.push(
        <pre key={i}>
          <code>{code}</code>
        </pre>,
      );
    } else if (line.attributes.blockquote)
      rendered.push(<blockquote key={i}>{line.content}</blockquote>);
    else
      rendered.push(
        <p key={i}>{line.content.length ? line.content : <br />}</p>,
      );
  }
  return <div className="sp-rich-content">{rendered}</div>;
}
