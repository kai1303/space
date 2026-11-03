import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Alert, TicketCard, ToolExecution } from "./work-items.js";
import { CodeBlock } from "./code-block.js";
import { AgentApproval, type ApprovalDecision } from "./agent-approval.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("opens a ticket without changing its controlled status", async () => {
  const open = vi.fn();
  render(<TicketCard ticketId="SP-42" title="Fix notification delivery" status="in_progress"
    priority="high" assignee="Jamie Chen" onOpen={open} />);
  expect(screen.getByRole("article", { name: "Fix notification delivery" })).toBeTruthy();
  expect(screen.getByText("In progress")).toBeTruthy();
  expect(screen.getByText("High priority")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Open ticket SP-42" }));
  expect(open).toHaveBeenCalledOnce();
  expect(screen.getByText("In progress")).toBeTruthy();
});

it("announces urgent alerts and delegates dismissal", async () => {
  const dismiss = vi.fn();
  render(<Alert title="Delivery delayed" tone="danger" onDismiss={dismiss}>Retry in a moment.</Alert>);
  expect(screen.getByRole("alert").textContent).toContain("Delivery delayed");
  await userEvent.click(screen.getByRole("button", { name: "Dismiss Delivery delayed" }));
  expect(dismiss).toHaveBeenCalledOnce();
});

it("uses a polite status for informational alerts", () => {
  render(<Alert title="Sync complete" tone="success">All messages are up to date.</Alert>);
  expect(screen.getByRole("status").textContent).toContain("Sync complete");
  expect(screen.queryByRole("alert")).toBeNull();
});

it("renders code as text and copies its exact whitespace", async () => {
  const user = userEvent.setup();
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const code = '<img src=x onerror=alert(1)>\n  keep indent\n';
  const { container } = render(<CodeBlock code={code} language="html" />);
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("pre code")?.textContent).toBe(code);
  await user.click(screen.getByRole("button", { name: "Copy", exact: true }));
  expect(copy).toHaveBeenCalledWith(code);
  expect(screen.getByRole("status").textContent).toBe("Copied");
});

