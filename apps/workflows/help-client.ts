import { Client, Connection, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { helpRequest, type RequestInput } from './template';

export function helpWorkflowClient(address?: string) {
  let pending: Promise<Connection> | undefined;
  return {
    async start(id: string, name: string, channel: string, input: RequestInput) {
      pending ??= Connection.connect({ address, connectTimeout: 3000 }).catch(error => {
        pending = undefined;
        throw error;
      });
      const connection = await pending;
      const plan = structuredClone(helpRequest);
      plan.name = name;
      const post = plan.steps[input.urgency === 'urgent' ? 'escalate' : 'triage'];
      if (post?.type !== 'space.message.post@1') throw new Error('Missing help request posting step');
      post.destination = { literal: channel };
      try {
        await connection.withDeadline(Date.now() + 5000, () =>
          new Client({ connection }).workflow.start('runTemplate', {
            workflowId: id, workflowIdReusePolicy: 'REJECT_DUPLICATE',
            taskQueue: 'space-help-request-chat', args: [plan, input],
          }));
      } catch (error) {
        if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
      }
    },
    async close() { await (await pending)?.close(); },
  };
}
