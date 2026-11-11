const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  try {
    const page = await browser.newPage();
    const content = path.resolve(__dirname, '../content');
    await page.setContent(fs.readFileSync(path.join(content, 'review.xhtml'), 'utf8').replace(/<script[^>]*>[\s\S]*?<\/script>/, ''));
    await page.evaluate(() => {
      // Reproduce privileged-document sanitization: text remains, buttons vanish.
      const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
      Object.defineProperty(Element.prototype, 'innerHTML', {
        get: descriptor.get,
        set(value) {
          descriptor.set.call(this, value);
          this.querySelectorAll('button').forEach(node => node.remove());
        }
      });
      window.savedSelections = [];
      window.scholarURL = '';
      window.arguments = [{
        itemIDs: [1],
        controller: {
          openExternalURL: url => { window.scholarURL = url; },
          analyze: async () => [{
            summary: { id: 1, title: 'Example', itemType: 'journalArticle', key: 'TEST' },
            candidates: [{
              source: 'Test source', title: 'Example', score: 0.88,
              targetType: 'conferencePaper',
              changes: [
                { field: 'itemType', before: 'journalArticle', after: 'conferencePaper' },
                { field: 'date', before: '', after: '2025' }
              ]
            }], errors: []
          }],
          applySelections: async selections => {
            window.savedSelections = selections;
            return { applied: 1, changedFields: selections[0].changes.length };
          }
        }
      }];
    });
    await page.addScriptTag({ path: path.join(content, 'review.js') });
    await page.evaluate(() => window.dispatchEvent(new Event('DOMContentLoaded')));
    await page.waitForSelector('.candidate-select');
    assert.equal(await page.locator('.field-toggle').count(), 2);
    await page.locator('.scholar-search').click();
    assert.equal(await page.evaluate(() => window.scholarURL), 'https://scholar.google.com/scholar?q=%22Example%22');
    assert.equal(await page.locator('#apply').isDisabled(), true);
    await page.locator('.candidate-select').click();
    assert.equal(await page.locator('#apply').isEnabled(), true);
    await page.locator('.field-toggle[data-field="date"]').click();
    await page.locator('#apply').click();
    const selections = await page.evaluate(() => window.savedSelections);
    assert.equal(selections.length, 1);
    assert.equal(selections[0].changes.length, 1);
    assert.equal(selections[0].changes[0].field, 'itemType');
    console.log('review interaction passed with sanitized HTML');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
