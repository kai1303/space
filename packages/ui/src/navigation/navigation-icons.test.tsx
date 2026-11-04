import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NavigationIcon, type NavigationIconName } from "./navigation-icons.js";

const names: NavigationIconName[] = [
  "spacebot", "home", "dms", "activity", "files", "todos", "agents", "admin",
  "threads", "huddles", "drafts", "saved", "directories", "star", "channels",
  "channel", "channel-search", "apps", "people", "external", "invitations",
  "search", "compose", "canvases", "deleted", "workflow", "plus", "chevron",
  "section-chevron", "history", "back", "forward", "close",
];

describe("NavigationIcon", () => {
  it.each(names)("renders %s as a decorative local vector", name => {
    const markup = renderToStaticMarkup(<NavigationIcon name={name} />);
    expect(markup).toContain('width="20" height="20"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('focusable="false"');
    expect(markup).toContain("<path");
    expect(markup).not.toMatch(/<image|<script|https?:\/\/(?!www.w3.org)/);
  });

  it.each(["home", "dms", "activity", "files", "todos", "agents", "people"] as const)(
    "uses the observed filled vector for selected %s", name => {
      expect(renderToStaticMarkup(<NavigationIcon name={name} active />))
        .not.toBe(renderToStaticMarkup(<NavigationIcon name={name} />));
    },
  );

  it("preserves sizing and classes", () => {
    const markup = renderToStaticMarkup(<NavigationIcon name="search" size={16} className="search-icon" />);
    expect(markup).toContain('width="16" height="16"');
    expect(markup).toContain('class="search-icon"');
  });

  it("uses isolated Grokbots masks and purple clay gradients for both bot states", () => {
    const markup = renderToStaticMarkup(<><NavigationIcon name="spacebot" active /><NavigationIcon name="spacebot" /></>);
    const ids = Array.from(markup.matchAll(/<mask id="([^"]+)"/g), match => match[1]);
    expect(ids).toHaveLength(2);expect(ids[0]).not.toBe(ids[1]);
    for(const id of ids)expect(markup).toContain(`mask="url(#${id})"`);
    expect(markup).toContain('stop-color="#8b5cf6"');expect(markup).not.toContain('#E01E59');
  });
});
