import { randomUUID } from "node:crypto";
import { Client, Connection } from "@temporalio/client";
import { helpRequest, workerQueue } from "./template";
import { claimRequest, runTemplate } from "./workflow";

async function main() {
  const [command, first, second, third] = process.argv.slice(2);
  const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS });
  const { workflow } = new Client({ connection });
  try {
    if (command === "start" && (first === "normal" || first === "urgent") && second && third) {
      if (process.env.SPACE_WORKFLOW_API_URL && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(second)) {
        throw new Error("Use the requester’s Space user UUID for chat delivery");
      }
      const handle = await workflow.start(runTemplate, {
        taskQueue: workerQueue(process.env.SPACE_WORKFLOW_API_URL), workflowId: "help-" + randomUUID(),
        args: [helpRequest, { urgency: first, requester: second, description: third }]
      });
      console.log(handle.workflowId);
    } else if (command === "claim" && first && second?.trim()) {
      const handle = workflow.getHandle<typeof runTemplate>(first);
      console.log("Claimed by", await handle.executeUpdate(claimRequest, { args: [second] }));
      console.log(await handle.result());
    } else {
      throw new Error("Use start <urgent|normal> <requester> <description> or claim <workflow-id> <name>");
    }
  } finally {
    await connection.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
