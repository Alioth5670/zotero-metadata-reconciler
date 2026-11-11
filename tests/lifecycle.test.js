const assert = require('node:assert/strict');
require('../content/reconciler.js');

(async () => {
  const root = global.MetadataReconciler;
  let focused = 0;
  root.reviewWindow = { closed: false, focus() { focused++; } };
  root.openReview({});
  assert.equal(focused, 1, 'An existing review must be reused');
  root.reviewWindow = null;
  const session = Object.create(root);
  session.cancelled = false;
  session.requests = new Set();
  let active = 0;
  let peak = 0;
  let started = 0;
  let aborted = 0;
  const finish = [];
  global.Zotero = { HTTP: { request: (method, url, options) => new Promise((resolve, reject) => {
    active++;
    started++;
    peak = Math.max(peak, active);
    finish.push(() => {
      active--;
      resolve({ response: {} });
    });
    if (options.cancellerReceiver) options.cancellerReceiver(() => {
      active--;
      aborted++;
      reject(new Error('aborted'));
    });
  }) } };
  const requests = Array.from({ length: 15 }, (_, index) => session.httpRequest(`https://example.org/${index}`, {}));
  const settled = Promise.allSettled(requests);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(peak, 4);
  assert.equal(root.network.queue.length, 11);
  session.cancelQueries();
  assert.equal(aborted, 0, 'Closing must never abort native requests during teardown');
  assert.equal(root.network.queue.length, 0);
  finish.forEach(resolve => resolve());
  const outcomes = await settled;
  assert.equal(started, 4, 'Cancelled queued requests must never start');
  assert.equal(aborted, 0);
  assert.equal(root.network.active, 0);
  assert.equal(root.network.queue.length, 0);
  assert.equal(session.requests.size, 0);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 4);
  assert.equal(outcomes.filter(result => result.status === 'rejected').length, 11);
  console.log('window reuse, request limit and safe close without native abort passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
