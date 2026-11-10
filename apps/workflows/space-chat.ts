import { ApplicationFailure } from "@temporalio/activity";
import type { MessageInput } from "./template";

export function spaceChatActivities(apiUrl: string, token: string) {
  const url = new URL("/v1/workflow-messages", apiUrl);
  return {
    async postMessageV1(input: MessageInput) {
      const response = await fetch(url, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(8_000),
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify(input)
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        const reason = "Space message delivery failed (" + response.status + "): " + (body.error ?? "unknown");
        if (response.status < 500 && response.status !== 408 && response.status !== 429 && body.error !== "session_conflict") {
          throw ApplicationFailure.nonRetryable(reason);
        }
        throw new Error(reason);
      }
      const message = await response.json() as { id: string };
      return { messageId: message.id };
    }
  };
}
