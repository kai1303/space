import { useEffect, useState, type CSSProperties } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Avatar, Badge, Button, IconButton, SidePanel } from '@space/ui/primitives';
import { Message, useMessageArrivals } from '@space/ui/conversation';
import { RichComposer } from '@space/ui/composer';
import { RichContent, documentText, type Attachment, type RichDocument } from '@space/ui/rich-text';
import { WorkspaceSearch, WorkspaceSidebar, searchMessages, type SearchMessage, type SidebarChannel } from '@space/ui/navigation';
import { surfaceMotion, useSidebarMotion } from '@space/ui/motion';
import {
  ArrowLeft,
  BookOpen,
  ChatCircle,
  Hash,
  House,
  MagnifyingGlass,
  Moon,
  Palette,
  Star,
  Sun,
  X,
  List,
  File,
} from "@phosphor-icons/react";
import { TokenInspector } from "./examples/TokenInspector.js";
import { SpaceLogo } from "../shared/branding/SpaceLogo.js";
import "./workspace.css";

type WorkplaceMessage = SearchMessage & {
  initials: string;
  time: string;
  document?: RichDocument;
  attachments?: Attachment[];
  replies?: number;
};
const initialChannels: SidebarChannel[] = [
  { id: "announcements", name: "announcements", section: "starred" },
  { id: "general", name: "general", section: "channels" },
  { id: "design-system", name: "design-system", section: "channels" },
  { id: "engineering", name: "engineering", section: "channels", unread: 3 },
  {
    id: "team-private",
    name: "team-private",
    section: "channels",
    private: true,
  },
  { id: "alex-morgan", name: "Alex Morgan", section: "direct", online: true },
  { id: "jamie-chen", name: "Jamie Chen", section: "direct", online: true },
  { id: "sam-rivera", name: "Sam Rivera", section: "direct" },
  { id: "space-assistant", name: "Space assistant", section: "apps" },
];
const initialMessages: WorkplaceMessage[] = [
  {
    id: "m1",
    channel: "design-system",
    author: "Alex Morgan",
    initials: "AM",
    time: "10:42 AM",
    text: "A little consistency goes a long way. Here’s the first look at our shared design language. What do you think?",
    thread: true,
    replies: 2,
    document: {
      ops: [
        {
          insert: "A little consistency goes a long way.",
          attributes: { bold: true },
        },
        {
          insert:
            "\nHere’s the first look at our shared design language. What do you think?\n",
        },
      ],
    },
  },
  {
    id: "m2",
    channel: "design-system",
    author: "Jamie Chen",
    initials: "JC",
    time: "10:44 AM",
    text: "Feels like home already. Love the attention to the small details.",
  },
  {
    id: "m3",
    channel: "design-system",
    author: "You",
    initials: "YO",
    time: "10:46 AM",
    text: "The component guide is ready: https://example.com/design-system",
    document: {
      ops: [
        { insert: "The component guide is ready: " },
        {
          insert: "View the guidelines",
          attributes: { link: "https://example.com/design-system" },
        },
        { insert: "\n" },
      ],
    },
  },
  {
    id: "m4",
    channel: "design-system",
    author: "Space assistant",
    initials: "S",
    time: "10:48 AM",
    text: "Foundations are ready to explore. Colors, typography, and components are all in sync.",
  },
  {
    id: "m5",
    channel: "engineering",
    author: "Sam Rivera",
    initials: "SR",
    time: "9:34 AM",
    text: "The frontend build is passing. Let’s review keyboard navigation and search before the next demo.",
    thread: true,
    replies: 1,
  },
  {
    id: "m6",
    channel: "general",
    author: "Alex Morgan",
    initials: "AM",
    time: "9:00 AM",
    text: "Morning, team! A shared space for good work and the conversations that move it forward.",
  },
  {
    id: "m7",
    channel: "announcements",
    author: "Jamie Chen",
    initials: "JC",
    time: "Yesterday",
    text: "Welcome to Space studio. The first design-system preview is ready to explore.",
  },
  {
    id: "m8",
    channel: "alex-morgan",
    author: "Alex Morgan",
    initials: "AM",
    time: "10:20 AM",
    text: "Could you share the latest composer and sidebar updates here?",
  },
];
function storedTheme(): "light" | "dark" {
  try {
    return localStorage.getItem("space-theme") === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}
export function WorkspacePreview() {
  const reduced = useReducedMotion();
  const [theme, setTheme] = useState(storedTheme);
  const [channel, setChannel] = useState("design-system");
  const [messages, setMessages] = useState(initialMessages);
  const [width, setWidth] = useState(390);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const sidebar = useSidebarMotion<HTMLDivElement>(sidebarOpen, "(max-width: 760px)");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchSeed, setSearchSeed] = useState("");
  const [searchQuery, setSearchQuery] = useState<string | null>(null);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, RichDocument>>({});
  const [attachmentDrafts, setAttachmentDrafts] = useState<
    Record<string, Attachment[]>
  >({});
  const [view, setView] = useState<"channel" | "threads" | "drafts">("channel");
  const arrivals = useMessageArrivals(messages, view === "channel" ? channel : null);
  const [highlight, setHighlight] = useState("");
  const [starred, setStarred] = useState<string[]>(["announcements"]);
  const selected = initialChannels.find((c) => c.id === channel)!;
  const results =
    searchQuery !== null ? searchMessages(messages, searchQuery) : [];
  const draftIds = [
    ...new Set([...Object.keys(drafts), ...Object.keys(attachmentDrafts)]),
  ].filter(
    (id) =>
      documentText(drafts[id] ?? { ops: [] }).trim() ||
      attachmentDrafts[id]?.length,
  );
  useEffect(() => {
    document.title = "Space studio — Space";
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("space-theme", theme);
    } catch {}
  }, [theme]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchSeed("");
        setSearchOpen(true);
      }
      if (event.key === "Escape") setSidebarOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);
  useEffect(() => {
    if (highlight)
      requestAnimationFrame(() => {
        const node = document.getElementById(`message-${highlight}`);
        node?.scrollIntoView({ block: "center" });
        node?.focus({ preventScroll: true });
      });
  }, [highlight, channel, view]);
  function select(id: string) {
    setChannel(id);
    setView("channel");
    setSidebarOpen(false);
    setHighlight("");
  }
  function reveal(message: SearchMessage) {
    setChannel(message.channel);
    setView("channel");
    setHighlight(message.id);
    setSidebarOpen(false);
  }
  const channels = initialChannels.map((c) => ({
    ...c,
    section: starred.includes(c.id)
      ? ("starred" as const)
      : c.section === "starred"
        ? ("channels" as const)
        : c.section,
    unread: c.id === channel ? 0 : c.unread,
  }));
  return (
    <div
      className="workplace"
      style={{ "--workplace-sidebar-width": `${width}px` } as CSSProperties}
    >
      <header className="workplace-topbar">
        <div className="workplace-history">
          <a href="/design-system" aria-label="Back to design system">
            <ArrowLeft size={18} />
          </a>
          <span>Space studio</span>
        </div>
        <button
          type="button"
          className="workplace-global-search"
          onClick={() => {
            setSearchSeed("");
            setSearchOpen(true);
          }}
        >
          <MagnifyingGlass size={17} />
          <span>Search Space studio</span>
          <kbd>⌘ K</kbd>
        </button>
        <IconButton
          label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
        </IconButton>
      </header>
      <aside className="workplace-rail" aria-label="Workspace tools">
        <a
          className="workplace-brand"
          href="/design-system"
          aria-label="Space design system"
        >
          <SpaceLogo icon />
        </a>
        <button
          type="button"
          className="is-active"
          aria-label="Home"
          onClick={() => setView("channel")}
        >
          <House size={23} weight="fill" />
          <span>Home</span>
        </button>
        <button
          type="button"
          aria-label="Direct messages"
          onClick={() => select("alex-morgan")}
        >
          <ChatCircle size={23} />
          <span>DMs</span>
        </button>
        <button
          type="button"
          aria-label="Inspect color tokens"
          onClick={() => setTokenOpen(true)}
        >
          <Palette size={23} />
          <span>Colors</span>
        </button>
        <a
          href="/design-system"
          className="workplace-rail-docs"
          aria-label="Component documentation"
        >
          <BookOpen size={22} />
          <span>System</span>
        </a>
        <Avatar
          name="You"
          initials="YO"
          size="sm"
          presence="online"
          tone="blue"
        />
      </aside>
      <AnimatePresence>{sidebarOpen && (
        <motion.button {...surfaceMotion(reduced, "scrim")} key="sidebar-scrim"
          type="button"
          className="workplace-scrim"
          aria-label="Close conversations"
          onClick={() => setSidebarOpen(false)}
        />
      )}</AnimatePresence>
      <div
        ref={sidebar}
        className={`workplace-sidebar ${sidebarOpen ? "is-open" : ""}`}
      >
        <WorkspaceSidebar
          workspace="Space studio"
          channels={channels}
          selectedId={channel}
          onSelect={select}
          width={width}
          onWidthChange={setWidth}
          onThreads={() => {
            setView("threads");
            setSidebarOpen(false);
          }}
          onDrafts={() => {
            setView("drafts");
            setSidebarOpen(false);
          }}
        />
      </div>
      <main className="workplace-main">
        <header className="workplace-channel-header">
          <IconButton
            label="Toggle conversations"
            className="workplace-mobile-nav"
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >
            <List size={20} />
          </IconButton>
          <IconButton
            label={
              starred.includes(channel) ? "Unstar channel" : "Star channel"
            }
            aria-pressed={starred.includes(channel)}
            onClick={() =>
              setStarred((old) =>
                old.includes(channel)
                  ? old.filter((id) => id !== channel)
                  : [...old, channel],
              )
            }
          >
            <Star
              size={20}
              weight={starred.includes(channel) ? "fill" : "regular"}
            />
          </IconButton>
          <h1>
            {view === "channel" ? (
              <>
                {selected.section === "direct" ? (
                  <span className="workplace-online" />
                ) : (
                  <Hash size={21} />
                )}{" "}
                {selected.name}
              </>
            ) : view === "threads" ? (
              "Threads"
            ) : (
              "Drafts & sent"
            )}
          </h1>
          <div className="workplace-member-count">
            <Avatar name="Alex Morgan" initials="AM" size="sm" />
            <Avatar name="Jamie Chen" initials="JC" size="sm" tone="orange" />
            <span>8</span>
          </div>
          <IconButton
            label="Search in channel"
            onClick={() => {
              setSearchSeed(`in:${channel} `);
              setSearchOpen(true);
            }}
          >
            <MagnifyingGlass size={20} />
          </IconButton>
        </header>
        <div className="workplace-channel-tabs">
          <span>
            <ChatCircle size={15} />
            Messages
          </span>
          <span className="workplace-topic">
            {view === "channel"
              ? "A shared home for our shared language."
              : "Your conversations, in one place."}
          </span>
          <Badge tone="accent">LOCAL PREVIEW</Badge>
        </div>
        {view === "channel" ? (
          <>
            <div
              className="workplace-messages"
              aria-label={`Messages in ${selected.name}`}
            >
              <div className="workplace-date">
                <span>Tuesday, November 3</span>
              </div>
              {messages
                .filter((m) => m.channel === channel)
                .map((message) => (
                  <div
                    id={`message-${message.id}`}
                    key={message.id}
                    tabIndex={-1}
                    className={
                      highlight === message.id ? "workplace-highlight" : ""
                    }
                  >
                    <Message
                      arrival={arrivals.has(message.id)}
                      author={message.author}
                      initials={message.initials}
                      time={message.time}
                      agent={message.author === "Space assistant"}
                      tone={
                        message.author === "Jamie Chen"
                          ? "orange"
                          : message.author === "You"
                            ? "blue"
                            : message.author === "Space assistant"
                              ? "green"
                              : "purple"
                      }
                    >
                      {message.document ? (
                        <RichContent document={message.document} />
                      ) : (
                        message.text
                      )}
                      {message.attachments?.map((file) => (
                        <div className="workplace-file" key={file.id}>
                          <File size={24} />
                          <span>
                            {file.name}
                            <small>
                              {Math.max(1, Math.round(file.size / 1024))} KB ·
                              local attachment metadata
                            </small>
                          </span>
                        </div>
                      ))}
                    </Message>
                  </div>
                ))}
              {!messages.some((m) => m.channel === channel) && (
                <div className="workplace-welcome">
                  <Hash size={44} />
                  <h2>This is the start of #{selected.name}</h2>
                  <p>A little space to make something good.</p>
                </div>
              )}
            </div>
            <div className="workplace-composer">
              <RichComposer
                key={channel}
                channel={selected.name}
                defaultValue={drafts[channel]}
                defaultAttachments={attachmentDrafts[channel]}
                onAttachmentsChange={(attachments) =>
                  setAttachmentDrafts((old) => ({
                    ...old,
                    [channel]: attachments,
                  }))
                }
                onDraftChange={(document) =>
                  setDrafts((old) => ({ ...old, [channel]: document }))
                }
                mentions={[
                  "Alex Morgan",
                  "Jamie Chen",
                  "Sam Rivera",
                  "Space assistant",
                ]}
                onSend={(text, document, attachments) => {
                  const id = crypto.randomUUID();
                  setMessages((old) => [
                    ...old,
                    {
                      id,
                      channel,
                      author: "You",
                      initials: "YO",
                      time: "Just now",
                      text,
                      document,
                      links: document.ops.flatMap((op) =>
                        op.attributes?.link ? [op.attributes.link] : [],
                      ),
                      attachments,
                    },
                  ]);
                }}
              />
            </div>
          </>
        ) : (
          <div className="workplace-index">
            {view === "threads"
              ? messages
                  .filter((m) => m.thread)
                  .map((message) => (
                    <button key={message.id} onClick={() => reveal(message)}>
                      <Hash size={18} />
                      <div>
                        <strong>{message.channel}</strong>
                        <p>{message.text}</p>
                        <small>
                          {message.replies ?? 0} replies · {message.author}
                        </small>
                      </div>
                    </button>
                  ))
              : draftIds.map((id) => (
                  <button key={id} onClick={() => select(id)}>
                    <Hash size={18} />
                    <div>
                      <strong>
                        {initialChannels.find((c) => c.id === id)?.name}
                      </strong>
                      <p>
                        {documentText(drafts[id] ?? { ops: [] }) ||
                          `${attachmentDrafts[id]?.length ?? 0} local attachments`}
                      </p>
                      <small>Unsent draft</small>
                    </div>
                  </button>
                ))}
            {view === "drafts" && !draftIds.length && (
              <div className="workplace-welcome">
                <h2>No drafts yet</h2>
                <p>Unsent messages stay with their own conversation.</p>
              </div>
            )}
          </div>
        )}
      </main>
      <AnimatePresence>{searchQuery !== null && (
        <SidePanel key="search-results"
          className="workplace-results"
          aria-label="Search results"
        >
          <header>
            <div>
              <strong>Search results</strong>
              <p>{searchQuery || "All messages"}</p>
            </div>
            <IconButton
              label="Close search results"
              onClick={() => setSearchQuery(null)}
            >
              <X size={20} />
            </IconButton>
          </header>
          <div className="workplace-result-count" role="status">
            {results.length} {results.length === 1 ? "result" : "results"} ·
            local messages
          </div>
          {results.length ? (
            results.map((message) => (
              <button
                type="button"
                key={message.id}
                className="workplace-result"
                onClick={() => reveal(message)}
              >
                <span>
                  <Hash size={14} />
                  {message.channel}
                  <small>{message.time}</small>
                </span>
                <strong>{message.author}</strong>
                <p>{message.text || "Attachment"}</p>
              </button>
            ))
          ) : (
            <div className="workplace-search-empty">
              <MagnifyingGlass size={40} />
              <h2>Nothing turned up</h2>
              <p>
                Try a different keyword, check for typos, or adjust your
                filters.
              </p>
              <Button
                onClick={() => {
                  setSearchSeed(searchQuery ?? "");
                  setSearchOpen(true);
                }}
              >
                Edit search
              </Button>
            </div>
          )}
        </SidePanel>
      )}</AnimatePresence>
      <WorkspaceSearch
        initialQuery={searchSeed}
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        messages={messages}
        channel={channel}
        onSearch={(query) => setSearchQuery(query)}
        onSelect={reveal}
      />
      <TokenInspector
        open={tokenOpen}
        onClose={() => setTokenOpen(false)}
        theme={theme}
      />
    </div>
  );
}
