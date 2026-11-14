import { Fragment, useEffect, useRef, useState } from "react";
import { Check, Copy } from "@phosphor-icons/react";
import { IconButton } from "../primitives/primitives.js";
import { highlightCode, languageName, type CodeToken } from "./syntax-highlight.js";

export async function copyCode(code: string, trigger: HTMLElement) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(code);
      return;
    }
  } catch { /* Embedded browsers can reject the modern clipboard API. */ }
  if (!trigger.isConnected) throw new Error('Copy control unavailable');
  const doc = trigger.ownerDocument;
  const focused = doc.activeElement as HTMLElement | null;
  const selection = doc.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  const field = doc.createElement('textarea');
  field.value = code;
  field.readOnly = true;
  field.tabIndex = -1;
  field.setAttribute('aria-hidden', 'true');
  field.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
  (trigger.closest('dialog[open]') ?? doc.body).append(field);
  try {
    field.focus({ preventScroll: true });
    field.select();
    if (!doc.execCommand?.('copy')) throw new Error('Clipboard unavailable');
  } finally {
    field.remove();
    if (focused?.isConnected) focused.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      for (const range of ranges) if (range.startContainer.isConnected && range.endContainer.isConnected) selection.addRange(range);
    }
  }
}

export function CodeBlock({ code, language = "text" }: {
  code: string;
  language?: string;
}) {
  const [highlighted, setHighlighted] = useState<{ code: string; language: string; lines: CodeToken[][] } | null>(null);
  const [copy, setCopy] = useState<"idle" | "copied" | "error">("idle");
  const revision = useRef(0);
  useEffect(() => {
    revision.current++;
    setCopy("idle");
    return () => { revision.current++; };
  }, [code]);
  useEffect(() => {
    let cancelled = false;
    void highlightCode(code, language).then((lines) => {
      if (!cancelled) setHighlighted({ code, language, lines });
    }).catch(() => { /* Plain text stays visible if a grammar cannot load. */ });
    return () => { cancelled = true; };
  }, [code, language]);
  const lines = highlighted?.code === code && highlighted.language === language
    ? highlighted.lines : code.split(/\r\n|\r|\n/).map((content) => [{ content }] as CodeToken[]);
  const breaks = code.match(/\r\n|\r|\n/g) ?? [];
  const label = `${languageName(language)} code block`;
  return (
    <div className="sp-code-block" role="group" aria-label={label}>
      <div className="sp-code-header">
        <span className="sp-code-language">{languageName(language)}</span>
        <IconButton label={copy === "copied" ? "Copied" : "Copy"} size="sm" onClick={async event => {
          const version = revision.current;
          try {
            await copyCode(code, event.currentTarget);
            if (version === revision.current) setCopy("copied");
          } catch {
            if (version === revision.current) setCopy("error");
          }
        }}>
          {copy === "copied" ? <Check size={16} /> : <Copy size={16} />}
        </IconButton>
      </div>
      <div className="sp-code-scroll" role="region" aria-label={label} tabIndex={0}>
        <div className="sp-code-gutter" aria-hidden="true">{lines.map((_, index) => <span key={index}>{index + 1}</span>)}</div>
        <pre><code>{lines.map((line, index) => <Fragment key={index}>
          {line.map((token, tokenIndex) => <span key={tokenIndex} className={token.role ? `sp-code-token--${token.role}` : undefined}>{token.content}</span>)}
          {breaks[index] ?? ""}
        </Fragment>)}</code></pre>
      </div>
      {copy !== "idle" && (
        <span className={`sp-code-feedback ${copy === "error" ? "sp-field-error" : ""}`}
          role={copy === "error" ? "alert" : "status"}>
          {copy === "copied" ? "Copied" : "Could not copy. Select the code and copy it manually."}
        </span>
      )}
    </div>
  );
}
