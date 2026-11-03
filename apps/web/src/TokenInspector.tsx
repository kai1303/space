import { useState } from "react";
import { Dialog, IconButton, TextField } from "@space/ui";
import { Check, Copy, DownloadSimple } from "@phosphor-icons/react";
import tokens from "@space/ui/tokens.json";

export function TokenInspector({
  open,
  onClose,
  theme,
}: {
  open: boolean;
  onClose: () => void;
  theme: "light" | "dark";
}) {
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState("");
  const values = tokens[theme];
  const entries = Object.entries(values).filter(([name, value]) =>
    `${name} ${value}`.includes(query.toLowerCase()),
  );
  async function copy(name: string) {
    try {
      await navigator.clipboard.writeText(`var(${name})`);
      setCopied(name);
    } catch {
      setCopied("Clipboard unavailable. Select the token name to copy it.");
    }
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Color tokenizer"
      description="Semantic colors resolved from the same CSS tokens used by this workspace."
    >
      <div className="token-inspector">
        <div className="token-inspector-toolbar">
          <span>
            {theme === "dark" ? "Dark" : "Light"} theme ·{" "}
            {Object.keys(values).length} tokens
          </span>
          <a
            className="sp-button sp-button--secondary sp-button--sm"
            download={`space-colors-${theme}.json`}
            href={`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(values, null, 2))}`}
          >
            <DownloadSimple size={14} />
            Export JSON
          </a>
        </div>
        <TextField
          label="Find a color token"
          placeholder="Try editor, sidebar, or #222529"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="token-table-wrap">
          <table>
            <caption className="sr-only">Resolved {theme} color tokens</caption>
            <thead>
              <tr>
                <th>Token</th>
                <th>Value</th>
                <th>
                  <span className="sr-only">Copy</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map(([name, value]) => (
                <tr key={name}>
                  <td>
                    <span
                      className="token-preview"
                      style={{ background: value }}
                    />
                    <code>{name}</code>
                  </td>
                  <td>
                    <code>{value.toUpperCase()}</code>
                  </td>
                  <td>
                    <IconButton
                      label={`Copy ${name}`}
                      size="sm"
                      onClick={() => void copy(name)}
                    >
                      {copied === name ? (
                        <Check size={15} />
                      ) : (
                        <Copy size={15} />
                      )}
                    </IconButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!entries.length && (
            <p className="token-empty">No tokens match this search.</p>
          )}
        </div>
        <p className="token-note">
          Palette → semantic role → component context. Theme values are authored
          for Space; source observations are recorded separately.
        </p>
        <p role="status" className="token-copy-status">
          {copied.startsWith("--") ? `Copied var(${copied})` : copied}
        </p>
      </div>
    </Dialog>
  );
}
