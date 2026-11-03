import { useState, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { motionTransition } from "./motion.js";
import { Reveal } from "./reveal.js";
import {
  CaretRight,
  Hash,
  Lock,
  MagnifyingGlass,
  Sparkle,
  Star,
  ChatCircle,
  PencilSimple,
  Headset,
  SquaresFour,
} from "@phosphor-icons/react";
import { Avatar, ChannelItem, IconButton } from "./primitives.js";
export type SidebarChannel = {
  id: string;
  name: string;
  section: "starred" | "channels" | "direct" | "apps";
  unread?: number;
  private?: boolean;
  initials?: string;
  online?: boolean;
};
type SidebarState = { query: string; expanded: Record<string, boolean> };
const initialSidebarState: SidebarState = { query: "", expanded: { starred: true, channels: true, direct: true, apps: true } };
export function WorkspaceSidebar({
  workspace,
  workspaceId = workspace,
  channels,
  selectedId,
  onSelect,
  width,
  onWidthChange,
  onNewMessage,
  onThreads,
  onDrafts,
  workspaceControl,
  footer,
  onCreateChannel,
  showEmptySections = false,
  loading = false,
}: {
  workspace: string;
  workspaceId?: string;
  channels: SidebarChannel[];
  selectedId: string;
  onSelect: (id: string) => void;
  width: number;
  onWidthChange: (width: number) => void;
  onNewMessage?: () => void;
  onThreads?: () => void;
  onDrafts?: () => void;
  workspaceControl?: ReactNode;
  footer?: ReactNode;
  onCreateChannel?: () => void;
  showEmptySections?: boolean;
  loading?: boolean;
}) {
  const reduced = useReducedMotion();
  const transition = motionTransition(reduced);
  const [states, setStates] = useState(() => new Map<string, SidebarState>());
  const { query, expanded } = states.get(workspaceId) ?? initialSidebarState;
  function setQuery(query: string) {
    setStates(previous => new Map(previous).set(workspaceId, { ...(previous.get(workspaceId) ?? initialSidebarState), query }));
  }
  function setExpanded(change: (expanded: Record<string, boolean>) => Record<string, boolean>) {
    setStates(previous => {
      const state = previous.get(workspaceId) ?? initialSidebarState;
      return new Map(previous).set(workspaceId, { ...state, expanded: change(state.expanded) });
    });
  }
  function resize(value: number) {
    onWidthChange(Math.max(180, Math.min(450, Math.round(value))));
  }
  return (
    <aside className="sp-workspace-sidebar">
      <div className="sp-workspace-heading">
        {workspaceControl ?? <strong>{workspace}</strong>}
        {onNewMessage && (
          <IconButton label="New message" className="sp-sidebar-compose" size="sm" onClick={onNewMessage}>
            <PencilSimple size={20} />
          </IconButton>
        )}
      </div>
      <div className="sp-sidebar-filter">
        <MagnifyingGlass size={15} />
        <input
          type="search"
          aria-label="Find a conversation"
          placeholder="Find a conversation…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {(onThreads || onDrafts) && (
        <div className="sp-sidebar-utilities">
          {onThreads && (
            <button type="button" onClick={onThreads}>
              <ChatCircle size={17} />
              Threads
            </button>
          )}
          {onDrafts && (
            <button type="button" onClick={onDrafts}>
              <PencilSimple size={17} />
              Drafts & sent
            </button>
          )}
        </div>
      )}
      <nav
        aria-label="Workspace conversations"
        onKeyDown={(event) => {
          if (
            !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) ||
            !(event.target as Element).closest(".sp-channel")
          )
            return;
          const items = [
            ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
              ".sp-channel",
            ),
          ].filter(item => !item.closest('[inert]'));
          const index = items.indexOf(event.target as HTMLButtonElement);
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? items.length - 1
                : (index +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    items.length) %
                  items.length;
          event.preventDefault();
          items[next]?.focus();
        }}
      >
        {(["starred", "channels", "direct", "apps"] as const).map((section) => {
          const items = channels.filter(
            (c) =>
              c.section === section &&
              c.name.toLowerCase().includes(query.toLowerCase()),
          );
          if (!items.length && (!showEmptySections || query)) return null;
          const isOpen = Boolean(query) || Boolean(expanded[section]);
          return (
            <section
              key={section}
              className="sp-sidebar-section"
            >
              <motion.button
                type="button"
                className="sp-sidebar-section-toggle"
                initial={false}
                animate={isOpen ? "rest" : "active"}
                whileHover="active"
                whileFocus="active"
                aria-expanded={isOpen}
                onClick={() =>
                  setExpanded((prev) => ({
                    ...prev,
                    [section]: !prev[section],
                  }))
                }
              >
                <span className="sp-sidebar-section-symbol" aria-hidden="true">
                  <motion.span className="sp-sidebar-section-kind"
                    variants={{ rest: { opacity: 1, scale: 1 }, active: { opacity: 0, scale: reduced ? 1 : 0.8 } }}
                    transition={transition}>{section === "starred" ? <Star size={16} /> : section === "channels" ? <Hash size={16} /> : section === "direct" ? <Headset size={16} /> : <SquaresFour size={16} />}</motion.span>
                  <motion.span className="sp-sidebar-section-caret"
                    variants={{ rest: { opacity: 0, scale: reduced ? 1 : 0.8, rotate: isOpen ? 90 : 0 }, active: { opacity: 1, scale: 1, rotate: isOpen ? 90 : 0 } }}
                    transition={transition}><CaretRight size={14} /></motion.span>
                </span>
                <span>
                  {
                    {
                      starred: "Starred",
                      channels: "Channels",
                      direct: "Direct messages",
                      apps: "Apps",
                    }[section]
                  }
                </span>
              </motion.button>
              <Reveal open={isOpen}>
                {items.map((c) => (
                  <ChannelItem
                    key={c.id}
                    name={c.name}
                    selected={c.id === selectedId}
                    unread={c.unread}
                    onClick={() => onSelect(c.id)}
                    icon={
                      c.section === "direct" ? (
                        <span
                          className={`sp-sidebar-presence ${c.online ? "is-online" : ""}`}
                        />
                      ) : c.section === "apps" ? (
                        <Sparkle size={16} />
                      ) : c.section === "starred" ? (
                        <Star size={16} />
                      ) : c.private ? (
                        <Lock size={15} />
                      ) : (
                        <Hash size={17} />
                      )
                    }
                  />
                ))}
                {section === "channels" && onCreateChannel && <button className="sp-sidebar-section-toggle sp-sidebar-create" type="button" onClick={onCreateChannel}><span aria-hidden="true">＋</span> Add channel</button>}
              </Reveal>
            </section>
          );
        })}
        {!loading && !channels.some((c) =>
          c.name.toLowerCase().includes(query.toLowerCase()),
        ) && (
          <p className="sp-sidebar-empty" role="status">
            No conversations found.
          </p>
        )}
      </nav>
      {onCreateChannel && !showEmptySections && !channels.some(c => c.section === "channels") && <button className="sp-sidebar-section-toggle sp-sidebar-create" type="button" onClick={onCreateChannel}>＋ Add channel</button>}
      {footer ?? <div className="sp-sidebar-profile">
        <Avatar
          name="You"
          initials="YO"
          size="sm"
          tone="blue"
          presence="online"
        />
        <span>
          <strong>You</strong>
          <small>Active</small>
        </span>
        <span className="sp-sidebar-demo">LOCAL DEMO</span>
      </div>}
      <div
        className="sp-sidebar-resizer"
        role="separator"
        aria-label="Sidebar width"
        aria-orientation="vertical"
        aria-valuemin={180}
        aria-valuemax={450}
        aria-valuenow={width}
        tabIndex={0}
        onKeyDown={(event) => {
          const value =
            event.key === "Home"
              ? 180
              : event.key === "End"
                ? 450
                : event.key === "ArrowLeft"
                  ? width - 10
                  : event.key === "ArrowRight"
                    ? width + 10
                    : null;
          if (value !== null) {
            event.preventDefault();
            resize(value);
          }
        }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            resize(
              event.clientX -
                event.currentTarget.parentElement!.getBoundingClientRect().left,
            );
        }}
        onPointerUp={(event) =>
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
      />
    </aside>
  );
}
