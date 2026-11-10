const test = require('node:test');
const assert = require('node:assert/strict');
const { runBrowserTask } = require('../src/browser/agent.cjs');

for (const change of ['takeover', 'navigation']) {
  test('an outstanding model response loses permission after ' + change, async () => {
    const controller = new AbortController();
    let url = 'https://reports.example/quarter', reads = 0;
    const contents = {
      getURL: () => url, isDestroyed: () => false, isLoadingMainFrame: () => false,
      executeJavaScriptInIsolatedWorld: async () => {
        assert.equal(++reads, 1, 'a late response must never reach the page');
        return { token: 'sample', controls: [] };
      },
    };
    const started = Promise.withResolvers(), decision = Promise.withResolvers();
    const task = runBrowserTask(contents, 'Inspect Q2', controller.signal, () => { started.resolve(); return decision.promise; });
    await started.promise;
    if (change === 'takeover') controller.abort();
    else url = 'https://accounts.example/login';
    decision.resolve({ type: 'scroll', direction: 'down' });
    await assert.rejects(task, change === 'takeover' ? /abort/i : /page changed/i);
    assert.equal(reads, 1);
  });
}
