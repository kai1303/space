import { useState } from "react";
import { AgentApproval, Alert, TicketCard, ToolExecution, type ApprovalDecision, type ApprovalStatus, type TicketStatus, type ToolTimelinePoint } from '@space/ui/agents';
import { Badge, Button, Dialog, Switch, Tabs } from '@space/ui/primitives';
import { CodeBlock } from '@space/ui/rich-text';
import { Message } from '@space/ui/conversation';
import { SectionHeading } from "./Foundations.js";
import { Sample } from "./Components.js";
import { AgentWorkspaceExample } from './AgentWorkspaceExample.js';
import { AgUiExample } from './AgUiExample.js';

const exampleCode = `type Ticket = {
  id: string;
  title: string;
  priority: "low" | "medium" | "high";
};

const ticket: Ticket = {
  id: "SP-142",
  title: "Improve notification delivery",
  priority: "high",
};`;
const codeExamples = {
  typescript: exampleCode,
  python: 'def greet(name):\n    return f"Hello, {name}!"\n\nprint(greet("Space"))',
  json: JSON.stringify({ id: "SP-142", title: "Improve notification delivery", priority: "high" }, null, 2),
};

export function WorkComponents() {
  const [ticketStatus, setTicketStatus] = useState<TicketStatus>("in_progress");
  const [ticketOpen, setTicketOpen] = useState(false);
  const [alertVisible, setAlertVisible] = useState(true);
  const [alertTone, setAlertTone] = useState<"info" | "success" | "warning" | "danger">("warning");
  const [executionRunning, setExecutionRunning] = useState(false);
  const [toolMode, setToolMode] = useState<"multiple" | "single" | "steps">("multiple");
  const [codeLanguage, setCodeLanguage] = useState<keyof typeof codeExamples>("python");
  const [approval, setApproval] = useState<ApprovalStatus>("pending");
  const [approvalNumber, setApprovalNumber] = useState(1);
  const [failDecision, setFailDecision] = useState(false);
  function decide(decision: ApprovalDecision) {
    if (failDecision) throw new Error("Simulated save failure");
    setApproval(decision);
  }
  const alertExamples = {
    info: { title: "An update is available", body: "Refresh when you’re ready to load the latest conversation." },
    success: { title: "Changes saved", body: "Your notification preferences are up to date." },
    warning: { title: "Notification delivery is delayed", body: "Messages are safe. Some notifications may arrive a few minutes late." },
    danger: { title: "Could not connect", body: "Check your connection and try again. Your draft stays here." },
  };
  const currentAlert = alertExamples[alertTone];
  const points: ToolTimelinePoint[] = toolMode === "multiple" ? [
    { id: "messages", icon: "search", text: <>Searched <strong>“notification”</strong></> },
    { id: "files", icon: "search", text: <>{executionRunning ? "Searching" : "Searched"} <strong>“notification”</strong></>,
      ...(executionRunning ? { status: "in_progress" as const } : {}) },
  ] : [{ id: "search", icon: "search", text: executionRunning ? "Searching related messages…" : "Searched related messages",
    ...(executionRunning ? { status: "in_progress" as const } : {}),
    ...(toolMode === "steps" ? { steps: [
      { id: "query", text: <>Searched <strong>“notification”</strong></> },
      { id: "read", text: "Read related results" },
    ] } : {}),
  }];
  return (
    <section id="work-components" className="ds-section">
      <SectionHeading number="04" title="Work inside the conversation"
        description="Tickets, alerts, code, and agent actions. Shared components with real interaction states." />
      <div className="work-components-note"><Badge tone="accent">LOCAL EXAMPLES</Badge><span>Try the controls. These examples don’t create tickets or execute tools.</span></div>
      <div className="component-grid work-component-grid">
        <Sample id="ticket-card" title="Ticket" detail="An issue, with just enough context" count="08">
          <TicketCard ticketId="SP-142" title="Improve notification delivery" status={ticketStatus}
            priority="high" assignee="Jamie Chen"
            description="Investigate delayed channel notifications and make delivery more reliable."
            onOpen={() => setTicketOpen(true)} />
          <Tabs className="work-example-tabs" label="Ticket status examples" value={ticketStatus} onChange={value=>{setTicketStatus(value as typeof ticketStatus);}} items={[{"id": "open", "label": "Open"}, {"id": "in_progress", "label": "In progress"}, {"id": "done", "label": "Done"}]}/>
        </Sample>
        <Sample id="alerts" title="Alert" detail="Clear feedback, with a next step" count="09">
          <Tabs className="work-example-tabs" label="Alert examples" value={alertTone} onChange={value=>{setAlertTone(value as typeof alertTone); setAlertVisible(true);}} items={[{"id": "info", "label": "Info"}, {"id": "success", "label": "Success"}, {"id": "warning", "label": "Warning"}, {"id": "danger", "label": "Error"}]}/>
          {alertVisible ? <Alert title={currentAlert.title} tone={alertTone} onDismiss={() => setAlertVisible(false)}>
            {currentAlert.body}
          </Alert> : <div className="work-example-empty"><span>Alert dismissed.</span><Button size="sm" onClick={() => setAlertVisible(true)}>Show alert</Button></div>}
        </Sample>
        <Sample id="code-block" title="Code block" detail="Language, line numbers, and syntax colors from Slackbot" count="10">
          <CodeBlock language={codeLanguage} code={codeExamples[codeLanguage]} />
          <Tabs className="work-example-tabs" label="Code language examples" value={codeLanguage} onChange={value=>{setCodeLanguage(value as typeof codeLanguage);}} items={[{"id": "python", "label": "Python"}, {"id": "typescript", "label": "TypeScript"}, {"id": "json", "label": "JSON"}]}/>
          <span className="ds-muted">Copy preserves the original text. Long lines scroll horizontally.</span>
        </Sample>
        <Sample id="tool-execution" title="Agent communication" detail="Slackbot’s condensed tool timeline" count="11">
          <Message author="Triage agent" initials="TA" tone="green" agent time="Just now">
            <ToolExecution key={toolMode} points={points} completed={!executionRunning}
              summary={toolMode === "multiple" && !executionRunning ? 'Searched messages and files for “notification”' : undefined} />
            {!executionRunning && <p>I found two related issues about notification delivery.</p>}
          </Message>
          <Tabs className="work-example-tabs" label="Tool timeline examples" value={toolMode} onChange={value=>{setToolMode(value as typeof toolMode);}} items={[{"id": "multiple", "label": "Two tools"}, {"id": "single", "label": "One tool"}, {"id": "steps", "label": "With steps"}]}/>
          <Switch label="Show tools running" checked={executionRunning} onChange={setExecutionRunning} />
          <span className="ds-muted">Expandable for multiple tools or substeps. Input and output cards are not part of this observed timeline.</span>
        </Sample>
        <Sample id="agent-approval" title="Agent approval" detail="Review the action before it happens" count="12">
          <AgentApproval key={approvalNumber} requestId={`APR-${104 + approvalNumber}`}
            title="Create “Add notification delivery metrics”?" agent="Triage agent" scope="Space studio · Design project"
            tools={[{ name: "issues.create", displayName: "Create issue" }]} approveLabel="Create issue" rejectLabel="Not now"
            status={approval} onDecide={decide}>
            Assign to Jamie Chen with medium priority.
            <div className="work-approval-impact">Creates one issue. Existing issues stay unchanged.</div>
          </AgentApproval>
          <Switch label="Simulate a failed decision save" checked={failDecision} onChange={setFailDecision} />
          <div className="work-example-controls">
            <Button size="sm" onClick={() => { setApprovalNumber((value) => value + 1); setApproval("pending"); }}>New request</Button>
            <Button size="sm" disabled={approval !== "pending"} onClick={() => setApproval("expired")}>Expire request</Button>
          </div>
        </Sample>
        <AgentWorkspaceExample />
        <AgUiExample />
        <div className="work-composed-example ds-card">
          <div className="sample-heading"><div><h3>In a conversation</h3><p>The same cards, inside a message.</p></div><Badge>COMPOSED</Badge></div>
          <Message author="Triage agent" initials="TA" agent tone="green" time="Just now">
            <p>I found an issue that matches the notification delay.</p>
            <div className="work-message-card"><TicketCard ticketId="SP-142" title="Improve notification delivery"
              status={ticketStatus} priority="high" assignee="Jamie Chen" onOpen={() => setTicketOpen(true)} /></div>
          </Message>
        </div>
      </div>
      <Dialog open={ticketOpen} onClose={() => setTicketOpen(false)} title="SP-142">
        <div className="work-ticket-dialog"><TicketCard ticketId="SP-142" title="Improve notification delivery" status={ticketStatus}
          priority="high" assignee="Jamie Chen" description="Measure the delay between message delivery and channel notification. Add delivery metrics before changing the retry policy." />
          <Alert title="Local issue preview" tone="info">Changes here only affect this gallery example.</Alert>
          <Button onClick={() => { setTicketStatus("done"); setTicketOpen(false); }}>Mark as done</Button>
        </div>
      </Dialog>
    </section>
  );
}
