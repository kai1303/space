import { NativeConnection, Worker } from "@temporalio/worker";
import { createMailbox } from "./mailbox";
import { spaceChatActivities } from "./space-chat";
import { workerQueue } from "./template";

async function main() {
  const apiUrl = process.env.SPACE_WORKFLOW_API_URL, token = process.env.SPACE_WORKFLOW_TOKEN;
  if (!!apiUrl !== !!token) throw new Error("Set both SPACE_WORKFLOW_API_URL and SPACE_WORKFLOW_TOKEN for Space chat");
  const connection = await NativeConnection.connect({ address: process.env.TEMPORAL_ADDRESS });
  const mailbox = apiUrl ? undefined : createMailbox(process.env.WORKFLOW_DEMO_DB ?? "workflow-demo.sqlite");
  try {
    const worker = await Worker.create({
      connection, taskQueue: workerQueue(apiUrl), workflowsPath: require.resolve("./workflow"),
      activities: mailbox ? { postMessageV1: mailbox.postMessageV1 } : spaceChatActivities(apiUrl!, token!)
    });
    await worker.run();
  } finally {
    mailbox?.close();
    await connection.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
