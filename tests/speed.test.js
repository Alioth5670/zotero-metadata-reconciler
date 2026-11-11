const assert = require('node:assert/strict');
global.MetadataReconcilerCore = require('../content/core.js');
require('../content/reconciler.js');

(async () => {
  const controller = global.MetadataReconciler;
  controller.findICLRByTitle = async () => null;
  controller.LOOKUP_BUDGET_MS = 60;
  const summary = { title: 'Example segmentation paper', date: '2025', DOI: '10.48550/arxiv.2501.12345', firstAuthor: 'Qian', itemType: 'preprint' };
  let doiStarted = false;
  controller.requestJSON = async () => { doiStarted = true; return new Promise(() => {}); };
  controller.findCVFByTitle = async () => new Promise(() => {});
  controller.findTitleFallbackCandidates = async (item, notify) => {
    assert.equal(doiStarted, true);
    notify({ candidates: [{ title: item.title, date: '2025', externalType: 'conference-paper', firstAuthor: 'Qian' }], errors: [] });
    return { candidates: [], errors: [], streamed: true };
  };
  let shownBeforeReturn = false;
  const start = Date.now();
  const result = await controller.findCandidates(summary, partial => {
    if (partial.candidates.length) shownBeforeReturn = true;
  });
  assert.equal(shownBeforeReturn, true);
  assert.equal(result.candidates[0].targetType, 'conferencePaper');
  assert.ok(result.errors.some(error => error.includes('快速查询时限')));
  assert.ok(Date.now() - start < 1500, 'A stalled source must not hold the lookup');
  assert.equal(controller.lookupCache.size, 0, 'Incomplete searches must not be cached');
  console.log('parallel discovery, partial delivery and deadline passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
