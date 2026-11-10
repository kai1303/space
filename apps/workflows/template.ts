export interface RequestInput {
  requester: string;
  urgency: "normal" | "urgent";
  description: string;
}

type Binding = { literal: string } | { from: "description" | "requester" | "claimant"; prefix?: string };
type Step =
  | { type: "ifUrgent"; urgent: string; normal: string }
  | { type: "claim"; next: string }
  | { type: "space.message.post@1"; target?: "channel" | "person"; destination: Binding; text: Binding; next?: string };

export interface MessageInput {
  key: string;
  destination: string;
  target: "channel" | "person";
  text: string;
  workflowName: string;
}

export interface Template {
  name: string;
  version: number;
  entry: string;
  steps: Record<string, Step>;
}

// This trusted fixture is passed by value to Temporal when a run starts.
export const helpRequest: Template = {
  name: "IT Help Request",
  version: 1,
  entry: "route",
  steps: {
    route: { type: "ifUrgent", urgent: "escalate", normal: "triage" },
    escalate: {
      type: "space.message.post@1", destination: { literal: "#on-call" },
      text: { from: "description" }, next: "claim"
    },
    triage: {
      type: "space.message.post@1", destination: { literal: "#help" },
      text: { from: "description" }, next: "claim"
    },
    claim: { type: "claim", next: "notify" },
    notify: {
      type: "space.message.post@1", target: "person", destination: { from: "requester" },
      text: { from: "claimant", prefix: "Claimed by " }
    }
  }
};

export type { Binding };
export const taskQueue = "space-help-request-demo";

export function workerQueue(apiUrl: string | undefined) {
  return apiUrl ? "space-help-request-chat" : taskQueue;
}
