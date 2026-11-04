import { useId, useState, type ReactNode } from "react";
import {
  ArrowUpRight, CaretRight, CheckCircle, Clock, Info, Ticket,
  Code, File, MagnifyingGlass, Sparkle, Warning, WarningCircle, X,
} from "@phosphor-icons/react";
import { Badge, Button, IconButton, type Tone } from "../primitives/primitives.js";
import { Reveal } from "../motion/reveal.js";

export type TicketStatus = "open" | "in_progress" | "done";
export type TicketPriority = "low" | "medium" | "high" | "urgent";
const ticketStatuses: Record<TicketStatus, { label: string; tone: Tone }> = {
  open: { label: "Open", tone: "neutral" },
  in_progress: { label: "In progress", tone: "info" },
  done: { label: "Done", tone: "success" },
};
export function TicketCard({ ticketId, title, description, status, priority = "medium", assignee, onOpen }: {
  ticketId: string;
  title: string;
  description?: string;
  status: TicketStatus;
  priority?: TicketPriority;
  assignee?: string;
  onOpen?: () => void;
}) {
  const id = useId();
  const state = ticketStatuses[status];
  return (
    <article className="sp-work-card sp-ticket" aria-labelledby={id}>
      <header className="sp-work-header">
        <span className="sp-work-icon"><Ticket size={18} /></span>
        <span className="sp-work-reference">{ticketId}</span>
        <Badge tone={state.tone} dot>{state.label}</Badge>
      </header>
      <div className="sp-work-content">
        <h4 id={id}>{title}</h4>
        {description && <p>{description}</p>}
        <div className="sp-work-metadata">
          <span className={`sp-ticket-priority sp-ticket-priority--${priority}`}>
            <span aria-hidden="true">↑</span>
            {priority.charAt(0).toUpperCase() + priority.slice(1)} priority
          </span>
          <span>Assigned to <strong>{assignee ?? "Unassigned"}</strong></span>
        </div>
      </div>
      {onOpen && <footer className="sp-work-footer">
        <Button size="sm" variant="ghost" aria-label={`Open ticket ${ticketId}`} onClick={onOpen}>
          Open ticket <ArrowUpRight size={14} />
        </Button>
      </footer>}
    </article>
  );
}

export function Alert({ title, children, tone = "info", onDismiss }: {
  title: string;
  children?: ReactNode;
  tone?: "info" | "success" | "warning" | "danger";
  onDismiss?: () => void;
}) {
  const Icon = { info: Info, success: CheckCircle, warning: Warning, danger: WarningCircle }[tone];
  return (
    <div className={`sp-alert sp-alert--${tone}`} role={tone === "danger" || tone === "warning" ? "alert" : "status"}>
      <Icon size={20} className="sp-alert-icon" />
      <div><strong>{title}</strong>{children && <div className="sp-alert-body">{children}</div>}</div>
      {onDismiss && <IconButton size="sm" label={`Dismiss ${title}`} onClick={onDismiss}><X size={16} /></IconButton>}
    </div>
  );
}

export type ToolTimelineStep = {
  id: string;
  text: ReactNode;
  sourcesCount?: number;
  onViewSources?: () => void;
};
export type ToolTimelinePoint = {
  id: string;
  text: ReactNode;
  icon?: "search" | "code" | "file" | "thinking";
  status?: "in_progress";
  steps?: ToolTimelineStep[];
};
const toolIcons = { search: MagnifyingGlass, code: Code, file: File, thinking: Sparkle };
export function ToolExecution({ points, summary, completed = false }: {
  points: ToolTimelinePoint[];
  summary?: ReactNode;
  completed?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  if (!points.length) return null;
  const running = !completed && points.some((point) => point.status === "in_progress");
  const multiple = points.length > 1;
  const expandable = multiple || points.some((point) => point.steps?.length);
  const last = points[points.length - 1]!;
  const count = `${running ? "Using" : "Used"} ${points.length} tools`;
  const header = multiple && (expanded || !running || summary)
    ? summary ?? count
    : last.text;
  const icons = [...new Set(points.flatMap((point) => point.icon ? [point.icon] : []))].slice(-3);
  const heading = <>
    <span className="sp-tool-header-text" id={`${listId}-summary`}>
      {(!expanded || icons.length <= 1) && <span className="sp-tool-icons" aria-hidden="true">{icons.map((icon) => {
        const Icon = toolIcons[icon];
        return <span key={icon}><Icon size={13} /></span>;
      })}</span>}
      {header}
    </span>
    {expandable && <CaretRight size={13} className="sp-tool-caret" aria-hidden="true" />}
  </>;
  return (
    <div className={`sp-tool-timeline ${running ? "is-running" : ""} ${expanded ? "is-expanded" : ""}`}>
      {expandable ? <button type="button" className="sp-tool-toggle" aria-expanded={expanded}
        aria-controls={listId} aria-describedby={`${listId}-summary`} aria-label={expanded ? "Collapse timeline" : "Expand timeline"}
        onClick={() => setExpanded(!expanded)}>{heading}</button>
        : <div className="sp-tool-toggle">{heading}</div>}
      <Reveal open={expanded && expandable}><ol id={listId} className="sp-tool-points">
        {points.flatMap((point) => {
          const Icon = point.icon ? toolIcons[point.icon] : null;
          return [
            ...(multiple ? [<li key={point.id} className="sp-tool-point">
              <span className="sp-tool-indicator" aria-hidden="true">{Icon && <Icon size={13} />}</span><span>{point.text}</span>
            </li>] : []),
            ...(point.steps ?? []).map((step, index, steps) => <li key={`${point.id}-${step.id}`} className="sp-tool-point sp-tool-substep">
              <span className="sp-tool-indicator" aria-hidden="true">{(index === 0 || index === steps.length - 1) && <i />}</span>
              <span>{step.text}</span>
              {!!step.sourcesCount && step.onViewSources && <button type="button" className="sp-tool-sources"
                aria-label="View sources" onClick={step.onViewSources}>(Sources)</button>}
            </li>),
          ];
        })}
      </ol></Reveal>
    </div>
  );
}
