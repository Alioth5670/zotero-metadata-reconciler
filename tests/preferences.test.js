const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  try {
    const page = await browser.newPage();
    const base = path.resolve(__dirname, '../content');
    await page.setContent('<html><body></body></html>');
    await page.evaluate(() => {
      window.storeCalls = [];
      window.Zotero = { MetadataReconciler: {
        providerSettings: { serpKey: '' },
        async saveSerpApiKey(value) { window.storeCalls.push(value); this.providerSettings.serpKey = value; }
      } };
    });
    // Reproduce Zotero: script loads before the fragment, then a nonbubbling
    // synthetic load event is dispatched on the inserted root section.
    await page.addScriptTag({ path: path.join(base, 'preferences.js') });
    await page.evaluate(markup => {
      document.body.insertAdjacentHTML('beforeend', markup);
      const event = new Event('load');
      event.waitUntil = () => {};
      document.getElementById('metadata-provider-pane').dispatchEvent(event);
    }, fs.readFileSync(path.join(base, 'preferences.xhtml'), 'utf8'));
    assert.match(await page.locator('#metadata-serp-status').textContent(), /未配置/);
    await page.locator('#metadata-serp-key').fill('test-only-key');
    await page.locator('#metadata-serp-save').click();
    assert.match(await page.locator('#metadata-serp-status').textContent(), /已配置/);
    assert.equal(await page.locator('#metadata-serp-key').inputValue(), '');
    assert.deepEqual(await page.evaluate(() => window.storeCalls), ['test-only-key']);
    await page.locator('#metadata-serp-clear').click();
    assert.match(await page.locator('#metadata-serp-status').textContent(), /未配置/);
    assert.deepEqual(await page.evaluate(() => window.storeCalls), ['test-only-key', '']);
    console.log('Deferred settings fragment load, save and clear interaction passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