it("reports clipboard failure without adding a filename or wrap toolbar", async () => {
  const user = userEvent.setup();
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("Denied"));
  render(<CodeBlock code="a very long line" language="text" />);
  expect(screen.queryByRole("button", { name: "Wrap code" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Copy", exact: true }));
  expect(screen.getByRole("alert").textContent).toContain("Could not copy");
});

it("renders Slackbot-style language, line numbers and syntax tokens", async () => {
  const { container } = render(<CodeBlock code={'const value = "hello";\nconsole.log(value);'} language="typescript" />);
  expect(screen.getByRole("group", { name: "TypeScript code block" })).toBeTruthy();
  expect(container.querySelector(".sp-code-gutter")?.getAttribute("aria-hidden")).toBe("true");
  expect(container.querySelectorAll(".sp-code-gutter > span")).toHaveLength(2);
  await waitFor(() => expect(container.querySelector(".sp-code-token--string")?.textContent).toBe("hello"));
  expect(container.querySelector("pre code")?.textContent).toBe('const value = "hello";\nconsole.log(value);');
});

it("opens a compact tool timeline, without raw input/output cards", async () => {
  render(<ToolExecution completed summary="Searched messages and files"
    points={[{ id: "messages", text: "Searched messages", icon: "search" }, { id: "files", text: "Searched files", icon: "search" }]} />);
  const expand = screen.getByRole("button", { name: "Expand timeline" });
  expect(expand.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("list")).toBeNull();
  await userEvent.click(expand);
  expect(screen.getByRole("button", { name: "Collapse timeline" }).getAttribute("aria-expanded")).toBe("true");
  expect(screen.getAllByRole("listitem")).toHaveLength(2);
  expect(screen.queryByText("Input")).toBeNull();
});

it("does not expand a single tool without substeps", () => {
  render(<ToolExecution completed points={[{ id: "search", text: "Searched messages", icon: "search" }]} />);
  expect(screen.getByText("Searched messages")).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
});

it("uses the latest active point while collapsed and a tool count when expanded", async () => {
  const points = [{ id: "messages", text: "Searched messages", icon: "search" as const },
    { id: "files", text: "Searching files…", status: "in_progress" as const, icon: "file" as const }];
  const { rerender, container } = render(<ToolExecution points={points} />);
  expect(screen.getByText("Searching files…")).toBeTruthy();
  expect(container.querySelector(".is-running")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Expand timeline" }));
  expect(screen.getByText("Using 2 tools")).toBeTruthy();
  rerender(<ToolExecution points={points} completed />);
  expect(screen.getByText("Used 2 tools")).toBeTruthy();
  expect(container.querySelector(".is-running")).toBeNull();
});

it("expands single-tool substeps and delegates source viewing", async () => {
  const view = vi.fn();
  render(<ToolExecution completed points={[{ id: "search", text: "Searched messages", icon: "search",
    steps: [{ id: "query", text: "Read related results", sourcesCount: 2, onViewSources: view }] }]} />);
  await userEvent.click(screen.getByRole("button", { name: "Expand timeline" }));
  expect(screen.getAllByRole("listitem")).toHaveLength(1);
  await userEvent.click(screen.getByRole("button", { name: "View sources" }));
  expect(view).toHaveBeenCalledOnce();
});

it("renders no timeline for an empty point list", () => {
  const { container } = render(<ToolExecution points={[]} />);
  expect(container.textContent).toBe("");
});

const approval = { requestId: "approval-42", title: "Create a follow-up ticket", agent: "Triage agent", scope: "Space studio / Design", status: "pending" as const };
it("prevents duplicate or conflicting approval submissions while pending", async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const decide = vi.fn< (decision: ApprovalDecision) => Promise<void> >(() => pending);
  render(<AgentApproval {...approval} onDecide={decide}>Create SP-42 with high priority.</AgentApproval>);
  await userEvent.click(screen.getByRole("button", { name: "Yes" }));
  await userEvent.click(screen.getByRole("button", { name: "No" }));
  expect(decide).toHaveBeenCalledExactlyOnceWith("approved");
  const card = screen.getByRole("article");
  expect(within(card).getAllByRole("button").every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
  await act(async () => { finish(); await pending; });
});

it("preserves an undecided request after failure and permits retry", async () => {
  const decide = vi.fn().mockRejectedValueOnce(new Error("Offline")).mockResolvedValueOnce(undefined);
  render(<AgentApproval {...approval} onDecide={decide}>Create SP-42.</AgentApproval>);
  await userEvent.click(screen.getByRole("button", { name: "No" }));
  expect(screen.getByRole("alert").textContent).toContain("Decision was not saved");
  expect(screen.getByText("Triage agent needs your okay")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "No" }));
  expect(decide).toHaveBeenNthCalledWith(2, "rejected");
});

it.each(["approved", "rejected", "expired"] as const)("removes actions from %s approvals", (status) => {
  render(<AgentApproval {...approval} status={status} onDecide={vi.fn()}>Create SP-42.</AgentApproval>);
  expect(screen.queryByRole("button", { name: "Yes" })).toBeNull();
  expect(screen.queryByRole("button", { name: "No" })).toBeNull();
});

it("isolates decision state when a request is replaced during a save", async () => {
  let reject!: (error: Error) => void;
  const pending = new Promise<void>((_resolve, fail) => { reject = fail; });
  const { rerender } = render(<AgentApproval {...approval} onDecide={() => pending}>Request A.</AgentApproval>);
  await userEvent.click(screen.getByRole("button", { name: "Yes" }));
  rerender(<AgentApproval {...approval} requestId="approval-new" onDecide={vi.fn()}>Request B.</AgentApproval>);
  expect((screen.getByRole("button", { name: "Yes" }) as HTMLButtonElement).disabled).toBe(false);
  await act(async () => { reject(new Error("Old request offline")); await pending.catch(() => {}); });
  expect(screen.queryByRole("alert")).toBeNull();
});

it("uses action-specific approval labels and destructive styling", () => {
  render(<AgentApproval {...approval} approveLabel="Delete issue" rejectLabel="Keep issue"
    tools={[{ name: "issues.delete", displayName: "Delete issue", isDestructive: true }]} onDecide={vi.fn()}>Remove one issue.</AgentApproval>);
  expect(screen.getByText("Triage agent needs your okay")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Delete issue" }).className).toContain("sp-button--danger");
  expect(screen.getByRole("button", { name: "Keep issue" })).toBeTruthy();
  expect(screen.queryByText("approval-42")).toBeNull();
});
