import { useEffect, useId, useRef, useState } from "react";
import {
  ArrowBendDownLeft,
  Clock,
  Hash,
  MagnifyingGlass,
  Sliders,
  X,
} from "@phosphor-icons/react";
import { Dialog, IconButton } from "./primitives.js";
import {
  parseSearch,
  searchMessages,
  toggleSearchFilter,
  type SearchMessage,
} from "./search.js";
export function WorkspaceSearch({
  open,
  onClose,
  messages,
  channel,
  currentUser = "You",
  onSearch,
  onSelect,
  initialQuery = "",
  scope,
}: {
  open: boolean;
  onClose: () => void;
  messages: SearchMessage[];
  channel: string;
  currentUser?: string;
  initialQuery?: string;
  scope?: string;
  onSearch: (query: string) => void;
  onSelect: (message: SearchMessage) => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [filters, setFilters] = useState(true);
  const [recent, setRecent] = useState<string[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const parsed = parseSearch(query);
  const results =
    query.trim() && !parsed.error
      ? searchMessages(messages, query, currentUser).slice(0, 6)
      : [];
  useEffect(() => {
    if (open) {
      setQuery(initialQuery);
      setActive(0);
      requestAnimationFrame(() => input.current?.focus());
    }
  }, [open, initialQuery]);
  function search(value = query) {
    if (!value.trim() || parseSearch(value).error) return;
    setRecent((old) => [value, ...old.filter((q) => q !== value)].slice(0, 5));
    onSearch(value);
    onClose();
  }
  function filter(token: string) {
    setQuery((prev) => toggleSearchFilter(prev, token));
    setActive(0);
    input.current?.focus();
  }
  return (
    <Dialog open={open} onClose={onClose} title="Search Space" description={scope}>
      <div className="sp-workspace-search">
        <div className="sp-search-input">
          <MagnifyingGlass size={22} />
          <input
            ref={input}
            role="combobox"
            aria-label="Search messages"
            aria-autocomplete="list"
            aria-expanded={open && Boolean(query.trim()) && !parsed.error}
            aria-controls={query.trim() && !parsed.error ? listId : undefined}
            aria-activedescendant={
              query.trim() && !parsed.error ? `${listId}-${active}` : undefined
            }
            maxLength={500}
            placeholder={scope ? "Search loaded messages" : "Search messages, people, and channels"}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setActive(
                  (old) =>
                    (old +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      results.length +
                      1) %
                    (results.length + 1),
                );
              }
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (active > 0 && results[active - 1]) {
                  onSelect(results[active - 1]!);
                  onClose();
                } else search();
              }
            }}
          />
          {query && (
            <IconButton
              label="Clear search"
              size="sm"
              onClick={() => {
                setQuery("");
                setActive(0);
                input.current?.focus();
              }}
            >
              <X size={16} />
            </IconButton>
          )}
          <IconButton
            label={filters ? "Hide search filters" : "Show search filters"}
            size="sm"
            aria-pressed={filters}
            onClick={() => setFilters(!filters)}
          >
            <Sliders size={18} />
          </IconButton>
        </div>
        {filters && (
          <div
            className="sp-search-filters"
            role="group"
            aria-label="Quick filters"
          >
            {[
              { label: "In this channel", token: `in:${channel}` },
              { label: "From me", token: "from:me" },
              { label: "Has a link", token: "has:link" },
              { label: "Threads only", token: "is:thread" },
            ].map((item) => (
              <button
                type="button"
                key={item.token}
                aria-pressed={(query.match(/(?:[^\s"]|"[^"]*")+/g) ?? []).some(
                  (part) => part === item.token,
                )}
                onClick={() => filter(item.token)}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}
        {parsed.error ? (
          <p className="sp-search-error" role="alert">
            {parsed.error}
          </p>
        ) : query.trim() ? (
          <div role="listbox" id={listId} aria-label="Search suggestions">
            <div
              role="option"
              id={`${listId}-0`}
              aria-selected={active === 0}
              className={`sp-search-option ${active === 0 ? "is-active" : ""}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => search()}
            >
              <MagnifyingGlass size={18} />
              <span>
                Show all results for <strong>{query}</strong>
              </span>
              <ArrowBendDownLeft size={16} />
            </div>
            {results.map((message, index) => (
              <div
                key={message.id}
                id={`${listId}-${index + 1}`}
                role="option"
                aria-selected={active === index + 1}
                className={`sp-search-option ${active === index + 1 ? "is-active" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(index + 1)}
                onClick={() => {
                  onSelect(message);
                  onClose();
                }}
              >
                <Hash size={18} />
                <div>
                  <strong>
                    {message.channel}
                    <small>{message.author}</small>
                  </strong>
                  <p>{message.text.slice(0, 100)}</p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="sp-search-recents" id={listId}>
            <span>RECENT SEARCHES</span>
            {recent.length ? (
              recent.map((q) => (
                <button
                  type="button"
                  key={q}
                  onClick={() => {
                    setQuery(q);
                    setActive(0);
                  }}
                >
                  <Clock size={16} />
                  {q}
                </button>
              ))
            ) : (
              <p>
                Find the conversation you're looking for.
                <br />
                Try <code>in:design-system</code> or <code>from:me</code>.
              </p>
            )}
          </div>
        )}
        <div className="sp-search-footer">
          <span>↑ ↓ to select</span>
          <span>↵ to open · Esc to close</span>
        </div>
      </div>
    </Dialog>
  );
}
