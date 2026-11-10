import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { createMailbox } from "./mailbox";
import { helpRequest } from "./template";
import { claimRequest, runTemplate } from "./workflow";

test("routes requests independently and resumes the matching claim after a worker restart", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "space-requests-"));
  const mailbox = createMailbox(join(directory, "messages.sqlite"));
  const cli = process.env.TEMPORAL_CLI_PATH ?? process.env.PATH?.split(delimiter)
    .map(dir => join(dir, "temporal")).find(path => existsSync(path));
  const env = await TestWorkflowEnvironment.createLocal({
    server: cli ? { executable: { type: "existing-path", path: cli } } : {}
  });
  try {
    const taskQueue = "help-request-test";
    const createWorker = (postMessageV1 = mailbox.postMessageV1) => Worker.create({
      connection: env.nativeConnection, taskQueue, workflowsPath: require.resolve("./workflow"),
      activities: { postMessageV1 }
    });
    const start = (urgency: "urgent" | "normal", requester: string) =>
      env.client.workflow.start(runTemplate, {
        taskQueue, workflowId: requester,
        args: [helpRequest, { urgency, requester, description: "VPN is down" }]
      });
    const urgent = await start("urgent", "alice");
    const normal = await start("normal", "bob");
    const bothPosted = Promise.withResolvers<void>();
    const first = await createWorker(async input => {
      const result = await mailbox.postMessageV1(input);
      if (mailbox.list().length === 2) bothPosted.resolve();
      return result;
    });
    await first.runUntil(bothPosted.promise);
    assert.deepEqual(mailbox.list().map(m => m.destination).sort(), ["#help", "#on-call"]);

    const second = await createWorker();
    await second.runUntil(async () => {
      assert.equal(await urgent.executeUpdate(claimRequest, { args: ["sam"] }), "sam");
      await urgent.result();
      assert.equal((await normal.describe()).status.name, "RUNNING");
      assert.equal(await normal.executeUpdate(claimRequest, { args: ["lee"] }), "lee");
      await normal.result();
    });
    assert.deepEqual(mailbox.list().slice(2).map(m => [m.destination, m.text]), [
      ["alice", "Claimed by sam"], ["bob", "Claimed by lee"]
    ]);
  } finally {
    await env.teardown();
    mailbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("retrying a post returns the original message", async () => {
  const mailbox = createMailbox(":memory:");
  try {
    const input = { target: "channel" as const, workflowName: helpRequest.name, key: "request-1/post", destination: "#help", text: "VPN is down" };
    assert.deepEqual(await mailbox.postMessageV1(input), await mailbox.postMessageV1(input));
    assert.equal(mailbox.list().length, 1);
  } finally {
    mailbox.close();
  }
});
