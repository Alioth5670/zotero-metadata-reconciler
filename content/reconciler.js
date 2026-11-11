MetadataReconciler = {
  ...(typeof MetadataReconcilerProviders !== "undefined" ? MetadataReconcilerProviders : {}),
  id: null,
  version: null,
  rootURI: null,
  addedElementIDs: [],
  textCache: new Map(),
  lookupCache: new Map(),
  reviewWindow: null,
  reviewController: null,
  network: { active: 0, queue: [] },
  cancelled: false,
  requests: new Set(),
  LOOKUP_BUDGET_MS: 7500,
  PREF_BACKUPS: "extensions.metadata-reconciler.backups",

  openExternalURL(url) {
    if (/^https:\/\/scholar\.google\.com\/scholar\?q=/.test(url)) Zotero.launchURL(url);
  },

  async init({ id, version, rootURI }) {
    this.id = id;
    this.version = version;
    this.rootURI = rootURI;
    Zotero.MetadataReconciler = this;
    if (this.loadSerpApiKey) {
      try { await this.loadSerpApiKey(); }
      catch (_) { Zotero.debug("Metadata Reconciler: saved credential could not be loaded"); }
    }
  },

  addToWindow(window) {
    if (window.document.getElementById("metadata-reconciler-tools")) return;
    const addMenuItem = (parentID, id) => {
      const parent = window.document.getElementById(parentID);
      if (!parent) return;
      const item = window.document.createXULElement("menuitem");
      item.id = id;
      item.setAttribute("label", "核对文献类型与元数据…");
      item.addEventListener("command", () => this.openReview(window));
      parent.appendChild(item);
      this.addedElementIDs.push(id);
    };
    addMenuItem("menu_ToolsPopup", "metadata-reconciler-tools");
    addMenuItem("zotero-itemmenu", "metadata-reconciler-context");
  },

  addToAllWindows() {
    for (const window of Zotero.getMainWindows()) {
      if (window.ZoteroPane) this.addToWindow(window);
    }
  },

  removeFromWindow(window) {
    for (const id of this.addedElementIDs) window.document.getElementById(id)?.remove();
  },

  removeFromAllWindows() {
    for (const window of Zotero.getMainWindows()) this.removeFromWindow(window);
    this.addedElementIDs = [];
  },

  openReview(window) {
    if (this.reviewWindow && !this.reviewWindow.closed) {
      this.reviewWindow.focus();
      return;
    }
    const selectedItems = window.ZoteroPane.getSelectedItems();
    const items = [];
    const seen = new Set();
    for (const selected of selectedItems) {
      let item = selected;
      if (selected.isAttachment() && selected.parentID) {
        item = Zotero.Items.get(selected.parentID);
      }
      if ((item?.isRegularItem() || (item?.isAttachment() && !item.parentID)) && !seen.has(item.id)) {
        items.push(item);
        seen.add(item.id);
      }
    }
    if (!items.length) {
      window.alert("请选择普通文献，或选择标题/URL 指向公开论文页的独立附件。");
      return;
    }
    const session = Object.create(this);
    session.cancelled = false;
    session.requests = new Set();
    this.reviewController = session;
    this.reviewWindow = window.openDialog(
      "chrome://metadata-reconciler/content/review.xhtml",
      "metadata-reconciler-review",
      "chrome,centerscreen,resizable,dialog=no,width=1100,height=760",
      { controller: session, itemIDs: items.map((item) => item.id) }
    );
  },

  cancelQueries() {
    this.cancelled = true;
    for (const entry of this.network.queue.slice()) {
      if (entry.owner === this) {
        this.network.queue.splice(this.network.queue.indexOf(entry), 1);
        entry.reject(new Error("查询已停止"));
      }
    }
    // Never abort Gecko XHRs while the dialog is being destroyed. Active
    // requests finish or hit their existing 6s timeout; no new work may start.
  },

  dispose() {
    delete Zotero.MetadataReconciler;
    if (this.providerSettings) this.providerSettings.serpKey = "";
    this.reviewController?.cancelQueries();
    if (this.reviewWindow && !this.reviewWindow.closed) this.reviewWindow.close();
    this.reviewWindow = null;
    this.reviewController = null;
    this.textCache.clear();
    this.lookupCache.clear();
  },

  async httpRequest(url, options) {
    if (this.cancelled || options.shouldStop?.()) throw new Error("查询已停止");
    await new Promise((resolve, reject) => {
      const entry = { owner: this, reject, start: () => {
        this.network.active++;
        resolve();
      } };
      if (this.network.active < 4) entry.start();
      else this.network.queue.push(entry);
    });
    try {
      if (this.cancelled || options.shouldStop?.()) throw new Error("查询已停止");
      const { shouldStop, ...httpOptions } = options;
      return await Zotero.HTTP.request("GET", url, httpOptions);
    } finally {
      this.network.active--;
      this.network.queue.shift()?.start();
    }
  },

  itemSummary(item) {
    if (item.isAttachment()) {
      let url = "";
      try { url = item.getField("url") || ""; } catch (_) {}
      const title = item.getField("title") || "";
      return {
        id: item.id,
        key: item.key,
        itemType: "attachment",
        title,
        url: url || title,
        date: "",
        DOI: "",
        extra: "",
        firstAuthor: "",
        createParent: true,
        sourceAttachmentID: item.id
      };
    }
    const firstCreator = item.getCreators()[0];
    const fields = {};
    for (const field of ["title", "date", "DOI", "url", "extra", "publicationTitle",
      "proceedingsTitle", "conferenceName", "repository", "volume", "issue", "pages",
      "publisher", "place", "ISBN", "ISSN"]) {
      try { fields[field] = item.getField(field) || ""; } catch (_) { fields[field] = ""; }
    }
    return {
      operation: "update",
      id: item.id,
      key: item.key,
      itemType: Zotero.ItemTypes.getName(item.itemTypeID),
      firstAuthor: firstCreator?.lastName || firstCreator?.name || "",
      ...fields
    };
  },

  async requestJSON(url) {
    const response = await this.httpRequest(url, {
      responseType: "json",
      timeout: 6000,
      headers: { Accept: "application/json" }
    });
    // Gecko throws if responseText is read with responseType=json, even for null.
    return response.response ?? null;
  },

  async requestText(url, options = {}) {
    if (options.cache && this.textCache.has(url)) return this.textCache.get(url);
    let lastError;
    for (let attempt = 0; attempt < 1; attempt++) {
      try {
        const response = await this.httpRequest(url, {
          responseType: "text",
          timeout: 6000,
          headers: {
            Accept: "text/html,application/xhtml+xml",
            "User-Agent": "MetadataReconciler/0.1 (+Zotero)"
          }
        });
        const text = response.responseText || response.response || "";
        if (options.cache && !this.cancelled && text.length < 4000000) {
          if (this.textCache.size >= 3) this.textCache.delete(this.textCache.keys().next().value);
          this.textCache.set(url, text);
        }
        return text;
      } catch (error) {
        lastError = error;
        const status = Number(error.status || error.xmlhttp?.status || 0);
        const retryable = !status || status === 429 || status >= 500;
        if (!retryable || attempt === 2) break;
        await Zotero.Promise.delay(700 * Math.pow(2, attempt));
      }
    }
    throw lastError;
  },

  cvfLandingURL(value) {
    const match = String(value || "").match(/(?:https?:\/\/)?openaccess\.thecvf\.com\/[^\s#]+/i);
    if (!match) return "";
    let url = match[0].replace(/[),;]+$/, "");
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    url = url.split("#")[0].split("?")[0];
    if (/\/papers\/.*\.pdf$/i.test(url)) {
      url = url.replace("/papers/", "/html/").replace(/\.pdf$/i, ".html");
    }
    return /\/html\/.*\.html$/i.test(url) ? url : "";
  },

  async findCVFCandidate(value) {
    const iclr = /^https:\/\/proceedings\.iclr\.cc\/paper_files\/paper\/\d{4}\/hash\/[^/?#]+-Abstract-Conference\.html$/.test(value);
    const landingURL = iclr ? value : this.cvfLandingURL(value);
    if (!landingURL) return null;
    const html = await this.requestText(landingURL);
    if (this.cancelled) return null;
    const parser = new (Zotero.getMainWindow().DOMParser)();
    const doc = parser.parseFromString(html, "text/html");
    const meta = (name) => doc.querySelector(`meta[name="${name}"]`)?.getAttribute("content")?.trim() || "";
    const title = meta("citation_title");
    const conferenceTitle = iclr ? meta("citation_journal_title") : meta("citation_conference_title");
    if (iclr && doc.querySelector(".paper-track")?.textContent.trim() !== "Conference") return null;
    if (!title || !conferenceTitle) throw new Error("CVF 页面缺少论文标题或会议名称");
    const authors = Array.from(doc.querySelectorAll('meta[name="citation_author"]')).map((node) => {
      const name = node.getAttribute("content")?.trim() || "";
      if (name.includes(",")) {
        const [lastName, ...given] = name.split(",");
        return { firstName: given.join(",").trim(), lastName: lastName.trim(), creatorType: "author" };
      }
      const parts = name.split(/\s+/);
      return { firstName: parts.slice(0, -1).join(" "), lastName: parts.slice(-1).join(" "), creatorType: "author" };
    }).filter((creator) => creator.firstName || creator.lastName);
    const firstPage = meta("citation_firstpage");
    const lastPage = meta("citation_lastpage");
    return {
      source: iclr ? "ICLR 官方论文集" : "CVF Open Access",
      sourceURL: landingURL,
      externalType: "proceedings-article",
      sourceType: "conference",
      title,
      DOI: MetadataReconcilerCore.cleanDOI(meta("citation_doi")),
      date: meta("citation_publication_date"),
      containerTitle: conferenceTitle,
      eventName: conferenceTitle.replace(/^Proceedings of (the )?/i, ""),
      publisher: "",
      volume: "",
      issue: "",
      pages: firstPage ? `${firstPage}${lastPage ? `-${lastPage}` : ""}` : "",
      ISBN: "",
      ISSN: "",
      url: landingURL,
      authors,
      firstAuthor: authors[0]?.lastName || "",
      authoritativeURLMatch: true
    };
  },

  cvfIndexURLs(summary) {
    let year = MetadataReconcilerCore.yearOf(summary.date);
    if (!year) {
      const arxiv = String(summary.DOI || summary.url || "").match(/(?:arxiv[.:/]|abs\/|pdf\/)(\d{2})\d{2}\.\d+/i);
      if (arxiv) year = 2000 + Number(arxiv[1]);
    }
    const current = new Date().getFullYear();
    const years = year ? [Math.min(year + 1, current), year] : [current, current - 1];
    return [...new Set(years)].flatMap(year => {
    const conferences = ["CVPR"];
    if (year % 2) conferences.push("ICCV");
    else conferences.push("ECCV");
    conferences.push("WACV");
    return conferences.map((name) => ({
      name: `${name} ${year}`,
      url: `https://openaccess.thecvf.com/${name}${year}?day=all`
    }));
    });
  },

  async findICLRByTitle(summary) {
    const term = summary.title.split(":")[0].trim() || summary.title;
    const html = await this.requestText(`https://proceedings.iclr.cc/papers/search?q=${encodeURIComponent(term)}`);
    if (this.cancelled) return null;
    const parser = new (Zotero.getMainWindow().DOMParser)();
    const doc = parser.parseFromString(html, "text/html");
    const links = Array.from(doc.querySelectorAll('a[href*="-Abstract-Conference.html"]'));
    const matches = links.map(link => ({
      title: link.textContent.trim(), href: link.getAttribute("href"),
      score: MetadataReconcilerCore.titleSimilarity(summary.title, link.textContent)
    })).filter(match => match.score >= 0.94).sort((a, b) => b.score - a.score);
    if (!matches.length) return null;
    const href = matches[0].href;
    const url = href.startsWith("/") ? `https://proceedings.iclr.cc${href}` : href;
    return this.findCVFCandidate(url);
  },

  async findCVFByTitle(summary) {
    const parser = new (Zotero.getMainWindow().DOMParser)();
    const indexes = this.cvfIndexURLs(summary);
    try {
    return await Promise.any(indexes.map(async index => {
      const html = await this.requestText(index.url, { cache: true });
      if (this.cancelled) throw new Error("查询已停止");
      const doc = parser.parseFromString(html, "text/html");
      let best = null;
      for (const link of doc.querySelectorAll('dt.ptitle a[href*="/html/"]')) {
        const score = MetadataReconcilerCore.titleSimilarity(summary.title, link.textContent || "");
        if (!best || score > best.score) best = { score, href: link.getAttribute("href") || "" };
      }
      if (best?.score >= 0.92 && best.href) {
        const landingURL = /^https?:/i.test(best.href)
          ? best.href
          : `https://openaccess.thecvf.com${best.href.startsWith("/") ? "" : "/"}${best.href}`;
        const candidate = await this.findCVFCandidate(landingURL);
        candidate.source = `CVF Open Access（${index.name} 官方目录）`;
        candidate.discoverySource = index.url;
        return candidate;
      }
      throw new Error("目录没有标题匹配");
    }));
    } catch (error) {
      const failures = (error.errors || []).filter(reason => !["目录没有标题匹配", "查询已停止"].includes(reason?.message)
        && Number(reason?.status || reason?.xmlhttp?.status) !== 404);
      if (failures.length) throw new Error("部分会议目录不可用或超时");
      return null;
    }
  },

  async findTitleFallbackCandidates(summary, onUpdate) {
    const core = MetadataReconcilerCore;
    const title = encodeURIComponent(summary.title);
    const tasks = [
      (async () => {
        const data = await this.requestJSON(`https://dblp.org/search/publ/api?q=${title}&h=5&format=json`);
        const hits = data?.result?.hits?.hit || [];
        return (Array.isArray(hits) ? hits : [hits]).filter(hit => hit?.info).map((hit) => core.dblpToCandidate(hit.info));
      })(),
      (async () => {
        const data = await this.requestJSON(`https://api.crossref.org/works?query.title=${title}&rows=3`);
        return (data?.message?.items || []).filter(Boolean).map(core.crossrefToCandidate);
      })(),
      (async () => {
        const data = await this.requestJSON(`https://api.openalex.org/works?search=${title}&per-page=3`);
        return (data?.results || []).filter(Boolean).map(core.openAlexToCandidate);
      })(),
      (async () => {
        const fields = "title,authors,year,venue,publicationTypes,publicationDate,externalIds,url,openAccessPdf,journal,paperId";
        const data = await this.requestJSON(`https://api.semanticscholar.org/graph/v1/paper/search?query=${title}&limit=3&fields=${fields}`);
        return (data?.data || []).filter(Boolean).map(core.semanticScholarToCandidate);
      })()
    ];
    const names = ["DBLP", "Crossref", "OpenAlex", "Semantic Scholar"];
    const settled = await Promise.allSettled(tasks.map((task, index) => task.then(records => {
      onUpdate?.({ candidates: records, errors: [] });
      return records;
    }, error => {
      onUpdate?.({ candidates: [], errors: [`${names[index]}: ${error.message || error}`] });
      throw error;
    })));
    const candidates = [];
    const errors = [];
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") candidates.push(...result.value);
      else errors.push(`${names[index]}: ${result.reason?.message || result.reason}`);
    });
    return onUpdate ? { candidates, errors, streamed: true } : { candidates, errors };
  },

  async findCandidates(summary, onUpdate) {
    const core = MetadataReconcilerCore;
    const doi = core.cleanDOI(summary.DOI || summary.url || summary.extra);
    const cacheKey = JSON.stringify(summary);
    const cached = this.lookupCache.get(cacheKey);
    if (cached && Date.now() - cached.time < 300000) return cached.result;
    const candidates = [];
    const errors = [];
    let closed = false;
    const publish = () => {
      if (!closed && !this.cancelled) onUpdate?.(this.prepareCandidates(summary, candidates.slice(), errors.slice()));
    };
    const jobs = [];
    const job = (task) => {
      const promise = task().catch(error => {
        errors.push(error.message || String(error));
      }).then(publish);
      jobs.push(promise);
    };
    const cvfURL = this.cvfLandingURL(summary.url || summary.title);
    const scholarEnabled = Boolean(this.providerSettings?.serpKey);
    if (this.findArxiv) job(async () => {
      try {
        const records = await this.findArxiv(summary, () => closed);
        if (!closed && records.length === 1 && this.arxivID(summary) && /^https?:\/\/|^arxiv\./i.test(summary.title)) {
          summary.title = records[0].title;
          summary.date = records[0].date;
          summary.firstAuthor = records[0].firstAuthor;
          summary.DOI = records[0].DOI;
          if (this.findScholarVersions) await this.findScholarVersions(summary, candidate => { candidates.push(candidate); publish(); }, () => closed, message => errors.push(message));
        }
        candidates.push(...records);
      }
      catch (error) { errors.push(`arXiv: ${error.message}`); }
    });
    if (this.findScholarVersions && summary.title && !/^https?:\/\//i.test(summary.title)) job(async () => {
      try { await this.findScholarVersions(summary, candidate => { candidates.push(candidate); publish(); }, () => closed, message => errors.push(message)); }
      catch (error) { errors.push(error.message); }
    });
    if (!scholarEnabled && !cvfURL && summary.title && !/^https?:\/\//i.test(summary.title)) {
      job(async () => {
        try {
          const candidate = await this.findICLRByTitle(summary);
          if (candidate) candidates.push(candidate);
        } catch (error) { errors.push(`ICLR 官方论文集: ${error.message}`); }
      });
    }
    if (cvfURL) {
      job(async () => {
      try {
        const candidate = await this.findCVFCandidate(cvfURL);
        if (candidate) candidates.push(candidate);
      } catch (error) {
        errors.push(`CVF Open Access: ${error.message}`);
      }
      });
    }
    if (doi) {
      job(async () => { try {
        if (/^10\.48550\/arxiv\./i.test(doi)) return;
        const data = await this.requestJSON(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
        if (data?.message) candidates.push(core.crossrefToCandidate(data.message));
      } catch (error) {
        const status = Number(error.status || error.xmlhttp?.status || 0);
        if (status !== 404) errors.push(`Crossref: ${error.message}`);
      } });
      job(async () => { try {
        const data = await this.requestJSON(`https://api.openalex.org/works/https://doi.org/${encodeURIComponent(doi)}`);
        if (data) candidates.push(core.openAlexToCandidate(data));
      } catch (error) { errors.push(`OpenAlex: ${error.message}`); } });
    }
    if (!scholarEnabled && !cvfURL && summary.title && !/^https?:\/\//i.test(summary.title)) {
      job(async () => { try {
        const officialCandidate = await this.findCVFByTitle(summary);
        if (officialCandidate) candidates.push(officialCandidate);
      } catch (error) { errors.push(`CVF Open Access: ${error.message}`); } });
      job(async () => {
        const fallback = await this.findTitleFallbackCandidates(summary, partial => {
          candidates.push(...partial.candidates);
          errors.push(...partial.errors);
          publish();
        });
        // The source callback already delivered results for this implementation.
        if (!fallback.streamed) {
        candidates.push(...fallback.candidates);
        errors.push(...fallback.errors);
        }
      });
    }
    const work = (async () => {
    await Promise.all(jobs);
    const relatedDOIs = [...new Set(candidates.flatMap(candidate => candidate.relatedDOIs || []))]
      .filter(related => related !== doi).slice(0, 3);
    await Promise.all(relatedDOIs.map(async related => {
      if (closed || this.cancelled) return;
      try {
        const data = await this.requestJSON(`https://api.crossref.org/works/${encodeURIComponent(related)}`);
        if (!data?.message) return;
        const candidate = core.crossrefToCandidate(data.message);
        candidate.versionEvidence = "Crossref 版本关联";
        candidates.push(candidate);
        publish();
      } catch (error) { errors.push(`关联版本: ${error.message}`); }
    }));
    })();
    let timer;
    const timerHost = typeof setTimeout === "function" ? globalThis : Zotero.getMainWindow();
    let timedOut = false;
    await Promise.race([
      work,
      new Promise(resolve => { timer = timerHost.setTimeout(() => { timedOut = true; resolve(); }, this.LOOKUP_BUDGET_MS); })
    ]);
    timerHost.clearTimeout(timer);
    closed = true;
    const result = this.prepareCandidates(summary, candidates.slice(), errors.slice());
    if (timedOut) result.errors.push("已到快速查询时限，展示已返回的结果；尚未完成的来源不代表没有正式版本。");
    if (!timedOut && !result.errors.length && !this.cancelled) {
      if (this.lookupCache.size >= 100) this.lookupCache.delete(this.lookupCache.keys().next().value);
      this.lookupCache.set(cacheKey, { time: Date.now(), result });
    }
    return result;
  },

  prepareCandidates(summary, candidates, errors) {
    const core = MetadataReconcilerCore;
    const doi = core.cleanDOI(summary.DOI || summary.url || summary.extra);
    candidates = candidates.map(candidate => ({ ...candidate }));
    candidates.sort((a, b) => Number(Boolean(b.authoritativeURLMatch)) - Number(Boolean(a.authoritativeURLMatch)));
    const seenCandidates = new Set();
    const uniqueCandidates = candidates.filter((candidate) => {
      const key = core.cleanDOI(candidate.DOI) || `${core.normalizeText(candidate.title)}|${core.normalizeText(candidate.containerTitle)}|${core.inferType(candidate) || candidate.url || ""}`;
      if (!key || seenCandidates.has(key)) return false;
      seenCandidates.add(key);
      return true;
    });
    for (const candidate of uniqueCandidates) {
      candidate.score = candidate.authoritativeURLMatch ? 1 : core.scoreCandidate(summary, candidate);
      if (candidate.requiresReview) candidate.score = Math.min(candidate.score, 0.89);
      const proposal = core.buildChanges(summary, candidate, summary.itemType);
      candidate.targetType = proposal.targetType;
      candidate.versionLabel = candidate.targetType === "preprint" ? "预印本版本"
        : ["conferencePaper", "journalArticle"].includes(candidate.targetType) ? "正式发表版本" : "类型待核实";
      if (doi && candidate.DOI && doi !== core.cleanDOI(candidate.DOI)) {
        candidate.versionLabel += "（不同 DOI，请核对作者与版本）";
        candidate.score = Math.min(candidate.score, 0.89);
      }
      candidate.changes = proposal.changes;
    }
    uniqueCandidates.sort((a, b) => {
      const publishedRank = candidate => candidate.score >= 0.82 && ["conferencePaper", "journalArticle"].includes(candidate.targetType) ? 1 : 0;
      return publishedRank(b) - publishedRank(a) || b.score - a.score;
    });
    return { candidates: uniqueCandidates, errors };
  },

  async analyze(itemIDs, onProgress) {
    const results = new Array(itemIDs.length);
    let nextIndex = 0;
    let completed = 0;
    const worker = async () => {
    while (!this.cancelled && nextIndex < itemIDs.length) {
      const index = nextIndex++;
      let summary = { id: itemIDs[index], title: "（无法读取的条目）", itemType: "", key: "" };
      try {
        const item = Zotero.Items.get(itemIDs[index]);
        if (!item) throw new Error("条目已不存在或尚未载入");
        summary = this.itemSummary(item);
        if (!this.cancelled) onProgress?.(completed, itemIDs.length, summary.title);
        const lookup = await this.findCandidates(summary, partial => {
          results[index] = { summary, ...partial };
          if (!this.cancelled) onProgress?.(completed, itemIDs.length, summary.title, results.filter(Boolean));
        });
        results[index] = { summary, ...lookup };
      } catch (error) {
        results[index] = { summary, candidates: [], errors: [error.message || String(error)] };
      }
      completed++;
      if (!this.cancelled) onProgress?.(completed, itemIDs.length, summary.title, results.filter(Boolean));
    }
    };
    await Promise.all(Array.from({ length: Math.min(2, itemIDs.length) }, worker));
    return results;
  },

  snapshotItem(item) {
    const fields = {};
    for (const fieldID of Zotero.ItemFields.getItemTypeFields(item.itemTypeID)) {
      const field = Zotero.ItemFields.getName(fieldID);
      try { fields[field] = item.getField(field) || ""; } catch (_) {}
    }
    return {
      id: item.id,
      key: item.key,
      itemType: Zotero.ItemTypes.getName(item.itemTypeID),
      fields,
      creators: item.getCreators()
    };
  },

  readBackups() {
    try { return JSON.parse(Zotero.Prefs.get(this.PREF_BACKUPS, true) || "[]"); }
    catch (_) { return []; }
  },

  writeBackups(backups) {
    Zotero.Prefs.set(this.PREF_BACKUPS, JSON.stringify(backups.slice(-20)), true);
  },

  async applySelections(selections) {
    if (!selections.length) return { applied: 0 };
    const snapshots = selections.map((selection) => {
      if (selection.createParent) {
        const attachment = Zotero.Items.get(selection.sourceAttachmentID || selection.itemID);
        return {
          operation: "createParent",
          attachmentID: attachment.id,
          attachmentKey: attachment.key,
          originalParentID: attachment.parentID || null,
          createdParentID: null
        };
      }
      return this.snapshotItem(Zotero.Items.get(selection.itemID));
    });
    const history = this.readBackups();
    const backup = { id: Date.now(), createdAt: new Date().toISOString(), items: snapshots };
    history.push(backup);
    // Persist the undo snapshot before any library write. If the transaction fails,
    // remove the unused snapshot again.
    this.writeBackups(history);
    let changedFields = 0;
    let skippedFields = 0;
    try {
      await Zotero.DB.executeTransaction(async () => {
        // Zotero 10 records all saves in this transaction as one native Undo step.
        // Older supported versions simply continue to use the plugin snapshot above.
        if (Zotero.UndoHistory?.stageAction) {
          try {
            Zotero.UndoHistory.stageAction("undo-action-edit-metadata", { count: selections.length });
          } catch (error) {
            Zotero.logError(error);
          }
        }
        for (const selection of selections) {
          if (selection.createParent) {
            const attachment = Zotero.Items.get(selection.sourceAttachmentID || selection.itemID);
            const targetType = selection.targetType === "attachment" ? "conferencePaper" : selection.targetType;
            const parent = new Zotero.Item(Zotero.ItemTypes.getID(targetType));
            parent.libraryID = attachment.libraryID;
            changedFields++;
            for (const change of selection.changes) {
              if (change.field === "itemType") continue;
              if (!Zotero.ItemFields.isValidForType(change.field, parent.itemTypeID)) {
                skippedFields++;
                continue;
              }
              parent.setField(change.field, change.after);
              changedFields++;
            }
            if (selection.creators?.length) parent.setCreators(selection.creators);
            await parent.save();
            attachment.parentID = parent.id;
            await attachment.save();
            const snapshot = backup.items.find((entry) => entry.operation === "createParent"
              && entry.attachmentID === attachment.id);
            if (snapshot) snapshot.createdParentID = parent.id;
            continue;
          }
          const item = Zotero.Items.get(selection.itemID);
          if (selection.targetType && Zotero.ItemTypes.getName(item.itemTypeID) !== selection.targetType) {
            item.setType(Zotero.ItemTypes.getID(selection.targetType));
            changedFields++;
          }
          for (const change of selection.changes) {
            if (change.field === "itemType") continue;
            if (!Zotero.ItemFields.isValidForType(change.field, item.itemTypeID)) {
              skippedFields++;
              continue;
            }
            item.setField(change.field, change.after);
            changedFields++;
          }
          if (selection.replaceCreators && selection.creators?.length) item.setCreators(selection.creators);
          await item.save();
        }
      });
      // Store IDs of any newly created parent items for the plugin's explicit undo.
      this.writeBackups(history);
    } catch (error) {
      const currentHistory = this.readBackups().filter((entry) => entry.id !== backup.id);
      this.writeBackups(currentHistory);
      throw error;
    }
    try {
      await Zotero.getMainWindow()?.ZoteroPane?.itemsView?.refresh?.();
    } catch (error) {
      Zotero.logError(error);
    }
    return { applied: snapshots.length, changedFields, skippedFields };
  },

  async undoLast() {
    const history = this.readBackups();
    const backup = history.pop();
    if (!backup) return { restored: 0 };
    let restored = 0;
    await Zotero.DB.executeTransaction(async () => {
      for (const snapshot of backup.items) {
        if (snapshot.operation === "createParent") {
          const attachment = Zotero.Items.get(snapshot.attachmentID);
          if (attachment && attachment.key === snapshot.attachmentKey) {
            attachment.parentID = snapshot.originalParentID || false;
            await attachment.save();
          }
          const parent = snapshot.createdParentID ? Zotero.Items.get(snapshot.createdParentID) : null;
          if (parent) {
            parent.deleted = true;
            await parent.save();
          }
          restored++;
          continue;
        }
        const item = Zotero.Items.get(snapshot.id);
        if (!item || item.key !== snapshot.key) continue;
        item.setType(Zotero.ItemTypes.getID(snapshot.itemType));
        for (const [field, value] of Object.entries(snapshot.fields)) {
          if (Zotero.ItemFields.isValidForType(field, item.itemTypeID)) item.setField(field, value);
        }
        item.setCreators(snapshot.creators);
        await item.save();
        restored++;
      }
    });
    this.writeBackups(history);
    return { restored, createdAt: backup.createdAt };
  }
};
