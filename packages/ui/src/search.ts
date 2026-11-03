export type SearchMessage = {
  id: string;
  channel: string;
  author: string;
  text: string;
  thread?: boolean;
  links?: readonly string[];
};
export type SearchQuery = {
  terms: string[];
  channel?: string;
  from?: string;
  hasLink: boolean;
  threadsOnly: boolean;
  error?: string;
};
export function parseSearch(query: string): SearchQuery {
  const result: SearchQuery = { terms: [], hasLink: false, threadsOnly: false };
  if (query.length > 500)
    return { ...result, error: "Keep the search under 500 characters." };
  if ((query.match(/"/g)?.length ?? 0) % 2)
    return { ...result, error: "Close the quoted phrase to search." };
  for (const token of query.match(/(?:[^\s"]|"[^"]*")+/g) ?? []) {
    const colon = token.indexOf(":");
    if (colon > 0 && !/^https?:\/\//i.test(token)) {
      const key = token.slice(0, colon).toLowerCase(),
        value = token
          .slice(colon + 1)
          .replace(/^"|"$/g, "")
          .toLowerCase();
      if (!value) return { ...result, error: `Add a value after ${key}:.` };
      if (key === "in") result.channel = value.replace(/^#/, "");
      else if (key === "from") result.from = value.replace(/^@/, "");
      else if (key === "has" && value === "link") result.hasLink = true;
      else if (key === "is" && value === "thread") result.threadsOnly = true;
      else
        return {
          ...result,
          error: `Unsupported filter: ${key}:${value}. Use in:, from:, has:link, or is:thread.`,
        };
    } else result.terms.push(token.replace(/^"|"$/g, "").toLowerCase());
  }
  return result;
}
export function toggleSearchFilter(query: string, token: string): string {
  const parts: string[] = query.match(/(?:[^\s"]|"[^"]*")+/g) ?? [];
  const key = token.slice(0, token.indexOf(":") + 1);
  const active = parts.includes(token);
  const kept = parts.filter((part) => !part.startsWith(key));
  return [...kept, ...(active ? [] : [token])].join(" ");
}
export function searchMessages<T extends SearchMessage>(
  messages: readonly T[],
  query: string,
  currentUser = "You",
): T[] {
  const parsed = parseSearch(query);
  if (parsed.error) return [];
  return messages.filter((message) => {
    const searchable = `${message.text} ${(message.links ?? []).join(" ")}`;
    return (
      (!parsed.channel || message.channel.toLowerCase() === parsed.channel) &&
      (!parsed.from ||
        message.author.toLowerCase() ===
          (parsed.from === "me" ? currentUser.toLowerCase() : parsed.from)) &&
      (!parsed.hasLink || /https?:\/\/|mailto:/i.test(searchable)) &&
      (!parsed.threadsOnly || message.thread) &&
      parsed.terms.every((term) => searchable.toLowerCase().includes(term))
    );
  });
}
