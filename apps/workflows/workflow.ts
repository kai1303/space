import {
  ApplicationFailure, condition, defineUpdate, proxyActivities, setHandler, workflowInfo
} from "@temporalio/workflow";
import type { createMailbox } from "./mailbox";
import type { Binding, RequestInput, Template } from "./template";

const activities = proxyActivities<Pick<ReturnType<typeof createMailbox>, "postMessageV1">>({
  startToCloseTimeout: "10 seconds", retry: { maximumAttempts: 3 }
});
const registry = { "space.message.post@1": activities.postMessageV1 };
export const claimRequest = defineUpdate<string, [string]>("claimRequest");

export async function runTemplate(plan: Template, input: RequestInput) {
  let readyForClaim = false;
  let claimant: string | undefined;
  setHandler(claimRequest, async (name) => {
    await condition(() => readyForClaim);
    claimant ??= name;
    return claimant;
  }, { validator: name => {
    if (typeof name !== "string" || !name.trim()) throw ApplicationFailure.nonRetryable("Enter a claimant name");
  } });

  function resolve(binding: Binding): string {
    if ("literal" in binding) return binding.literal;
    const value = binding.from === "claimant" ? claimant : input[binding.from];
    if (value === undefined) throw ApplicationFailure.nonRetryable("Missing input: " + binding.from);
    return (binding.prefix ?? "") + value;
  }

  const posted: string[] = [];
  const visited = new Set<string>();
  let id: string | undefined = plan.entry;
  while (id !== undefined) {
    const step: Template["steps"][string] | undefined = plan.steps[id];
    if (!step || visited.has(id)) throw ApplicationFailure.nonRetryable("Invalid template at " + id);
    visited.add(id);
    switch (step.type) {
      case "ifUrgent":
        id = step[input.urgency];
        break;
      case "claim":
        readyForClaim = true;
        await condition(() => claimant !== undefined);
        id = step.next;
        break;
      case "space.message.post@1": {
        const message = await registry[step.type]({
          key: workflowInfo().workflowId + "/" + id,
          destination: resolve(step.destination), text: resolve(step.text)
        });
        posted.push(message.messageId);
        id = step.next;
        break;
      }
      default:
        throw ApplicationFailure.nonRetryable("Unknown step at " + id);
    }
  }
  return { version: plan.version, claimant, posted };
}
