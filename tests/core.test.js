const assert = require("node:assert/strict");
const core = require("../content/core.js");

assert.equal(core.cleanDOI("https://doi.org/10.1109/CVPR.2016.90"), "10.1109/cvpr.2016.90");
assert.ok(core.titleSimilarity("Deep Residual Learning for Image Recognition", "Deep residual learning for image recognition") > 0.99);

const crossref = core.crossrefToCandidate({
  type: "proceedings-article",
  title: ["Deep Residual Learning for Image Recognition"],
  DOI: "10.1109/CVPR.2016.90",
  "container-title": ["2016 IEEE Conference on Computer Vision and Pattern Recognition (CVPR)"],
  author: [{ given: "Kaiming", family: "He" }],
  issued: { "date-parts": [[2016, 6]] },
  page: "770-778"
});
assert.equal(core.inferType(crossref), "conferencePaper");
assert.equal(core.scoreCandidate({ title: crossref.title, DOI: crossref.DOI }, crossref), 1);

const proposal = core.buildChanges({
  title: crossref.title,
  DOI: crossref.DOI,
  date: "2016",
  proceedingsTitle: "",
  conferenceName: "",
  pages: "",
  itemType: "preprint"
}, crossref, "preprint");
assert.equal(proposal.targetType, "conferencePaper");
assert.ok(proposal.changes.some((change) => change.field === "itemType"));
assert.ok(proposal.changes.some((change) => change.field === "proceedingsTitle"));

const ambiguous = { title: "Unrelated title", date: "2011", DOI: "" };
assert.ok(core.scoreCandidate({ title: "A specific paper", date: "2020" }, ambiguous) < 0.82);

const dblp = core.dblpToCandidate({
  type: "Conference and Workshop Papers",
  title: "Reasoning to Attend: Try to Understand How <SEG> Token Works",
  authors: { author: [{ text: "Rui Qian" }, { text: "Xin Yin" }] },
  venue: "CVPR",
  year: "2025",
  pages: "24722-24731"
});
assert.equal(core.inferType(dblp), "conferencePaper");
assert.equal(dblp.firstAuthor, "Qian");

const semantics = core.semanticScholarToCandidate({
  title: dblp.title,
  authors: [{ name: "Rui Qian" }],
  year: 2025,
  venue: "CVPR",
  publicationTypes: ["Conference"],
  externalIds: {}
});
assert.equal(core.inferType(semantics), "conferencePaper");

console.log("core tests passed");

const preprintItem = { title: 'A segmentation method', DOI: '10.48550/arXiv.2501.12345', firstAuthor: 'Qian', date: '2025', itemType: 'preprint' };
const publishedVersion = { title: preprintItem.title, DOI: '10.1109/CVPR.2026.123', firstAuthor: 'Qian', date: '2026', externalType: 'proceedings-article' };
assert.equal(core.scoreCandidate(preprintItem, publishedVersion), 0.89);
assert.equal(core.scoreCandidate({ ...preprintItem, date: '2024' }, { ...publishedVersion, DOI: '', date: '2025', requiresReview: true }), 0.89);
assert.equal(core.scoreCandidate(preprintItem, { ...publishedVersion, firstAuthor: 'Smith' }), 0);
assert.equal(core.scoreCandidate(preprintItem, { ...publishedVersion, title: 'An unrelated paper' }), 0);
assert.equal(core.scoreCandidate({ ...preprintItem, DOI: '10.1000/journal.1', itemType: 'journalArticle' }, publishedVersion), 0);
