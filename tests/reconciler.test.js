const assert = require("node:assert/strict");
global.MetadataReconcilerCore = require("../content/core.js");
require("../content/reconciler.js");

const pdf = "openaccess.thecvf.com/content/CVPR2025/papers/Qian_Reasoning_to_Attend_Try_to_Understand_How_SEG_Token_Works_CVPR_2025_paper.pdf#page=7.22";
assert.equal(
  global.MetadataReconciler.cvfLandingURL(pdf),
  "https://openaccess.thecvf.com/content/CVPR2025/html/Qian_Reasoning_to_Attend_Try_to_Understand_How_SEG_Token_Works_CVPR_2025_paper.html"
);
assert.equal(global.MetadataReconciler.cvfLandingURL("https://arxiv.org/pdf/1234.5678"), "");
const indexes = global.MetadataReconciler.cvfIndexURLs({ date: "2025-06" });
assert.ok(indexes.some((entry) => entry.url === "https://openaccess.thecvf.com/CVPR2025?day=all"));
assert.ok(indexes.some((entry) => entry.url === "https://openaccess.thecvf.com/ICCV2025?day=all"));
assert.ok(indexes.some((entry) => entry.url === "https://openaccess.thecvf.com/CVPR2026?day=all"));
console.log("reconciler URL tests passed");

(async () => {
  const controller = global.MetadataReconciler;
  controller.findICLRByTitle = async () => null;
  const originalFallback = controller.findTitleFallbackCandidates;
  const calls = [];
  controller.requestJSON = async url => {
    calls.push(url);
    if (url.includes('crossref.org')) return { message: {
      title: ['A segmentation method'], DOI: '10.48550/arXiv.2501.12345', type: 'posted-content',
      author: [{ family: 'Qian' }], issued: { 'date-parts': [[2025]] }
    } };
    return { title: 'A segmentation method', doi: '10.48550/arXiv.2501.12345', type: 'preprint' };
  };
  controller.findCVFByTitle = async () => null;
  let searchedByTitle = false;
  controller.findTitleFallbackCandidates = async () => {
    searchedByTitle = true;
    return { candidates: [{ title: 'A segmentation method', DOI: '10.1109/CVPR.2026.123', firstAuthor: 'Qian', date: '2026', externalType: 'conference-paper' }], errors: [] };
  };
  const results = await controller.findCandidates({ title: 'A segmentation method', DOI: '10.48550/arXiv.2501.12345', itemType: 'preprint', firstAuthor: 'Qian', date: '2025' });
  assert.equal(searchedByTitle, true);
  assert.equal(results.candidates[0].targetType, 'conferencePaper');
  assert.equal(results.candidates[0].score, 0.89);
  assert.ok(results.candidates[0].versionLabel.includes('不同 DOI'));
  assert.ok(results.candidates.some(candidate => candidate.targetType === 'preprint'));
  assert.equal(calls.some(url => url.includes('crossref.org/works/10.48550')), false);
  controller.findTitleFallbackCandidates = originalFallback;
  controller.requestJSON = async () => null;
  const empty = await controller.findTitleFallbackCandidates({ title: 'Empty responses' });
  assert.deepEqual(empty, { candidates: [], errors: [] });
  controller.requestJSON = async url => url.includes('dblp.org') ? {
    result: { hits: { hit: { info: { title: 'Single result', type: 'Conference and Workshop Papers', year: '2025' } } } }
  } : null;
  const single = await controller.findTitleFallbackCandidates({ title: 'Single result' });
  assert.equal(single.candidates.length, 1);
  assert.equal(single.candidates[0].source, 'DBLP');
  assert.deepEqual(single.errors, []);
  console.log('published-version discovery passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
