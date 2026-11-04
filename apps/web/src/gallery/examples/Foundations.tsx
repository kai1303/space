import { useState } from "react";
import {
  ArrowUpRight,
  Bell,
  ChatCircle,
  Check,
  Code,
  Hash,
  House,
  MagnifyingGlass,
  Plus,
  Sparkle,
  Star,
  Users,
  X,
} from "@phosphor-icons/react";

const colors = [
  { name: "Aubergine", token: "--sp-accent", usage: "Brand & selection" },
  { name: "Canvas", token: "--sp-surface", usage: "Primary surfaces" },
  { name: "Ink", token: "--sp-text", usage: "Content & headings" },
  { name: "Ocean", token: "--sp-info", usage: "Links & information" },
  { name: "Evergreen", token: "--sp-success", usage: "Actions & presence" },
  { name: "Amber", token: "--sp-warning", usage: "Attention & approval" },
];
const symbols = [
  { icon: House, name: "Home" },
  { icon: ChatCircle, name: "Messages" },
  { icon: Hash, name: "Channel" },
  { icon: Users, name: "People" },
  { icon: Bell, name: "Activity" },
  { icon: MagnifyingGlass, name: "Search" },
  { icon: Sparkle, name: "Agent" },
  { icon: Star, name: "Saved" },
  { icon: Plus, name: "Add" },
  { icon: Check, name: "Confirm" },
  { icon: X, name: "Close" },
  { icon: ArrowUpRight, name: "Open" },
];

export function Foundations() {
  const [copied, setCopied] = useState("");
  async function copy(token: string) {
    try {
      await navigator.clipboard.writeText(`var(${token})`);
      setCopied(token);
    } catch {
      setCopied("unavailable");
    }
  }
  return (
    <section id="foundations" className="ds-section">
      <SectionHeading
        number="01"
        title="Foundations"
        description="The quiet details that make everything feel connected."
      />
      <div className="ds-section-label" id="colors">
        <h3>Color with a purpose</h3>
        <span>Semantic tokens · Light & dark</span>
      </div>
      <div className="color-grid">
        {colors.map((color) => (
          <button
            type="button"
            key={color.token}
            className="color-swatch"
            onClick={() => void copy(color.token)}
            aria-label={`Copy ${color.name} token`}
          >
            <span
              className="color-chip"
              style={{ background: `var(${color.token})` }}
            >
              <span>
                {copied === color.token ? (
                  <Check size={16} />
                ) : (
                  <Code size={16} />
                )}
              </span>
            </span>
            <strong>{color.name}</strong>
            <span>{color.usage}</span>
            <code>{color.token.replace("--sp-", "")}</code>
          </button>
        ))}
      </div>
      <p className="ds-token-note" role="status">
        {copied === "unavailable"
          ? "Clipboard unavailable. Token names are listed on each swatch."
          : copied
            ? `Copied var(${copied})`
            : "Click a swatch to copy its CSS token. Try the theme switch to see semantic colors adapt."}
      </p>
      <div className="foundation-grid">
        <div className="ds-card type-card" id="typography">
          <div className="ds-card-heading">
            <h3>Typography</h3>
            <span>Lato</span>
          </div>
          <div className="type-hero">
            Aa
            <span>
              Human.
              <br />
              Clear. Familiar.
            </span>
          </div>
          <div className="type-row">
            <span className="type-heading">A place for good work.</span>
            <code>22 / 26 · 900</code>
          </div>
          <div className="type-row">
            <span>Every conversation starts here.</span>
            <code>15 / 22 · 400</code>
          </div>
          <div className="type-row">
            <span className="type-caption">The details bring it together.</span>
            <code>13 / 18 · 400</code>
          </div>
        </div>
        <div className="ds-card spacing-card" id="spacing">
          <div className="ds-card-heading">
            <h3>Space & shape</h3>
            <span>A 4px rhythm</span>
          </div>
          <div className="spacing-bars">
            {[4, 8, 12, 16, 24, 32].map((space) => (
              <div key={space}>
                <span style={{ height: space * 2 }} />
                <code>{space}</code>
              </div>
            ))}
          </div>
          <div className="radius-list">
            {[4, 6, 8, 12].map((radius) => (
              <div key={radius}>
                <span style={{ borderRadius: radius }} />
                <code>{radius}px</code>
              </div>
            ))}
          </div>
          <p className="ds-muted">
            Compact by default. Room to breathe where it matters.
          </p>
        </div>
      </div>
      <div className="icon-card ds-card" id="icons">
        <div>
          <h3>One consistent icon family</h3>
          <p>Phosphor · Regular weight · 20px grid</p>
        </div>
        <div className="icon-grid">
          {symbols.map(({ icon: Icon, name }) => (
            <span key={name} title={name}>
              <Icon size={20} aria-label={name} />
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
export function SectionHeading({
  number,
  title,
  description,
}: {
  number: string;
  title: string;
  description: string;
}) {
  return (
    <div className="ds-section-heading">
      <span className="ds-section-number">{number}</span>
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
    </div>
  );
}
