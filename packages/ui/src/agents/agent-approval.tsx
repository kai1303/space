import { useId, useRef, useState, type ReactNode } from "react";
import { Badge, Button, type Tone } from "../primitives/primitives.js";

export type ApprovalDecision = "approved" | "rejected";
export type ApprovalStatus = "pending" | ApprovalDecision | "expired";
const approvalStates: Record<ApprovalStatus, { label: string; tone: Tone }> = {
  pending: { label: "Awaiting approval", tone: "warning" },
  approved: { label: "Approved", tone: "success" },
  rejected: { label: "Rejected", tone: "danger" },
  expired: { label: "Expired", tone: "neutral" },
};
type AgentApprovalProps = {
  requestId: string;
  title: string;
  agent: string;
  scope: string;
  status: ApprovalStatus;
  children: ReactNode;
  tools?: { name: string; displayName: string; isDestructive?: boolean }[];
  approveLabel?: string;
  rejectLabel?: string;
  onDecide?: (decision: ApprovalDecision) => void | Promise<void>;
};
export function AgentApproval(props: AgentApprovalProps) {
  return <ApprovalRequest key={props.requestId} {...props} />;
}
function ApprovalRequest({ title, agent, scope, status, children, onDecide, tools = [], approveLabel = "Yes", rejectLabel = "No" }: AgentApprovalProps) {
  const id = useId();
  const [submitting, setSubmitting] = useState<ApprovalDecision | null>(null);
  const [error, setError] = useState("");
  const pending = useRef(false);
  async function decide(decision: ApprovalDecision) {
    if (pending.current || status !== "pending" || !onDecide) return;
    pending.current = true;
    setSubmitting(decision);
    setError("");
    try {
      await onDecide(decision);
    } catch {
      setError("Decision was not saved. Review the request and try again.");
    } finally {
      pending.current = false;
      setSubmitting(null);
    }
  }
  const state = approvalStates[status];
  const destructive = tools.some((tool) => tool.isDestructive);
  return (
    <article className={`sp-agent-approval ${destructive ? "sp-approval-destructive" : ""}`} aria-labelledby={id} aria-busy={!!submitting}>
      <h4 id={id}>{status === "pending" ? `${agent} needs your okay` : title}</h4>
      <ul className="sp-approval-details">
        {status === "pending" && <li>{title}</li>}
        <li>{children}</li>
      </ul>
      <div className="sp-approval-context">{scope}</div>
      {tools.length > 0 && <ul className="sp-approval-tools">{tools.map((tool) => <li key={tool.name}>{tool.displayName}</li>)}</ul>}
      <div className="sp-approval-feedback">
        {status !== "pending" && <span role="status"><Badge tone={state.tone}>{state.label}</Badge></span>}
        {status === "expired" && <p>Ask the agent for a new request.</p>}
        {error && <p role="alert" className="sp-field-error">{error}</p>}
      </div>
      {status === "pending" && <div className="sp-approval-actions">
        {submitting && <span role="status">Saving decision…</span>}
        <Button size="md" variant={destructive ? "danger" : "primary"} disabled={!!submitting || !onDecide}
          onClick={() => void decide("approved")} loading={submitting === "approved"}>
          {approveLabel}
        </Button>
        <Button size="md" disabled={!!submitting || !onDecide} onClick={() => void decide("rejected")}
          loading={submitting === "rejected"}>{rejectLabel}</Button>
      </div>}
    </article>
  );
}
