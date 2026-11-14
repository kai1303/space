import { createContext, isValidElement, useContext, useState, type ReactNode } from 'react';
import { StreamedWords } from './streamed-words.js';
import { fadeStreamedWords, useStreamingText } from './streaming-text.js';
import Markdown, { type Components, type ExtraProps } from 'react-markdown';
import type { Element, ElementContent, Root } from 'hast';
import remarkGfm from 'remark-gfm';
import type { AgentResponse as Response, AgentText, AgentTool, AgentComponent, CarouselBlock, DocumentEditBlock } from '@space/contracts';
import { isEmojiOnlyText, parseAgentComponent, isChannelPath, parseAssetPagePath, isAssetDownloadPath, isMessagePath, parseConversationPath, parseWorkspaceProfileLink } from '@space/contracts';
import { CodeBlock } from '../rich-text/code-block.js';
import { AgentDataTable } from './AgentDataTable.js';
import { AgentCarousel } from './AgentCarousel.js';
import { FileToolDetails } from './FileToolDetails.js';
import { Alert, ToolExecution } from './work-items.js';
import { safeLink } from '../rich-text/rich-text.js';

declare module 'hast' {
  interface ElementData { spaceCarousel?: CarouselBlock }
}

export const AgentProfileLinkContext = createContext<{
  workspace: string;
  viewer: string;
  open: (target: { kind: 'user' | 'agent'; id: string }) => void;
} | null>(null);
export const AgentMessageLinkContext = createContext<((item: { channel_id: string; message_id: string }, link: HTMLAnchorElement) => void) | null>(null);

function inlineText(nodes: ElementContent[]): string {
  return nodes.map(node => node.type === 'text' ? node.value : node.type === 'element' ? inlineText(node.children) : '').join('');
}

