import { sql } from 'drizzle-orm';
import { SessionConflict } from './session-concurrency.js';
import type { DbSession } from './database.js';
import { isMessagePath, parseConversationPath, MAX_MEMORY_BYTES, MAX_MEMORY_CHARS } from '@space/contracts';

export const sections = (content: string) => [...content.matchAll(/^<!-- space-memory-source:((?:message|document|knowledge):[a-f0-9-]{36}) -->\n([\s\S]*?)^<!-- \/space-memory-source -->\n?/gm)];
export const quote = (text: string) => text.split(/\r\n|[\r\n\u2028\u2029]/).map(line => '> ' + line).join('\n');
const messageSourceText = (text: string, attachments: { name: string }[]) =>
  [text, ...attachments.map(asset => `Attachment: ${asset.name} (file content not imported)`)].filter(Boolean).join('\n');

const uuidPattern = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/;
type Evidence = { messages: Map<string, string>; parents: string[] };
type LiveMessage = { id: string; revision: string; text: string; attachments: { name: string }[] };

function evidence(id: string, body: string, channel: string): Evidence {
  const messages = new Map<string, string>(), parents: string[] = [];
  if (id.startsWith('message:')) messages.set(id.slice(8), '');
  if (id.startsWith('knowledge:')) {
    // Older claims list their sources in the generated Evidence footer. An unversioned
    // citation can only be proven current while its message is still at revision one.
    const footer = body.split('\n> Evidence:\n').at(-1);
    if (footer && footer !== body) for (const line of footer.split('\n')) {
      if (!line.startsWith('> - ')) continue;
      const parent = /\[((?:message|knowledge):[a-f0-9-]{36})\](?:: |$)/.exec(line)?.[1];
      if (parent?.startsWith('message:')) messages.set(parent.slice(8), '1');
      if (parent?.startsWith('knowledge:')) { parents.push(parent); continue; }
      const url = /: (\/\S+)$/.exec(line)?.[1];
      if (url && isMessagePath(url)) {
        const ref = parseConversationPath(url);
        if (ref.channel === channel && ref.message) messages.set(ref.message, '1');
      } else if (url?.startsWith('/chat?')) {
        const ref = new URLSearchParams(url.slice(6)).get('message');
        if (ref && uuidPattern.test(ref)) messages.set(ref, '1');
      }
    }
    // The writer records the versions it actually observed, including after an edit.
    for (const match of body.matchAll(/^<!-- Evidence revision: ([a-f0-9-]{36}) (\d+) -->$/gm)) messages.set(match[1]!, match[2]!);
  }
  return { messages, parents };
}

export async function currentMemoryContent(c: DbSession, raw: string, channel: string) {
  const parts = sections(raw);
  if (!parts.length) return raw;
  const refs = new Map(parts.map(part => [part[1]!, evidence(part[1]!, part[2]!, channel)]));
  const ids = [...new Set([...refs.values()].flatMap(ref => [...ref.messages.keys()]))].filter(id => uuidPattern.test(id));
  const quotes = parts.filter(part => part[1]!.startsWith('message:'));
  const quoteIds = quotes.map(part => part[1]!.slice(8)).filter(id => uuidPattern.test(id));
  const rows = ids.length ? (await c.execute<LiveMessage>(sql`SELECT id, search_revision::text AS revision,
    CASE WHEN id=ANY(${sql.param(quoteIds)}::uuid[]) AND search_revision>1 THEN text END AS text,
    CASE WHEN id=ANY(${sql.param(quoteIds)}::uuid[]) AND search_revision>1 THEN attachments END AS attachments
    FROM messages WHERE channel_id=${channel} AND id=ANY(${sql.param(ids)}::uuid[])
      AND agent_session_id IS NULL AND deleted_at IS NULL AND retained_at IS NULL`)).rows : [];
  const live = new Map(rows.map(m => [m.id, m]));
  const invalid = new Set<string>();
  const dependents = new Map<string, string[]>();
  for (const [id, ref] of refs) {
    if ([...ref.messages].some(([key, version]) => !live.has(key) || (version && live.get(key)!.revision !== version))) invalid.add(id);
    for (const parent of ref.parents) {
      if (!refs.has(parent)) invalid.add(id);
      const children = dependents.get(parent) ?? [];
      children.push(id);
      dependents.set(parent, children);
    }
  }
  for (const id of invalid) for (const child of dependents.get(id) ?? []) invalid.add(child);

  let offset = 0, length = raw.length, bytes = Buffer.byteLength(raw);
  const output: string[] = [];
  for (const part of parts) {
    const id = part[1]!;
    let block = part[0];
    if (invalid.has(id)) block = '';
    else if (id.startsWith('message:')) {
      const m = live.get(id.slice(8))!;
      const savedRevision = /^<!-- Message revision: (\d+) -->$/m.exec(part[2]!)?.[1] ?? '1';
      if (m.revision !== savedRevision) {
        const header = /^### [^\n]*\n(?:Source: [^\n]*\n)?/.exec(part[2]!)?.[0] ?? '';
        block = `<!-- space-memory-source:${id} -->\n${header}<!-- Message revision: ${m.revision} -->\n${quote(messageSourceText(m.text, m.attachments))}\n<!-- /space-memory-source -->\n`;
        // A source can grow after being saved into a nearly full document.
        if (length + block.length - part[0].length > MAX_MEMORY_CHARS || bytes + Buffer.byteLength(block) - Buffer.byteLength(part[0]) > MAX_MEMORY_BYTES)
          block = `<!-- space-memory-source:${id} -->\n${header}<!-- /space-memory-source -->\n`;
      }
    }
    output.push(raw.slice(offset, part.index), block);
    length += block.length - part[0].length;
    bytes += Buffer.byteLength(block) - Buffer.byteLength(part[0]);
    offset = part.index! + part[0].length;
  }
  return output.join('') + raw.slice(offset);
}

// Normal chat edits and retention also remove stale managed content from storage.
// Recompute against the winning content if an independent memory edit commits first.
export async function syncSavedMemory(c: DbSession, channel: string) {
  const row = (await c.execute<{content: string}>(sql`SELECT content FROM channel_memory_documents WHERE channel_id=${channel}`)).rows[0];
  if (!row) return;
  const content = await currentMemoryContent(c, row.content, channel);
  if (content === row.content) return;
  const changed = await c.execute(sql`UPDATE channel_memory_documents SET content=${content}
    WHERE channel_id=${channel} AND content=${row.content}`);
  if (!changed.rowCount) throw new SessionConflict();
}
