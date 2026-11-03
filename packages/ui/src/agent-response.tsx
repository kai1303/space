import { isValidElement, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AgentResponse as Response } from '@space/contracts';
import { CodeBlock } from './code-block.js';
import { ToolExecution } from './work-items.js';
import { safeLink } from './rich-text.js';

export function AgentMarkdown({ text }: { text: string }) {
  return <div className="sp-agent-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={url => safeLink(url) ?? ''}
    components={{
      a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
      img: ({ alt }) => <span>{alt}</span>,
      pre: ({ children }) => {
        if (!isValidElement<{ className?: string; children?: ReactNode }>(children)) return <pre>{children}</pre>;
        const language = children.props.className?.match(/language-([\w+-]+)/)?.[1] ?? 'text';
        return <CodeBlock code={String(children.props.children ?? '').replace(/\n$/, '')} language={language} />;
      },
      table: ({ children }) => <div className="sp-agent-table-scroll" tabIndex={0} role="region" aria-label="Response table"><table>{children}</table></div>,
    }}>{text}</Markdown></div>;
}

export function AgentResponse({ response, streaming = false, fallback }: { response: Response; streaming?: boolean; fallback?: string }) {
  return <div className="sp-agent-response" aria-busy={streaming}>
    <ToolExecution completed={!streaming} points={response.tools.map(tool => ({
      id: tool.id, icon: 'code',
      text: `${tool.name}${tool.status === 'interrupted' ? ' · Interrupted' : tool.status === 'running' ? ' · Running' : tool.status === 'calling' ? ' · Preparing' : ' · Completed'}`,
      ...((tool.status === 'calling' || tool.status === 'running') && streaming ? { status: 'in_progress' as const } : {}),
      steps: [
        ...(tool.arguments ? [{ id: 'arguments', text: <><strong>Input</strong><pre>{tool.arguments}</pre></> }] : []),
        ...(tool.result ? [{ id: 'result', text: <><strong>Result</strong><pre>{tool.result}</pre></> }] : []),
      ],
    }))} />
    {response.messages.map(message => <AgentMarkdown key={message.id} text={message.text} />)}
    {!streaming && fallback && !response.messages.some(message => message.text.trim()) && !response.tools.length && !response.components.length && <AgentMarkdown text={fallback} />}
    {response.components.map(component => component.type === 'card'
      ? <article key={component.id} className="sp-work-card sp-agent-result"><h4>{component.title}</h4><p>{component.body}</p></article>
      : <div key={component.id} className="sp-agent-table-scroll" role="region" aria-label={component.title} tabIndex={0}><table>
        <caption>{component.title}</caption><thead><tr>{component.columns.map((column, index) => <th key={index} scope="col">{column}</th>)}</tr></thead>
        <tbody>{component.rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column}>{cell}</td>)}</tr>)}</tbody>
      </table></div>)}
    {streaming && <p className="sp-agent-streaming" role="status">{response.step ?? 'Responding…'}</p>}
  </div>;
}