function AgentLink({ href, children, node }: ExtraProps & { href?: string; children?: ReactNode }) {
  const profiles = useContext(AgentProfileLinkContext);
  const openMessage = useContext(AgentMessageLinkContext);
  if (!href) return <span>{children}</span>;
  if (isMessagePath(href)) return <a href={href} onClick={event => {
    if (!openMessage || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const { channel, message } = parseConversationPath(href);
    if (!message) return;
    event.preventDefault();
    openMessage({ channel_id: channel, message_id: message }, event.currentTarget);
  }}>{children}</a>;
  if (isAssetDownloadPath(href)) return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
  if (isChannelPath(href)) {
    const tag = inlineText(node?.children ?? []).trim().startsWith('#');
    return <a href={href} className={tag ? 'sp-mention-token' : undefined} data-mention-kind={tag ? 'channel' : undefined}>{children}</a>;
  }
  const target = parseWorkspaceProfileLink(href);
  if (!target) return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
  const label = inlineText(node?.children ?? []).trim();
  const mention = label.endsWith(' · Space profile') ? '@' + label.slice(0, -' · Space profile'.length) : label.startsWith('@') ? label : undefined;
  const self = profiles?.viewer === target.id && target.kind === 'user';
  return <a href={href} className={mention ? `sp-mention-token${self ? ' is-self' : ''}` : undefined}
    data-mention-kind={mention ? target.kind : undefined} onClick={event => {
    if (profiles?.workspace !== target.workspace || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    profiles.open({ kind: target.kind, id: target.id });
  }}>{mention ?? children}</a>;
}

function carouselFromQuote(quote: Element) {
  const elements = quote.children.filter(child => child.type === 'element');
  const [heading, list] = elements;
  if (elements.length !== 2 || heading?.tagName !== 'p' || list?.tagName !== 'ul') return;
  const match = /^\[!CAROUSEL\][ \t]+([^\n]+)$/.exec(inlineText(heading.children));
  if (!match) return;
  const entries = list.children.filter(child => child.type === 'element');
  if (entries.length > 10 || !entries.length) return;
  const cards = [];
  for (const entry of entries) {
    const [label, ...description] = entry.children;
    if (entry.tagName !== 'li' || label?.type !== 'element' || label.tagName !== 'strong') return;
    cards.push({ id: String(cards.length + 1), title: inlineText(label.children), body: inlineText(description).trim() });
  }
  try {
    const block = parseAgentComponent({ id: 'markdown', type: 'carousel', title: match[1], cards });
    if (block.type === 'carousel') return block;
  } catch { /* Incomplete or invalid callouts remain readable Markdown. */ }
}

// Only a marker at the beginning of a parsed quote is an alert. Fenced examples stay literal.
function markAgentQuotes() {
  return (root: Root) => {
    for (const quote of root.children) {
      if (quote.type !== 'element' || quote.tagName !== 'blockquote') continue;
      const carousel = carouselFromQuote(quote);
      if (carousel) {
        quote.data = { spaceCarousel: carousel };
        continue;
      }
      const paragraph = quote.children.find(node => node.type === 'element');
      if (paragraph?.tagName !== 'p') continue;
      const first = paragraph.children[0];
      if (first?.type !== 'text') continue;
      const marker = /^\[!(WARNING|ERROR)\][ \t]*(?:\r?\n|$)/.exec(first.value);
      if (!marker) continue;
      quote.properties.dataSpaceAlert = marker[1] === 'WARNING' ? 'warning' : 'error';
      first.value = first.value.slice(marker[0].length);
      if (!first.value && paragraph.children.length === 1) quote.children.splice(quote.children.indexOf(paragraph), 1);
    }
  };
}

function MessageAlert({ level, title, children }: { level: 'warning' | 'error'; title?: string; children?: ReactNode }) {
  const severity = level === 'warning' ? 'Warning' : 'Error';
  return <Alert tone={level === 'warning' ? 'warning' : 'danger'} title={title ? severity + ' · ' + title : severity}>{children}</Alert>;
}

const markdownComponents: Components = {
  blockquote: ({node, children}) => {
    const carousel = node?.data?.spaceCarousel;
    if (carousel) return <AgentCarousel title={carousel.title} cards={carousel.cards} />;
    const level = node?.properties.dataSpaceAlert;
    return level === 'warning' || level === 'error' ? <MessageAlert level={level}>{children}</MessageAlert> : <blockquote>{children}</blockquote>;
  },
  span: ({ children, node }) => typeof node?.properties.dataFadeFrom === 'number' && typeof children === 'string'
    ? <StreamedWords text={children} from={node.properties.dataFadeFrom} />
    : <span>{children}</span>,
  a: AgentLink,
  img: ({ alt }) => <span>{alt}</span>,
  pre: ({ children }) => {
    if (!isValidElement<{ className?: string; children?: ReactNode }>(children)) return <pre>{children}</pre>;
    const language = children.props.className?.match(/language-([\w+-]+)/)?.[1] ?? 'text';
    return <CodeBlock code={String(children.props.children ?? '').replace(/\n$/, '')} language={language} />;
  },
  table: ({ children }) => <div className="sp-agent-table-scroll" tabIndex={0} role="region" aria-label="Response table"><table>{children}</table></div>,
};

export function AgentMarkdown({ text, streaming = false, newArrival = false }: { text: string; streaming?: boolean; newArrival?: boolean }) {
  const visible = useStreamingText(text, streaming, newArrival);
  const from = visible.fadeFrom;
  // Bound concurrent word animations even when a provider sends a whole page in one snapshot.
  const tailFrom = Math.max(from ?? 0, visible.text.length - 512);
  return <div className="sp-agent-markdown" data-emoji-only={isEmojiOnlyText(text) || undefined}>
    <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={from === undefined ? [markAgentQuotes] : [markAgentQuotes, [fadeStreamedWords, from, tailFrom]]}
      skipHtml urlTransform={url => parseAssetPagePath(url) || isAssetDownloadPath(url) || isMessagePath(url) || isChannelPath(url) || parseWorkspaceProfileLink(url) ? url : safeLink(url) ?? ''} components={markdownComponents}>{visible.text}</Markdown>
  </div>;
}

type DocumentEditActions = (edit: DocumentEditBlock) => ReactNode;

function ResponseComponent({ component, documentEditActions }: { component: AgentComponent; documentEditActions?: DocumentEditActions }) {
  if (component.type === 'data_table') return <AgentDataTable key={JSON.stringify(component.columns)} block={component} />;
  if (component.type === 'carousel') return <AgentCarousel title={component.title} cards={component.cards} />;
  if (component.type === 'alert') return <MessageAlert level={component.level} title={component.title}>
    {component.body && <AgentMarkdown text={component.body} />}
  </MessageAlert>;
  if (component.type === 'document_edit') {
    const actions = documentEditActions?.(component);
    return <article className="sp-work-card sp-document-edit" aria-label={component.title}>
      <div className="sp-work-content">
        <h4>{component.title}</h4>
        <dl><dt>Selected passage</dt><dd>{component.original}</dd>
          <dt>Proposed replacement</dt><dd>{component.replacement}</dd></dl>
      </div>
      {actions && <footer className="sp-work-footer">{actions}</footer>}
    </article>;
  }
  return component.type === 'card'
  ? <article className="sp-work-card sp-agent-result"><h4>{component.title}</h4><p>{component.body}</p></article>
  : <div className="sp-agent-table-scroll" role="region" aria-label={component.title} tabIndex={0}><table>
    <caption>{component.title}</caption><thead><tr>{component.columns.map((column, index) => <th key={index} scope="col">{column}</th>)}</tr></thead>
    <tbody>{component.rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column}>{cell}</td>)}</tr>)}</tbody>
  </table></div>;
}

