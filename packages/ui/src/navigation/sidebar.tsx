import { SessionTitle } from '../agents/streamed-words.js';
import { SidebarRowMenu, type SidebarAction } from "./sidebar-row-menu.js";
import { NavigationIcon } from "./navigation-icons.js";
import { useEffect, useId, useState, type ReactNode } from "react";
import { AnimatePresence, LayoutGroup, motion, stagger, useAnimate, useReducedMotion } from "motion/react";
import { motionTransition } from "../motion/motion.js";
import { Reveal, RevealContent } from "../motion/reveal.js";
import { DotsThree, FolderSimple, Lock } from "@phosphor-icons/react";
import { Avatar, ChannelItem, IconButton, Menu } from "../primitives/primitives.js";
export type SidebarChannel = {
  id: string;
  name: string;
  section: "starred" | "channels" | "direct" | "sessions" | "apps";
  customSectionId?: string;
  defaultSection?: 'channels' | 'direct';
  onMoveToSection?: (id: string | null) => void | Promise<void>;
  unread?: number;
  badgeCount?: number;
  private?: boolean;
  initials?: string;
  image?: string | null;
  agentName?: string;
  statusIcon?: ReactNode;
  onDetails?: () => void;
  actions?: SidebarAction[];
  onSplit?: () => void;
  onMove?: (target: string, side: 'before' | 'after') => void | Promise<void>;
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
export type SidebarCustomSection = { id: string; name: string; emoji?: string; collapsed: boolean };
const builtinNames = { starred: 'Starred', channels: 'Channels', direct: 'Direct messages', sessions: 'Agent sessions', apps: 'Apps' };
const builtinIcons = { starred: 'star', channels: 'channels', direct: 'dms', sessions: 'agents', apps: 'apps' } as const;
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
  sessionBatchSize,
  onCreateChannel,
  customSections = [],
  onCreateSection,
  onRenameSection,
  onDeleteSection,
  onToggleSection,
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
  sessionBatchSize?: number;
  sectionFooters?: Partial<Record<SidebarChannel["section"], ReactNode>>;
  onCreateChannel?: () => void;
  customSections?: SidebarCustomSection[];
  onCreateSection?: (rowId?: string) => void;
  onRenameSection?: (id: string) => void;
  onDeleteSection?: (id: string) => void;
  onToggleSection?: (id: string, collapsed: boolean) => void;
  showEmptySections?: boolean;
  loading?: boolean;
}) {
  const reduced = useReducedMotion();
  const transition = motionTransition(reduced);
  const layoutScope = useId();
  const [drag, setDrag] = useState<{
    source:string; workspace:string; height:number; target:string; side:'before'|'after'; saving:boolean; sectionTarget?: string;
  }>();
  const moving = drag?.workspace === workspaceId ? channels.find(row => row.id === drag.source) : undefined;
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
  const knownSections = new Set(customSections.map(group => group.id));
  const groups = new Map<string, SidebarChannel[]>();
  const filter = query.toLowerCase();
  for (const row of channels) {
    if (!row.name.toLowerCase().includes(filter)) continue;
    const key = row.customSectionId && knownSections.has(row.customSectionId) ? `custom:${row.customSectionId}` : row.section;
    const rows = groups.get(key);
    if (rows) rows.push(row);
    else groups.set(key, [row]);
  }
  const sectionOrder: (SidebarChannel['section'] | SidebarCustomSection)[] = ['starred', ...customSections, 'channels', 'direct', 'sessions', 'apps'];
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
        {sectionOrder.map(group => {
          const section = typeof group === 'string' ? group : undefined;
          const custom = typeof group === 'object' ? group : undefined;
          const key = typeof group === 'string' ? group : `custom:${group.id}`;
          const name = typeof group === 'string' ? builtinNames[group] : group.name;
          const items = groups.get(key) ?? [];
          const acceptsMove = Boolean(moving?.onMoveToSection && !drag?.saving && (custom
            ? moving.customSectionId !== custom.id
            : moving.customSectionId && moving.section === section));
          const showHeading = !query && (custom || showEmptySections || (section === 'channels' && onCreateSection));
          if (!items.length && !showHeading && !acceptsMove && !(section === 'sessions' && sectionFooters?.sessions)) return null;
          const isOpen = Boolean(query) || (custom ? !custom.collapsed : Boolean(expanded[key]));
          const sourceIndex = moving?.onMove ? items.indexOf(moving) : -1;
          const targetIndex = drag && sourceIndex >= 0 ? items.findIndex(row => row.id === drag.target) : -1;
          const preview = sourceIndex >= 0 && targetIndex >= 0 && drag;
          // Hit areas stay in their original slots. Only the visual rows shift,
          // so an animated neighbor cannot keep crossing a stationary pointer.
          const destination = preview ? targetIndex + Number(preview.side === 'after') - Number(sourceIndex < targetIndex) : -1;
          function renderRow(c: SidebarChannel, index: number) {
            const actions = [...(c.actions ?? [])];
            if (c.onDetails) actions.push({ label: "Channel details", select: c.onDetails, divider: actions.length > 0 });
            if (c.onRename) actions.push({ label: "Rename…", select: c.onRename });
            if (c.onMoveToSection && c.defaultSection) {
              const move = c.onMoveToSection;
              const currentSection = c.customSectionId && knownSections.has(c.customSectionId) ? c.customSectionId : null;
              actions.push({ label: 'Move to section', items: () => {
                const destinations: SidebarAction[] = [
                  { key: 'default', label: builtinNames[c.section], checked: !currentSection, select: () => { if (currentSection) void move(null); } },
                  ...customSections.map(group => ({ key: `custom:${group.id}`, label: group.name, checked: currentSection === group.id,
                    select: () => { if (currentSection !== group.id) void move(group.id); } })),
                ];
                if (onCreateSection) destinations.push({ key: 'create', label: 'Create section…', divider: true, select: () => onCreateSection(c.id) });
                return destinations;
              } });
            }
            const iconSection = custom ? c.defaultSection ?? c.section : c.section;
            const item = <ChannelItem
              name={c.name}
              nameContent={c.agentName || c.section==='sessions' ? <SessionTitle title={c.name}/> : undefined}
              hasMenu={actions.length > 0}
              selected={c.id === selectedId}
              unread={c.unread}
              badgeCount={c.badgeCount}
              onClick={event => { if (c.onSplit && (event.metaKey || event.ctrlKey) && event.altKey) c.onSplit(); else onSelect(c.id); }}
              icon={
                c.statusIcon ? c.statusIcon : c.agentName ? (
                  <span className="sp-sidebar-avatar" aria-hidden={!c.typing} role={c.typing ? 'img' : undefined}
                    aria-label={c.typing ? `${c.agentName} is working` : undefined}>
                    <Avatar name={c.agentName} initials={c.agentName.slice(0,2).toUpperCase()} image={c.image} size="sm" tone="green"/>
                    {c.typing && <motion.span aria-hidden="true" className="sp-sidebar-working-dot"
                      animate={{opacity: reduced ? 1 : [1, 0.5, 1]}}
                      transition={reduced ? {duration:0} : {duration:1.4, repeat:Infinity, ease:'easeInOut'}}/>}
                  </span>
                ) : c.typing && c.id !== selectedId ? (
                  <DirectTypingIcon name={c.name} size={iconSection === "starred" ? 16 : 20}/>
                ) : iconSection === "direct" ? (
                  <span className="sp-sidebar-avatar" aria-hidden="true"><Avatar name={c.name} initials={c.initials ?? c.name.slice(0, 2).toUpperCase()} image={c.image} size="sm" presence={c.online ? 'online' : 'offline'}/></span>
                ) : (c.section === "apps" || c.section === "sessions") ? (
                  <NavigationIcon name="agents" size={16}/>
                ) : iconSection === "starred" ? (
                  <NavigationIcon name="star" size={16}/>
                ) : c.private ? (
                  <Lock size={15} />
                ) : (
                  <NavigationIcon name="channel" size={17}/>
                )
              }
            />;
            const content = actions.length ? <SidebarRowMenu name={c.name} actions={actions}>{item}</SidebarRowMenu> : item;
            let offset = 0;
            if (preview && preview.source !== preview.target) {
              if (index === sourceIndex) offset = destination - sourceIndex;
              else if (index > sourceIndex && index <= destination) offset = -1;
              else if (index < sourceIndex && index >= destination) offset = 1;
            }
            return <motion.div key={c.id} initial={false} layout={!reduced && !preview && "position"}
              layoutId={reduced || preview ? undefined : `conversation:${workspaceId}:${c.id}`} transition={{ layout: moveTransition }}>
              {c.onMove || c.onMoveToSection ? <div draggable={!drag?.saving}
                onDragStart={event => {
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain',c.name);
                  setDrag({source:c.id,workspace:workspaceId,height:event.currentTarget.getBoundingClientRect().height,
                    target:c.id,side:'before',saving:false});
                }}
                onDragOver={event => {
                  if (!c.onMove || !preview || preview.saving) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                  const rect = event.currentTarget.getBoundingClientRect();
                  const side = event.clientY < rect.top + rect.height/2 ? 'before' : 'after';
                  if (c.id !== preview.target || side !== preview.side) setDrag({...preview,target:c.id,side});
                }}
                onDrop={async event => {
                  if (!c.onMove || !preview || preview.saving || !moving?.onMove) return;
                  event.preventDefault();
                  const rect = event.currentTarget.getBoundingClientRect();
                  const side = event.clientY < rect.top + rect.height/2 ? 'before' : 'after';
                  const end = index + Number(side === 'after') - Number(sourceIndex < index);
                  if (c.id === moving.id || end === sourceIndex) { setDrag(undefined); return; }
                  const saving = {...preview,target:c.id,side,saving:true} as const;
                  setDrag(saving);
                  try { await moving.onMove(c.id,side); }
                  finally { setDrag(current => current === saving ? undefined : current); }
                }}
                onDragEnd={() => setDrag(current => current?.saving ? current : undefined)}>
                <motion.div initial={false} animate={{y:preview ? offset*preview.height : 0,opacity:preview && index === sourceIndex && !preview.saving ? 0.35 : 1}}
                  transition={motionTransition(reduced || !preview || (preview.saving && sourceIndex === destination),0.16)} style={{pointerEvents:preview ? 'none' : undefined}}>
                  {content}
                </motion.div>
              </div> : content}
            </motion.div>;
          }
          return (
            <motion.section
              key={key}
              className="sp-sidebar-section"
              aria-label={name}
              data-drop-target={acceptsMove && drag?.sectionTarget === key || undefined}
              onDragOver={event => {
                if (!acceptsMove || !drag) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                if (drag.sectionTarget !== key) setDrag({ ...drag, sectionTarget: key });
              }}
              onDragLeave={event => {
                if (drag?.sectionTarget === key && !(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)))
                  setDrag({ ...drag, sectionTarget: undefined });
              }}
              onDrop={event => {
                if (!acceptsMove || !moving?.onMoveToSection) return;
                event.preventDefault();
                setDrag(undefined);
                void moving.onMoveToSection(custom?.id ?? null);
              }}
              layout={reduced ? false : "position"}
              transition={{ layout: moveTransition }}
            >
              <div className="sp-sidebar-section-heading">
                <motion.button
                  type="button"
                  className="sp-sidebar-section-toggle"
                  initial={false}
                  animate={isOpen ? "rest" : "active"}
                  whileHover="active"
                  whileFocus="active"
                  aria-expanded={isOpen}
                  onClick={() => {
                    if (query) return;
                    if (custom) onToggleSection?.(custom.id, !custom.collapsed);
                    else setExpanded(prev => ({ ...prev, [key]: !prev[key] }));
                  }}
                >
                  <span className="sp-sidebar-section-symbol" aria-hidden="true">
                    <motion.span className="sp-sidebar-section-kind"
                      variants={{ rest: { opacity: 1, scale: 1 }, active: { opacity: 0, scale: reduced ? 1 : 0.8 } }}
                      transition={transition}>{section ? <NavigationIcon name={builtinIcons[section]} size={16}/> : custom?.emoji ?? <FolderSimple size={16}/>}</motion.span>
                    <motion.span className="sp-sidebar-section-caret"
                      variants={{ rest: { opacity: 0, scale: reduced ? 1 : 0.8, rotate: isOpen ? 90 : 0 }, active: { opacity: 1, scale: 1, rotate: isOpen ? 90 : 0 } }}
                      transition={transition}><NavigationIcon name="section-chevron" size={14}/></motion.span>
                  </span>
                  <span className="sp-sidebar-section-name">{name}</span>
                </motion.button>
                {section === 'channels' && onCreateSection && <Menu label="Manage Channels" floating
                  className="sp-sidebar-section-menu" trigger={<DotsThree size={18} weight="bold"/>}
                  items={[{ label: 'Create section', onSelect: () => onCreateSection() }]}/>}
                {custom && (onRenameSection || onDeleteSection) && <Menu label={`Manage ${custom.name}`} floating
                  className="sp-sidebar-section-menu" trigger={<DotsThree size={18} weight="bold"/>}
                  items={[
                    ...(onRenameSection ? [{ label: 'Rename section…', onSelect: () => onRenameSection(custom.id) }] : []),
                    ...(onDeleteSection ? [{ label: 'Delete section…', onSelect: () => onDeleteSection(custom.id), danger: true }] : []),
                  ]}/>}
              </div>
              <Reveal open={isOpen} clip={false}>
                {section === 'sessions' && sessionBatchSize && !query ? <>
                  {items.slice(0,sessionBatchSize).map(renderRow)}
                  <AnimatePresence initial={false}>
                    {Array.from({length:Math.ceil(items.length/sessionBatchSize)-1},(_,index) => {
                      const start = (index+1)*sessionBatchSize;
                      return <RevealContent key={start} clip={!preview}>
                        {items.slice(start,start+sessionBatchSize).map((row,index) => renderRow(row,start+index))}
                      </RevealContent>;
                    })}
                  </AnimatePresence>
                </> : items.map(renderRow)}
                {section && sectionFooters?.[section]}
                {section === "channels" && onCreateChannel && <button className="sp-sidebar-section-toggle sp-sidebar-create" type="button" onClick={onCreateChannel}><NavigationIcon name="plus" size={17}/> Add channel</button>}
              </Reveal>
            </motion.section>
          );
        })}
      </nav></LayoutGroup>
      {onCreateChannel && !onCreateSection && !showEmptySections && !groups.has('channels') && !query && !(moving?.customSectionId && moving.section === 'channels') && <button className="sp-sidebar-section-toggle sp-sidebar-create" type="button" onClick={onCreateChannel}>＋ Add channel</button>}
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
