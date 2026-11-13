import { createContext, isValidElement, useContext, useState, type ReactNode } from 'react';
import { StreamedWords } from './streamed-words.js';
import { fadeStreamedWords, useStreamingText } from './streaming-text.js';
import Markdown, { type Components, type ExtraProps } from 'react-markdown';
import type { ElementContent } from 'hast';
import remarkGfm from 'remark-gfm';
import type { AgentResponse as Response, AgentText, AgentTool } from '@space/contracts';
import { isChannelPath, isAssetDownloadPath, isMessagePath, parseWorkspaceProfileLink } from '@space/contracts';
import { CodeBlock } from '../rich-text/code-block.js';
import { FileToolDetails } from './FileToolDetails.js';
import { ToolExecution } from './work-items.js';
import { safeLink } from '../rich-text/rich-text.js';

export const AgentProfileLinkContext = createContext<{
  workspace: string;
  viewer: string;
  open: (target: { kind: 'user' | 'agent'; id: string }) => void;
} | null>(null);

function inlineText(nodes: ElementContent[]): string {
  return nodes.map(node => node.type === 'text' ? node.value : node.type === 'element' ? inlineText(node.children) : '').join('');
}

function AgentLink({ href, children, node }: ExtraProps & { href?: string; children?: ReactNode }) {
  const profiles = useContext(AgentProfileLinkContext);
  if (!href) return <span>{children}</span>;
  if (isMessagePath(href) || isAssetDownloadPath(href)) return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
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

const markdownComponents: Components = {
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
  return <div className="sp-agent-markdown">
    <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={from === undefined ? [] : [[fadeStreamedWords, from, tailFrom]]}
      skipHtml urlTransform={url => isAssetDownloadPath(url) || isMessagePath(url) || isChannelPath(url) || parseWorkspaceProfileLink(url) ? url : safeLink(url) ?? ''} components={markdownComponents}>{visible.text}</Markdown>
  </div>;
}

export function AgentResponse({ response, streaming = false, showActivity = true, newArrival = false, fallback }: { response: Response; streaming?: boolean; showActivity?: boolean; newArrival?: boolean; fallback?: string }) {
  const [initialMessages] = useState(() => new Set(response.messages.map(message => message.id)));
  const messages = new Map(response.messages.map(message => [message.id, message]));
  const tools = new Map(response.tools.map(tool => [tool.id, tool]));
  const items = response.items ?? [...response.tools.map(tool => ({ type: 'tool' as const, id: tool.id })), ...response.messages.map(message => ({ type: 'message' as const, id: message.id }))];
  const blocks: ({ type: 'message'; id: string; message: AgentText } | { type: 'tools'; id: string; tools: AgentTool[] })[] = [];
  for (const item of items) {
    if (item.type === 'message') {
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
  return <div className="sp-agent-response" aria-busy={streaming}>
    {blocks.map(block => block.type === 'message'
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
    {response.components.map(component => component.type === 'card'
      ? <article key={component.id} className="sp-work-card sp-agent-result"><h4>{component.title}</h4><p>{component.body}</p></article>
      : <div key={component.id} className="sp-agent-table-scroll" role="region" aria-label={component.title} tabIndex={0}><table>
        <caption>{component.title}</caption><thead><tr>{component.columns.map((column, index) => <th key={index} scope="col">{column}</th>)}</tr></thead>
        <tbody>{component.rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column}>{cell}</td>)}</tr>)}</tbody>
      </table></div>)}
    {streaming && showActivity && <p className="sp-agent-streaming" role="status">{response.step ?? ({working:'Working…',thinking:'Thinking…',responding:'Responding…',using_tools:'Using tools…'}[response.activity ?? 'responding'])}</p>}
  </div>;
}