export function AgentResponse({ response, streaming = false, showActivity = true, newArrival = false, fallback, documentEditActions }: { documentEditActions?: DocumentEditActions; response: Response; streaming?: boolean; showActivity?: boolean; newArrival?: boolean; fallback?: string }) {
  const [initialMessages] = useState(() => new Set(response.messages.map(message => message.id)));
  const messages = new Map(response.messages.map(message => [message.id, message]));
  const tools = new Map(response.tools.map(tool => [tool.id, tool]));
  const items = response.items ?? [...response.tools.map(tool => ({ type: 'tool' as const, id: tool.id })), ...response.messages.map(message => ({ type: 'message' as const, id: message.id }))];
  const components = new Map(response.components.map(component => [component.id, component]));
  const blocks: ({ type: 'component'; id: string; component: AgentComponent } | { type: 'message'; id: string; message: AgentText } | { type: 'tools'; id: string; tools: AgentTool[] })[] = [];
  for (const item of items) {
    if (item.type === 'component') {
      const component = components.get(item.id);
      if (component) {
        blocks.push({ type: 'component', id: item.id, component });
        components.delete(item.id);
      }
    } else if (item.type === 'message') {
      const message = messages.get(item.id);
      if (message) blocks.push({ type: 'message', id: item.id, message });
    } else {
      const tool = tools.get(item.id);
      if (!tool) continue;
      const previous = blocks.at(-1);
      if (previous?.type === 'tools') previous.tools.push(tool);
      else blocks.push({ type: 'tools', id: item.id, tools: [tool] });
    }
  }
  for (const component of components.values()) blocks.push({ type: 'component', id: component.id, component });
  return <div className="sp-agent-response" aria-busy={streaming}>
    {blocks.map(block => block.type === 'component'
      ? <ResponseComponent key={`component:${block.id}`} component={block.component} documentEditActions={documentEditActions} />
      : block.type === 'message'
      ? <AgentMarkdown key={`message:${block.id}`} text={block.message.text} streaming={streaming && block.message.status === 'streaming'} newArrival={newArrival || !initialMessages.has(block.id)} />
      : <ToolExecution key={`tool:${block.id}`} completed={!streaming} points={block.tools.map(tool => ({
      id: tool.id, icon: 'code',
      text: `${tool.name}${tool.status === 'interrupted' ? ' · Interrupted' : tool.status === 'running' ? ' · Running' : tool.status === 'calling' ? ' · Preparing' : ' · Completed'}`,
      ...((tool.status === 'calling' || tool.status === 'running') && streaming ? { status: 'in_progress' as const } : {}),
      steps: ['write_file','edit_file'].includes(tool.name) ? [{id:'file',text:<FileToolDetails tool={tool}/>}]: [
        ...(tool.arguments ? [{ id: 'arguments', text: <><strong>Input</strong><pre>{tool.arguments}</pre></> }] : []),
        ...(tool.result ? [{ id: 'result', text: <><strong>Result</strong><div className="sp-agent-tool-result"><CodeBlock code={tool.result} /></div></> }] : []),
      ],
    }))} />)}
    {!streaming && fallback && !response.messages.some(message => message.text.trim()) && !response.tools.length && !response.components.length && <AgentMarkdown text={fallback} newArrival={newArrival} />}
    {streaming && showActivity && <p className="sp-agent-streaming" role="status">{response.step ?? ({working:'Working…',thinking:'Thinking…',responding:'Responding…',using_tools:'Using tools…'}[response.activity ?? 'responding'])}</p>}
  </div>;
}
