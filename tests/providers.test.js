const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  try {
    const page = await browser.newPage();
    const content = path.resolve(__dirname, '../content');
    for (const file of ['core.js', 'providers.js', 'reconciler.js']) await page.addScriptTag({ path: path.join(content, file) });
    const result = await page.evaluate(async () => {
      const api = window.MetadataReconciler;
      window.Zotero = { getMainWindow: () => window, Translate: {} };
      const title = 'Example segmentation method';
      let wroteLibrary = false;
      Zotero.Translate.Import = class {
        setString(text) { if (!text.includes('@inproceedings')) throw new Error('Expected BibTeX'); }
        async getTranslators() { return [{}]; }
        setTranslator() {}
        setHandler(name, callback) { this.callback = callback; }
        async translate(options) {
          if (options.libraryID !== false) wroteLibrary = true;
          this.callback(null, { itemType: 'conferencePaper', title, date: '2025', proceedingsTitle: 'An actual conference', creators: [{ firstName: 'Mengcheng', lastName: 'Lan', creatorType: 'author' }] });
        }
      };
      api.configureSerpApi('TEST-KEY-NOT-A-CREDENTIAL');
      const calls = [];
      api.httpRequest = async url => {
        const params = new URL(url).searchParams;
        if (params.get('api_key') !== 'TEST-KEY-NOT-A-CREDENTIAL') throw new Error('Missing key');
        calls.push({ engine: params.get('engine'), cluster: params.get('cluster'), q: params.get('q') });
        if (params.get('engine') === 'google_scholar_cite') return { response: { links: [{ name: 'BibTeX', link: 'https://scholar.googleusercontent.com/scholar.bib?q=sample' }] } };
        if (params.has('cluster')) return { response: { organic_results: [
          { title, result_id: 'published', link: 'https://publisher.example/paper', publication_info: { authors: [{ name: 'Mengcheng Lan' }], summary: 'M Lan - A conference, 2025' } },
          { title: 'Unrelated title', result_id: 'wrong', link: 'https://other.example/' }
        ] } };
        return { response: { organic_results: [{ title, result_id: 'preprint', link: 'https://arxiv.org/abs/2410.09855', inline_links: { versions: { cluster_id: '12345678901234567890' } } }] } };
      };
      api.requestText = async () => '@inproceedings{example,title={Example segmentation method}}';
      const candidates = [];
      await api.findScholarVersions({ title }, candidate => candidates.push(candidate));
      const versionsCall = calls.find(call => call.cluster);
      const stopCalls = calls.length;
      await api.findScholarVersions({ title }, () => {}, () => true);
      const extraCallsAfterStop = calls.length - stopCalls;
      const xml = `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom"><entry>
        <id>http://arxiv.org/abs/2410.09855v3</id><title>Example segmentation method</title><published>2024-10-13T00:00:00Z</published>
        <author><name>Mengcheng Lan</name></author><arxiv:doi>10.1000/published</arxiv:doi><arxiv:journal_ref>Conference 2025</arxiv:journal_ref>
      </entry></feed>`;
      const arxiv = api.parseArxiv(xml)[0];
      api.httpRequest = async () => { throw new Error('request with api_key=TEST-KEY-NOT-A-CREDENTIAL failed'); };
      let safeError = '';
      try { await api.serpRequest({ engine: 'google_scholar', q: title }); } catch (error) { safeError = error.message; }
      api.configureSerpApi('');
      return { calls, versionsCall, candidates, wroteLibrary, arxiv, safeError, extraCallsAfterStop,
        id: api.arxivID({ DOI: '10.48550/arXiv.2410.09855' }), disabled: api.providerSettings.serpKey === '' };
    });
    assert.equal(result.versionsCall.cluster, '12345678901234567890');
    assert.equal(result.versionsCall.q, null, 'Cluster searches cannot include a title query');
    assert.ok(result.candidates.some(candidate => candidate.externalType === 'conference-paper'));
    assert.ok(!result.candidates.some(candidate => candidate.title === 'Unrelated title'));
    assert.ok(result.calls.length <= 4);
    assert.equal(result.wroteLibrary, false);
    assert.equal(result.arxiv.externalType, 'preprint', 'Journal references are discovery clues, not type changes');
    assert.equal(result.arxiv.DOI, '10.48550/arXiv.2410.09855');
    assert.deepEqual(result.arxiv.relatedDOIs, ['10.1000/published']);
    assert.equal(result.arxiv.firstAuthor, 'Lan');
    assert.equal(result.id, '2410.09855');
    assert.equal(result.safeError.includes('TEST-KEY'), false);
    assert.equal(result.disabled, true);
    assert.equal(result.extraCallsAfterStop, 0, 'After deadline no additional paid requests may start');
    const recovery = await page.evaluate(async () => {
      const api = window.MetadataReconciler;
      api.configureSerpApi('TEST-KEY-NOT-A-CREDENTIAL');
      const title = 'CodeDance: A Dynamic Tool-integrated MLLM for Executable Visual Reasoning';
      const records = [
        { title, result_id: 'blocked', link: 'https://blocked.example/article', publication_info: { summary: 'Proceedings of a conference, 2026' } },
        { title, result_id: 'formal', link: 'https://publisher.example/article', publication_info: { summary: 'Proceedings of a conference, 2026' } }
      ];
      api.serpRequest = async () => ({ organic_results: records });
      const visited = [];
      api.requestText = async url => {
        visited.push(url);
        if (url.includes('blocked.example')) throw Object.assign(new Error('403 <html>huge blocked page</html>'), { status: 403 });
        return `<html><head>
          <meta name="citation_title" content="${title}">
          <meta name="citation_conference_title" content="Proceedings of a conference">
          <meta name="citation_author" content="Song, Qi">
          <meta name="citation_publication_date" content="2026">
          <meta name="citation_firstpage" content="19186"><meta name="citation_lastpage" content="19195">
        </head></html>`;
      };
      let citeCalls = 0;
      api.importScholarBibtex = async () => { citeCalls++; throw new Error('Must not need export for structured metadata'); };
      const candidates = [], warnings = [];
      await api.findScholarVersions({ title }, item => candidates.push(item), () => false, message => warnings.push(message));
      api.requestText = async () => '<html><head><meta name="citation_title" content="Segment Where You Look"><meta name="citation_author" content="Eslam Abdelrahman"><meta name="citation_date" content="2026/10/13"></head></html>';
      const preprint = await api.scholarLandingMetadata({ title: 'Segment Where You Look', link: 'https://arxiv.org/abs/2610.18729' });
      const repository = await api.scholarLandingMetadata({ title: 'Segment Where You Look', link: 'https://repository.example/paper' });
      return { candidates, warnings, citeCalls, visited, preprint, repository };
    });
    assert.ok(recovery.candidates.some(candidate => candidate.externalType === 'conference-paper' && candidate.firstAuthor === 'Song'));
    assert.equal(recovery.citeCalls, 0);
    assert.deepEqual(recovery.warnings, []);
    assert.ok(recovery.visited.includes('https://blocked.example/article'));
    assert.ok(recovery.visited.includes('https://publisher.example/article'));
    assert.equal(recovery.preprint.externalType, 'preprint');
    assert.equal(recovery.preprint.DOI, '10.48550/arXiv.2610.18729');
    assert.equal(recovery.preprint.containerTitle, 'arXiv');
    assert.equal(recovery.repository, null, 'Repository alone must not imply a published type');
    const browserCheck = await page.evaluate(async () => {
      const api = window.MetadataReconciler;
      const title = "From words to pixels: A comprehensive survey on large language models in visual segmentation";
      let destroyed = 0;
      const visited = [];
      window.ChromeUtils = { importESModule: () => ({ HiddenBrowser: class {
        async load(url) { visited.push(url); this.currentURI = { spec: url }; return true; }
        async getPageData() {
          const cluster = this.currentURI.spec.includes("cluster=");
          return { documentHTML: '<div class="gs_ri"><h3 class="gs_rt"><a href="https://publisher.example/'
            + (cluster ? 'published' : 'preprint') + '">' + title + '</a></h3><div class="gs_a">A Author - 2025</div>'
            + '<div class="gs_fl"><a href="/scholar?cites=123">被引用次数：1</a><a href="/scholar?cluster=12345678901234567890">所有 2 个版本</a></div></div>' };
        }
        destroy() { destroyed++; }
      } }) };
      const records = await api.browserScholarRecords({ title }, () => false);
      let challenge = false;
      try { api.parseScholarPage('<form action="/sorry/index"></form>', 'https://scholar.google.com/scholar?q=test'); }
      catch (_) { challenge = true; }
      return { records, visited, destroyed, challenge };
    });
    assert.equal(browserCheck.records.length, 2);
    assert.equal(browserCheck.destroyed, 1);
    assert.equal(browserCheck.challenge, true);
    assert.ok(browserCheck.visited[1].includes('cluster=12345678901234567890'));
    console.log('Hidden browser search, versions and cleanup passed');
    console.log('Blocked version isolation and generic publisher metadata recovery passed');
    console.log('SerpApi search/cluster/cite, no-save import, key redaction and arXiv Atom parsing passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
