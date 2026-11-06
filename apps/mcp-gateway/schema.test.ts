import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateArguments } from './schema.js';
test('untrusted tool schemas enforce arguments and fail closed on invalid schema', async () => {
  const signal = new AbortController().signal,
    schema = {
      type: 'object',
      properties: { count: { type: 'integer', minimum: 1 } },
      required: ['count'],
      additionalProperties: false,
    };
  await validateArguments(schema, { count: 1 }, signal);
  await assert.rejects(validateArguments(schema, { count: 0 }, signal), /invalid_tool_arguments/);
  await assert.rejects(
    validateArguments({ type: 'object', properties: { x: { type: 'invalid' } } }, {}, signal),
    /invalid_tool_arguments/,
  );
  await assert.rejects(validateArguments({ $ref: 'https://example.com/schema' }, {}, signal), /invalid_tool_arguments/);
});
test('pathological schema regex has a deadline outside the event loop', async () => {
  const started = Date.now();
  await assert.rejects(
    validateArguments(
      { type: 'object', properties: { text: { type: 'string', pattern: '^(a+)+$' } } },
      { text: 'a'.repeat(35) + '!' },
      new AbortController().signal,
    ),
    /invalid_tool_arguments/,
  );
  assert.ok(Date.now() - started < 5000);
});
test('argument validation respects cancellation', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(validateArguments({ type: 'object' }, {}, controller.signal));
});
