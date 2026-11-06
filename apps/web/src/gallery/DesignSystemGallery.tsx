import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from "react";
import { Avatar, Badge, Button } from '@space/ui/primitives';
import { surfaceMotion, useSidebarMotion } from '@space/ui/motion';
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  ChatCircle,
  Check,
  Code,
  Command,
  Cube,
  DiamondsFour,
  House,
  List,
  MagnifyingGlass,
  Moon,
  Sparkle,
  Sun,
  Swatches,
  TextAa,
  X,
} from "@phosphor-icons/react";
import { Foundations, SectionHeading } from "./examples/Foundations.js";
import { Components } from "./examples/Components.js";
import { Conversation } from "./examples/Conversation.js";
import { WorkComponents } from "./examples/WorkComponents.js";
import { SpaceLogo } from "../shared/branding/SpaceLogo.js";

const groups: {
  title: string;
  links: { id: string; label: string; icon?: typeof House }[];
}[] = [
  {
    title: "GETTING STARTED",
    links: [
      { id: "overview", label: "Overview", icon: House },
      { id: "principles", label: "Principles", icon: DiamondsFour },
    ],
  },
  {
    title: "FOUNDATIONS",
    links: [
      { id: "colors", label: "Color", icon: Swatches },
      { id: "typography", label: "Typography", icon: TextAa },
      { id: "spacing", label: "Space & shape", icon: Cube },
      { id: "icons", label: "Iconography", icon: Sparkle },
    ],
  },
  {
    title: "COMPONENTS",
    links: [
      { id: "buttons", label: "Buttons" },
      { id: "inputs", label: "Inputs & selection" },
      { id: "avatars", label: "Avatars & presence" },
      { id: "badges", label: "Status & feedback" },
      { id: "navigation", label: "Navigation" },
      { id: "overlays", label: "Menus & dialogs" },
      { id: "message-motion", label: "Message arrivals" },
      { id: "message-actions", label: "Message actions" },
    ],
  },
  {
    title: "WORK & AGENTS",
    links: [
      { id: "ticket-card", label: "Ticket" },
      { id: "alerts", label: "Alert" },
      { id: "code-block", label: "Code block" },
      { id: "tool-execution", label: "Agent communication" },
      { id: "agent-approval", label: "Agent approval" },
      { id: "agent-workspace", label: "Agent workspace" },
      { id: "agent-response", label: "Rich agent response" },
    ],
  },
  {
    title: "PATTERNS",
    links: [
      { id: "patterns", label: "Conversations", icon: ChatCircle },
      { id: "chat-composer", label: "Chat composer" },
      { id: "guidelines", label: "Usage & accessibility", icon: BookOpen },
    ],
  },
];
function initialTheme(): "light" | "dark" {
  try {
    return localStorage.getItem("space-theme") === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}
export function DesignSystemGallery() {
  useEffect(() => { document.title = "Space — Design system"; }, []);
  const [theme, setTheme] = useState(initialTheme);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState("overview");
  const [mobileNav, setMobileNav] = useState(false);
  const sidebar = useSidebarMotion<HTMLElement>(mobileNav, "(max-width: 760px)");
  const reduced = useReducedMotion();
  const [notice, setNotice] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("space-theme", theme);
    } catch {}
  }, [theme]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        input.current?.focus();
      }
      if (event.key === "Escape") {
        setQuery("");
        setMobileNav(false);
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  function navigate(id: string) {
    setActive(id);
    setQuery("");
    setMobileNav(false);
    document.getElementById(id)?.scrollIntoView({
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
      block: "start",
    });
    history.replaceState(null, "", `#${id}`);
  }
  useEffect(() => {
    const id = location.hash.slice(1);
    if (id) {
      requestAnimationFrame(() =>
        document.getElementById(id)?.scrollIntoView(),
      );
      setActive(id);
    }
  }, []);
  const filtered = groups
    .map((group) => ({
      ...group,
      links: group.links.filter((link) =>
        `${group.title} ${link.label}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      ),
    }))
    .filter((group) => group.links.length);
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <a
          className="wordmark"
          href="#overview"
          onClick={(event) => {
            event.preventDefault();
            navigate("overview");
          }}
        >
          <SpaceLogo inverse />
          <span className="wordmark-divider" />
          <span>Design system</span>
        </a>
        <div className="global-search">
          <MagnifyingGlass size={16} />
          <input
            ref={input}
            aria-label="Search design system"
            placeholder="Find a component…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setMobileNav(true);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && filtered[0]?.links[0])
                navigate(filtered[0].links[0].id);
            }}
          />
          <kbd>
            <Command size={11} /> K
          </kbd>
        </div>
        <div className="topbar-end">
          <span className="topbar-status">
            <span />
            v0.1.0
          </span>
          <button
            className="theme-toggle"
            type="button"
            aria-label={`Switch to ${theme === "light" ? "dark" : "light"} theme`}
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
          >
            {theme === "light" ? <Moon size={18} /> : <Sun size={18} />}
          </button>
          <button
            className="mobile-toggle"
            type="button"
            aria-label="Toggle navigation"
            aria-expanded={mobileNav}
            aria-controls="docs-sidebar"
            onClick={() => setMobileNav(!mobileNav)}
          >
            {mobileNav ? <X size={20} /> : <List size={20} />}
          </button>
        </div>
      </header>
      <aside className="app-rail" aria-label="System shortcuts">
        <a
          className="rail-logo"
          href="#overview"
          aria-label="Space overview"
          onClick={(event) => {
            event.preventDefault();
            navigate("overview");
          }}
        >
          <SpaceLogo icon />
        </a>
        <button
          className="rail-item rail-item--active"
          aria-label="Design system overview"
          onClick={() => navigate("overview")}
        >
          <Swatches size={23} />
          <span>System</span>
        </button>
        <button
          className="rail-item"
          aria-label="Browse components"
          onClick={() => navigate("components")}
        >
          <Cube size={23} />
          <span>Build</span>
        </button>
        <button
          className="rail-item"
          aria-label="Conversation pattern"
          onClick={() => navigate("patterns")}
        >
          <ChatCircle size={23} />
          <span>Preview</span>
        </button>
        <div className="rail-bottom">
          <button
            className="rail-help"
            aria-label="Usage guidelines"
            onClick={() => navigate("guidelines")}
          >
            <BookOpen size={20} />
          </button>
          <Avatar name="Space studio" initials="S" size="sm" />
        </div>
      </aside>
      <AnimatePresence>{mobileNav && (
        <motion.button {...surfaceMotion(reduced, "scrim")} key="sidebar-scrim"
          className="sidebar-scrim"
          aria-label="Close navigation"
          onClick={() => setMobileNav(false)}
        />
      )}</AnimatePresence>
      <aside
        ref={sidebar}
        id="docs-sidebar"
        className={`docs-sidebar ${mobileNav ? "is-open" : ""}`}
      >
        <div className="sidebar-title">
          <div>
            <strong>Space UI</strong>
            <Badge tone="accent">FOUNDATION</Badge>
          </div>
          <span>Our shared design language.</span>
        </div>
        <nav aria-label="Design system sections">
          {filtered.length ? (
            filtered.map((group) => (
              <div className="sidebar-group" key={group.title}>
                <h2>{group.title}</h2>
                {group.links.map((link) => (
                  <a
                    key={link.id}
                    href={`#${link.id}`}
                    aria-current={active === link.id ? "location" : undefined}
                    onClick={(event) => {
                      event.preventDefault();
                      navigate(link.id);
                    }}
                  >
                    {"icon" in link && link.icon ? (
                      <link.icon size={16} />
                    ) : (
                      <span className="sidebar-dot" />
                    )}
                    {link.label}
                    {link.id === "overview" && (
                      <span className="sidebar-new">Start here</span>
                    )}
                  </a>
                ))}
              </div>
            ))
          ) : (
            <p className="search-empty">No sections match “{query}”.</p>
          )}
        </nav>
        <div className="sidebar-foot">
          <span className="live-dot" />
          <div>
            <strong>Made to work together.</strong>
            <span>Humans + agents. One space.</span>
          </div>
        </div>
      </aside>
      <main id="main" className="docs-main">
        <div className="docs-breadcrumb">
          <span>Space UI</span>
          <span>/</span>
          <span>Design system</span>
          <Badge tone="success" dot>
            In development
          </Badge>
        </div>
        <div className="docs-content">
          <section id="overview" className="overview">
            <div className="hero-eyebrow">
              <span />A FOUNDATION FOR WHAT'S NEXT
            </div>
            <div className="hero">
              <div>
                <h1>
                  A shared language.
                  <br />
                  <span>A familiar space.</span>
                </h1>
                <p>
                  The building blocks for a workplace that brings people
                  <br className="desktop-break" /> and agents together. Familiar
                  by design. Space to make it yours.
                </p>
                <div className="hero-actions">
                  <Button
                    variant="primary"
                    onClick={() => navigate("components")}
                  >
                    Explore components
                    <ArrowRight size={16} />
                  </Button>
                  <a
                    className="text-link"
                    href="/workspace"
                    style={{ textDecoration: "none" }}
                  >
                    Open workspace preview
                    <ArrowUpRight size={15} />
                  </a>
                </div>
              </div>
              <div className="hero-art" aria-hidden="true">
                <div className="art-grid">
                  <div className="art-type">
                    Aa<span>LATO / 15</span>
                  </div>
                  <div className="art-color">
                    <span />
                    <span />
                    <span />
                    <span />
                  </div>
                  <div className="art-chat">
                    <div>
                      <span />
                      <i />
                      <i />
                    </div>
                    <div>
                      <span />
                      <i />
                    </div>
                  </div>
                  <div className="art-action">
                    <span>
                      <Check size={20} weight="bold" />
                    </span>
                    <i />
                    <span className="art-cursor">
                      <ArrowUpRight size={32} />
                    </span>
                  </div>
                </div>
                <span className="art-caption">
                  THOUGHTFUL PARTS. SHARED POSSIBILITIES.
                </span>
              </div>
            </div>
            <div className="overview-links">
              {[
                {
                  number: "01",
                  title: "Foundations",
                  subtitle: "Start with the essentials",
                  id: "foundations",
                },
                {
                  number: "02",
                  title: "Components",
                  subtitle: "Build with familiar pieces",
                  id: "components",
                },
                {
                  number: "03",
                  title: "Patterns",
                  subtitle: "Bring it all together",
                  id: "patterns",
                },
              ].map((item) => (
                <button key={item.id} onClick={() => navigate(item.id)}>
                  <span>{item.number}</span>
                  <div>
                    <strong>{item.title}</strong>
                    <small>{item.subtitle}</small>
                  </div>
                  <ArrowUpRight size={17} />
                </button>
              ))}
            </div>
          </section>
          <section id="principles" className="principles">
            <span className="principles-label">OUR PRINCIPLES</span>
            <div>
              <strong>Familiar, with intention.</strong>
              <p>Use patterns people already understand.</p>
            </div>
            <div>
              <strong>Clear at every step.</strong>
              <p>Show what’s happening and what comes next.</p>
            </div>
            <div>
              <strong>Built for everyone.</strong>
              <p>Make keyboard, contrast, and feedback count.</p>
            </div>
          </section>
          <Foundations />
          <Components notify={setNotice} />
          <Conversation />
          <WorkComponents />
          <section id="guidelines" className="ds-section">
            <SectionHeading
              number="05"
              title="Start building"
              description="One source of truth. From the first button to the next conversation."
            />
            <div className="guidelines-grid">
              <div className="code-card">
                <div>
                  <span>
                    <Code size={16} />
                    Use the shared components
                  </span>
                  <Badge>React + TypeScript</Badge>
                </div>
                <pre>
                  <code>{`import { Button, Composer } from '@space/ui';\nimport '@space/ui/styles.css';\n\n<Button variant="primary">Create channel</Button>\n\n<Composer\n  channel="general"\n  onSend={message => sendMessage(message)}\n/>`}</code>
                </pre>
              </div>
              <div className="guidelines-card">
                <h3>Good defaults are for everyone.</h3>
                <p>
                  <Check size={15} />
                  Keyboard navigation and shortcuts
                </p>
                <p>
                  <Check size={15} />
                  Labels, status text, and honest errors
                </p>
                <p>
                  <Check size={15} />
                  Light, dark, and reduced motion
                </p>
                <p>
                  <Check size={15} />
                  Locally bundled fonts and icons
                </p>
                <span>Use semantic tokens. Let the system do the rest.</span>
              </div>
            </div>
          </section>
          <footer className="docs-footer">
            <div>
              <SpaceLogo />
              <span>A little consistency goes a long way.</span>
            </div>
            <span>Design system · v0.1.0</span>
          </footer>
        </div>
      </main>
      <div role="status" className={`toast ${notice ? "toast--visible" : ""}`}>
        {notice && (
          <>
            <Check size={17} />
            {notice}
          </>
        )}
      </div>
    </>
  );
}
