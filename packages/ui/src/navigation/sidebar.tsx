import { SessionTitle } from '../agents/streamed-words.js';
import { SidebarRowMenu, type SidebarAction } from "./sidebar-row-menu.js";
import { NavigationIcon } from "./navigation-icons.js";
import { useEffect, useId, useState, type ReactNode } from "react";
import { LayoutGroup, motion, stagger, useAnimate, useReducedMotion } from "motion/react";
import { motionTransition } from "../motion/motion.js";
import { Reveal } from "../motion/reveal.js";
import {
  CaretRight,
  Hash,
  Lock,
  MagnifyingGlass,
  Sparkle,
  Star,
  ChatCircle,
  Headset,
  SquaresFour,
  BookmarkSimple,
  AddressBook,
} from "@phosphor-icons/react";
import { Avatar, ChannelItem, IconButton } from "../primitives/primitives.js";
export type SidebarChannel = {
  id: string;
  name: string;
  section: "starred" | "channels" | "direct" | "sessions" | "apps";
  unread?: number;
  badgeCount?: number;
  private?: boolean;
  initials?: string;
  image?: string | null;
  agentName?: string;
  onDetails?: () => void;
  actions?: SidebarAction[];
  onSplit?: () => void;
  onRename?: () => void;
  online?: boolean;
  typing?: boolean;
};
export function DirectTypingIcon({ name, label = `${name} is typing`, size = 20 }: { name: string; label?: string; size?: number }) {
  const reduced = useReducedMotion();
  const [scope, animate] = useAnimate<SVGSVGElement>();
  useEffect(() => {
    if (reduced) return;
    const pulse = animate("circle", { opacity: [1, 0.2] }, {
      duration: 0.75, delay: stagger(0.15), repeat: Infinity, repeatDelay: 0.05, ease: "linear",
    });
    return () => pulse.cancel();
  }, [animate, reduced]);
  return <svg ref={scope} role="img" aria-label={label} viewBox="0 0 24 24" style={{width: size, height: size, flexShrink: 0}}>
    {[4, 12, 20].map(x => <circle key={x} cx={x} cy={12} r={3} fill="currentColor" opacity={0.8}/> )}
  </svg>;
}
type SidebarState = { query: string; expanded: Record<string, boolean> };
const initialSidebarState: SidebarState = { query: "", expanded: { starred: true, channels: true, direct: true, sessions: true, apps: true } };
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
  onHuddles,
  onDrafts,
  onSaved,
  onDirectories,
  selectedShortcut,
  workspaceControl,
  footer,
  sectionFooters,
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
  onHuddles?: () => void;
  onDrafts?: () => void;
  onSaved?: () => void;
  onDirectories?: () => void;
  selectedShortcut?: string;
  workspaceControl?: ReactNode;
  footer?: ReactNode;
  sectionFooters?: Partial<Record<SidebarChannel["section"], ReactNode>>;
  onCreateChannel?: () => void;
  showEmptySections?: boolean;
  loading?: boolean;
}) {
  const reduced = useReducedMotion();
  const transition = motionTransition(reduced);
  const layoutScope = useId();
  const moveTransition = { duration: reduced ? 0 : .22, ease: [.2, .8, .2, 1] as const };
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
            <NavigationIcon name="compose"/>
          </IconButton>
        )}
      </div>
      <div className="sp-sidebar-filter">
        <NavigationIcon name="search" size={15}/>
        <input
          type="search"
          aria-label="Find a conversation"
          placeholder="Find a conversation…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {(onThreads || onDrafts || onHuddles || onSaved || onDirectories) && (
        <nav className="sp-sidebar-utilities" aria-label="Home shortcuts">
          {([
            ['threads', 'Threads', 'threads', onThreads],
            ['huddles', 'Huddles', 'huddles', onHuddles],
            ['drafts', 'Drafts & sent', 'drafts', onDrafts],
            ['saved', 'Saved', 'saved', onSaved],
            ['directories', 'Directories', 'directories', onDirectories],
          ] as const).map(([key, label, icon, select]) => select && <button key={key} type="button" aria-current={selectedShortcut === key ? 'page' : undefined} onClick={select}><NavigationIcon name={icon} size={17}/>{label}</button>)}
        </nav>
      )}
      <LayoutGroup id={layoutScope}><nav
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
        {(["starred", "channels", "direct", "sessions", "apps"] as const).map((section) => {
          const items = channels.filter(
            (c) =>
              c.section === section &&
              c.name.toLowerCase().includes(query.toLowerCase()),
          );
          if (!items.length && (!showEmptySections || query)) return null;
          const isOpen = Boolean(query) || Boolean(expanded[section]);
          return (
            <motion.section
              key={section}
              className="sp-sidebar-section"
              layout={reduced ? false : "position"}
              transition={{ layout: moveTransition }}
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
                    transition={transition}>{section === "starred" ? <NavigationIcon name="star" size={16}/> : section === "channels" ? <NavigationIcon name="channels" size={16}/> : section === "direct" ? <NavigationIcon name="dms" size={16}/> : section === "sessions" ? <NavigationIcon name="agents" size={16}/> : <NavigationIcon name="apps" size={16}/>}</motion.span>
                  <motion.span className="sp-sidebar-section-caret"
                    variants={{ rest: { opacity: 0, scale: reduced ? 1 : 0.8, rotate: isOpen ? 90 : 0 }, active: { opacity: 1, scale: 1, rotate: isOpen ? 90 : 0 } }}
                    transition={transition}><NavigationIcon name="section-chevron" size={14}/></motion.span>
                </span>
                <span>
                  {
                    {
                      starred: "Starred",
                      channels: "Channels",
                      direct: "Direct messages",
                      sessions: "Agent sessions",
                      apps: "Apps",
                    }[section]
                  }
                </span>
              </motion.button>
              <Reveal open={isOpen} clip={false}>
                {items.map(c => {
                  const actions = [...(c.actions ?? [])];
                  if (c.onDetails) actions.push({ label: "Channel details", select: c.onDetails, divider: actions.length > 0 });
                  if (c.onRename) actions.push({ label: "Rename…", select: c.onRename });
                  const item = <ChannelItem
                    name={c.name}
                    nameContent={c.agentName || c.section==='sessions' ? <SessionTitle title={c.name}/> : undefined}
                    hasMenu={actions.length > 0}
                    selected={c.id === selectedId}
                    unread={c.unread}
                    badgeCount={c.badgeCount}
                    onClick={event => { if (c.onSplit && (event.metaKey || event.ctrlKey) && event.altKey) c.onSplit(); else onSelect(c.id); }}
                    icon={
                      c.typing && c.id !== selectedId ? (
                        <DirectTypingIcon name={c.name} label={c.agentName ? `${c.agentName} is working` : undefined} size={c.section === "starred" && !c.agentName ? 16 : 20}/>
                      ) : c.agentName ? (
                        <span className="sp-sidebar-avatar" aria-hidden="true"><Avatar name={c.agentName} initials={c.agentName.slice(0,2).toUpperCase()} image={c.image} size="sm" tone="green"/></span>
                      ) : c.section === "direct" ? (
                        <span className="sp-sidebar-avatar" aria-hidden="true"><Avatar name={c.name} initials={c.initials ?? c.name.slice(0, 2).toUpperCase()} image={c.image} size="sm" presence={c.online ? 'online' : 'offline'}/></span>
                      ) : (c.section === "apps" || c.section === "sessions") ? (
                        <NavigationIcon name="agents" size={16}/>
                      ) : c.section === "starred" ? (
                        <NavigationIcon name="star" size={16}/>
                      ) : c.private ? (
                        <Lock size={15} />
                      ) : (
                        <NavigationIcon name="channel" size={17}/>
                      )
                    }
                  />;
                  return <motion.div key={c.id} initial={false} layout={reduced ? false : "position"}
                    layoutId={reduced ? undefined : `conversation:${workspaceId}:${c.id}`} transition={{ layout: moveTransition }}>
                    {actions.length ? <SidebarRowMenu name={c.name} actions={actions}>{item}</SidebarRowMenu> : item}
                  </motion.div>;
                })}
                {sectionFooters?.[section]}
                {section === "channels" && onCreateChannel && <button className="sp-sidebar-section-toggle sp-sidebar-create" type="button" onClick={onCreateChannel}><NavigationIcon name="plus" size={17}/> Add channel</button>}
              </Reveal>
            </motion.section>
          );
        })}
      </nav></LayoutGroup>
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
