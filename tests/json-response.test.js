const assert = require('node:assert/strict');
require('../content/reconciler.js');

(async () => {
  let responseTextReads = 0;
  let payload = null;
  global.Zotero = { HTTP: { request: async (method, url, options) => {
    assert.equal(options.responseType, 'json');
    return {
      response: payload,
      get responseText() {
        responseTextReads++;
        throw new Error('responseText is not available for JSON');
      }
    };
  } } };
  assert.equal(await global.MetadataReconciler.requestJSON('https://example.org/test'), null);
  payload = { result: { hits: { hit: [] } } };
  assert.deepEqual(await global.MetadataReconciler.requestJSON('https://example.org/test'), payload);
  assert.equal(responseTextReads, 0);
  console.log('Gecko JSON null and populated response tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
