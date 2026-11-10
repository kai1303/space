import { NativeConnection, Worker } from "@temporalio/worker";
import { createMailbox } from "./mailbox";
import { taskQueue } from "./template";

async function main() {
  const connection = await NativeConnection.connect({ address: process.env.TEMPORAL_ADDRESS });
  const mailbox = createMailbox(process.env.WORKFLOW_DEMO_DB ?? "workflow-demo.sqlite");
  try {
    const worker = await Worker.create({
      connection, taskQueue, workflowsPath: require.resolve("./workflow"),
      activities: { postMessageV1: mailbox.postMessageV1 }
    });
    await worker.run();
  } finally {
    mailbox.close();
    await connection.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
