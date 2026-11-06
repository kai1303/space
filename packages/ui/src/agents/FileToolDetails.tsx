import type { AgentTool } from '@space/contracts';
import { CodeBlock } from '../rich-text/code-block.js';

export function FileToolDetails({ tool }: { tool: AgentTool }) {
  let input: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(tool.arguments);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
  } catch { /* Saved input can be truncated; keep its raw form available. */ }
  const path = typeof input.path === 'string' ? input.path : undefined;
  const name = path?.split(/[\\/]/).filter(Boolean).at(-1) ?? 'File path unavailable';
  const writing = tool.name === 'write_file';
  // Filesystem edits return a fenced unified diff, including longer fences when content contains backticks.
  const diff = !writing ? tool.result?.match(/^(`{3,})diff\r?\n([\s\S]*?)\1\s*$/)?.[2] : undefined;
  const edits = Array.isArray(input.edits) ? input.edits : [];
  const requested = edits.slice(0, 20).flatMap(edit => edit && typeof edit.oldText === 'string' && typeof edit.newText === 'string'
    ? [`${edit.oldText.split('\n').map((line: string) => `- ${line}`).join('\n')}\n${edit.newText.split('\n').map((line: string) => `+ ${line}`).join('\n')}`] : []).join('\n\n');
  const content = writing ? typeof input.content === 'string' ? input.content : undefined : diff ?? (requested || undefined);
  const label = writing ? 'Content sent' : diff !== undefined ? 'Changes returned' : 'Requested edits';
  const language = writing ? path?.split('.').at(-1)?.toLowerCase() ?? 'text' : 'diff';
  return <div className="sp-agent-file-tool">
    <div className="sp-agent-file-header"><strong title={path}>{name}</strong>{input.dryRun === true && <span>Preview only</span>}</div>
    {path && <div className="sp-agent-file-path">{path}</div>}
    {content !== undefined && <><span className="sp-agent-file-label">{label}</span><div className="sp-agent-tool-result"><CodeBlock code={content} language={language}/></div></>}
    {!writing && diff === undefined && edits.length > 20 && <p>Showing the first 20 requested edits. See Details for the saved input.</p>}
    {tool.result && diff === undefined && <><span className="sp-agent-file-label">Result</span><div className="sp-agent-tool-result"><CodeBlock code={tool.result}/></div></>}
    <details className="sp-agent-file-raw"><summary>Details</summary><span className="sp-agent-file-label">Input</span><div className="sp-agent-tool-result"><CodeBlock code={tool.arguments} language="json"/></div></details>
  </div>;
}
