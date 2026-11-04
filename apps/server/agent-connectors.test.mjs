import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultPairedConnectors } from '@space/contracts';
import { configuredAgentConnectors } from './dist/agent-connectors.js';

const cloud = { id: 'research.cloud', definition_id: '9a13aa4d-d380-4284-a6c8-03bf0c1c6634', name: 'Research', capabilities: { skills: ['research.run'], controls: { progress_stream: true }, persistent_sessions: true } };
test('preserves local providers and adds a trusted cloud connector', () => {
  assert.deepEqual(configuredAgentConnectors(), defaultPairedConnectors);
  assert.deepEqual(configuredAgentConnectors(''), defaultPairedConnectors);
  assert.deepEqual(configuredAgentConnectors(JSON.stringify([cloud])), [...defaultPairedConnectors, cloud]);
});
test('rejects malformed, oversized, conflicting and provider-impersonating configuration', () => {
  for (const value of ['{', '{}', 'x'.repeat(65_537), JSON.stringify(Array(99).fill(cloud)),
    JSON.stringify([cloud, cloud]), JSON.stringify([{ ...cloud, id: 'codex.local' }]),
    JSON.stringify([{ ...cloud, definition_id: defaultPairedConnectors[0].definition_id }]),
    JSON.stringify([{ ...cloud, provider: 'codex' }]), JSON.stringify([{ ...cloud, url: 'https://example.test' }]),
    JSON.stringify([{ ...cloud, id: '../cloud' }]), JSON.stringify([{ ...cloud, capabilities: { skills: [], controls: {} } }]),
  ]) assert.throws(() => configuredAgentConnectors(value), /Invalid SPACE_CLOUD_CONNECTORS/);
});
