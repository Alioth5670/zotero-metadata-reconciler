var MetadataReconcilerProviders = {
  providerSettings: { serpKey: "" },
  arxivGate: { tail: Promise.resolve(), lastStart: 0 },
  scholarBrowserGate: { tail: Promise.resolve(), blockedUntil: 0 },

  scholarSearchURL(title) {
    return 'https://scholar.google.com/scholar?hl=en&q=' + encodeURIComponent('"' + title + '"');
  },

  parseScholarPage(html, pageURL) {
    const URLType = Zotero.getMainWindow().URL;
    const base = new URLType(pageURL);
    if (base.origin !== "https://scholar.google.com" || base.pathname !== "/scholar") {
      throw new Error("请先在内置窗口打开 Google Scholar 搜索或“所有版本”页面。");
    }
    const doc = new (Zotero.getMainWindow().DOMParser)().parseFromString(html, "text/html");
    if (doc.querySelector('form[action*="/sorry/"], #captcha, .g-recaptcha')
      || /unusual traffic from your computer network/i.test(doc.body?.textContent || "")) {
      throw new Error("Scholar 需要人工验证，请打开内置窗口继续。");
    }
    return Array.from(doc.querySelectorAll(".gs_ri")).slice(0, 20).flatMap(row => {
      const anchor = row.querySelector(".gs_rt a[href]");
      if (!anchor) return [];
      let target;
      try {
        target = new URLType(anchor.getAttribute("href"), base);
        if (target.origin === base.origin && target.pathname === "/url") {
          target = new URLType(target.searchParams.get("url") || target.searchParams.get("q"));
        }
      } catch (_) { return []; }
      if (!["https:", "http:"].includes(target.protocol) || target.username || target.password || target.origin === base.origin) return [];
      let cluster;
      for (const link of row.querySelectorAll(".gs_fl a[href]")) {
        try {
          const href = new URLType(link.getAttribute("href"), base);
          const id = href.searchParams.get("cluster");
          if (href.origin === base.origin && href.pathname === "/scholar" && /^\d+$/.test(id || "")) {
            cluster = id;
            break;
          }
        } catch (_) {}
      }
      return [{
        title: anchor.textContent.trim(),
        link: target.href,
        publication_info: { summary: row.querySelector(".gs_a")?.textContent.trim() || "" },
        inline_links: { versions: { cluster_id: cluster } }
      }];
    });
  },

  async browserScholarRecords(summary, shouldStop) {
    const gate = this.scholarBrowserGate;
    const previous = gate.tail;
    let release;
    gate.tail = new Promise(resolve => { release = resolve; });
    await previous;
    let browser;
    try {
      if (this.cancelled || shouldStop()) return [];
      if (gate.blockedUntil > Date.now()) throw new Error("Scholar 暂时需要人工操作，请打开内置窗口。");
      const { HiddenBrowser } = ChromeUtils.importESModule("chrome://zotero/content/HiddenBrowser.mjs");
      browser = new HiddenBrowser({ allowJavaScript: false });
      const read = async url => {
        if (!await browser.load(url, { requireSuccessfulStatus: true })) throw new Error("网页没有加载完成");
        if (this.cancelled || shouldStop()) return [];
        const { documentHTML } = await browser.getPageData(["documentHTML"], { timeout: 3500 });
        return this.parseScholarPage(documentHTML, browser.currentURI.spec);
      };
      const matches = (await read(this.scholarSearchURL(summary.title))).filter(row => MetadataReconcilerCore.titleSimilarity(summary.title, row.title) >= 0.94);
      const cluster = matches[0]?.inline_links?.versions?.cluster_id;
      if (cluster && !this.cancelled && !shouldStop()) {
        try { return [...matches, ...await read("https://scholar.google.com/scholar?hl=en&cluster=" + encodeURIComponent(cluster))]; }
        catch (_) {
          gate.blockedUntil = Date.now() + 60000;
          return matches;
        }
      }
      return matches;
    } catch (_) {
      gate.blockedUntil = Date.now() + 60000;
      throw new Error("Scholar 后台页面暂不可用；可打开 Zotero 内置窗口继续。");
    } finally {
      try { browser?.destroy(); } finally { release(); }
    }
  },

  openScholarViewer(title) {
    if (this.scholarViewer && !this.scholarViewer.closed) this.scholarViewer.close();
    const args = { uri: this.scholarSearchURL(title), options: {} };
    this.scholarViewer = Zotero.getMainWindow().openDialog(
      "chrome://zotero/content/standalone/basicViewer.xhtml", "_blank",
      "chrome,resizable,centerscreen,width=1020,height=760", { wrappedJSObject: args }
    );
  },

  async readScholarViewer(summary) {
    const browser = this.scholarViewer?.gBrowser;
    if (!browser || this.scholarViewer.closed) throw new Error("请先打开 Zotero 内置窗口，并找到这篇论文的版本。");
    const url = browser.currentURI.spec;
    if (!/^https:\/\/scholar\.google\.com\/scholar(?:\?|$)/.test(url)) throw new Error("请返回 Scholar 搜索结果或“所有版本”页面。");
    const html = await browser.browsingContext.currentWindowGlobal.getActor("PageData").sendQuery("documentHTML");
    if (url !== browser.currentURI.spec) throw new Error("页面已切换，请等加载完成后再读取。");
    const candidates = [], errors = [];
    await this.processScholarRecords(summary, this.parseScholarPage(html, url), null,
      candidate => candidates.push(candidate), () => this.cancelled, message => errors.push(message), false);
    if (!candidates.length) throw new Error("当前页没有匹配此条目的候选，请确认打开的是这篇论文的版本列表。");
    return this.prepareCandidates(summary, candidates, errors);
  },

  configureSerpApi(key) {
    this.providerSettings.serpKey = String(key || "").trim();
    this.lookupCache.clear();
  },

  async loadSerpApiKey() {
    const logins = await Services.logins.findLogins("chrome://metadata-reconciler", null, "SerpApi API Key");
    this.configureSerpApi(logins[0]?.password || "");
  },

  async saveSerpApiKey(key) {
    const value = String(key || "").trim();
    const logins = await Services.logins.findLogins("chrome://metadata-reconciler", null, "SerpApi API Key");
    if (!value) {
      for (const login of logins) await Services.logins.removeLogin(login);
    } else {
      const login = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
      login.init("chrome://metadata-reconciler", null, "SerpApi API Key", "SerpApi", value, "", "");
      if (logins.length) await Services.logins.modifyLogin(logins[0], login);
      else await Services.logins.addLoginAsync(login);
    }
    this.configureSerpApi(value);
  },

  openSettings() {
    Zotero.Utilities.Internal.openPreferences("metadata-reconciler-settings");
  },

  async serpRequest(params, shouldStop = () => false) {
    if (this.cancelled || shouldStop() || !this.providerSettings.serpKey) return null;
    const query = Object.entries({ ...params, api_key: this.providerSettings.serpKey })
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
    try {
      const response = await this.httpRequest(`https://serpapi.com/search.json?${query}`, {
        responseType: "json", timeout: 15000, headers: { Accept: "application/json" }, shouldStop
      });
      const data = response.response;
      if (data?.error) throw new Error("服务返回错误");
      if (!data) throw new Error("服务返回空响应");
      return data;
    } catch (error) {
      // Never include the request URL or upstream body: they can contain a key.
      const status = Number(error.status || error.xmlhttp?.status || 0);
      throw new Error(status === 401 || status === 403 ? "SerpApi 密钥无效或访问被拒绝"
        : status === 429 ? "SerpApi 额度或访问频率受限" : "SerpApi 查询失败，请检查密钥、额度和网络");
    }
  },

  async importScholarBibtex(result, shouldStop = () => false) {
    if (!result.result_id || this.cancelled || shouldStop()) return null;
    const cite = await this.serpRequest({ engine: "google_scholar_cite", q: result.result_id }, shouldStop);
    const link = cite?.links?.find(link => /^bibtex$/i.test(link.name || ""))?.link;
    if (!/^https:\/\/scholar\.googleusercontent\.com\/scholar\.bib\?/.test(link || "") || this.cancelled || shouldStop()) return null;
    const bibtex = await this.requestText(link);
    if (this.cancelled || shouldStop()) return null;
    const translator = new Zotero.Translate.Import();
    translator.setString(bibtex);
    const translators = await translator.getTranslators();
    if (!translators.length || this.cancelled) return null;
    translator.setTranslator(translators[0]);
    let item;
    translator.setHandler("itemDone", (object, record) => { item = record; });
    // Parse into memory only; never save items during discovery.
    await translator.translate({ libraryID: false });
    if (!item || this.cancelled) return null;
    return {
      source: "Google Scholar / SerpApi（引用元数据）",
      sourceURL: result.link || "https://scholar.google.com/",
      externalType: ({ conferencePaper: "conference-paper", journalArticle: "journal-article", preprint: "preprint" })[item.itemType] || "",
      title: item.title || result.title || "", DOI: MetadataReconcilerCore.cleanDOI(item.DOI),
      date: item.date || "", containerTitle: item.proceedingsTitle || item.publicationTitle || "",
      eventName: item.conferenceName || item.proceedingsTitle || "", publisher: item.publisher || "",
      pages: item.pages || "", volume: item.volume || "", issue: item.issue || "",
      url: result.link || item.url || "", authors: item.creators || [],
      firstAuthor: item.creators?.[0]?.lastName || "", requiresReview: true
    };
  },

  async scholarLandingMetadata(record, shouldStop = () => false) {
    if (this.cancelled || shouldStop()) return null;
    const url = String(record.link || "").replace(/^http:/, "https:");
    const host = url.match(/^https:\/\/([a-z0-9.-]+)(?::443)?(?:\/|$)/i)?.[1]?.toLowerCase();
    if (!host || !host.includes(".") || /^[\d.]+$/.test(host)
      || /(?:^|\.)(localhost|local|internal)$/.test(host) || /\.pdf(?:[?#]|$)/i.test(url)) return null;
    const html = await this.requestText(url);
    if (this.cancelled || shouldStop()) return null;
    const doc = new (Zotero.getMainWindow().DOMParser)().parseFromString(html, "text/html");
    const meta = name => doc.querySelector(`meta[name="${name}"]`)?.getAttribute("content")?.trim() || "";
    const title = meta("citation_title");
    if (!title || MetadataReconcilerCore.titleSimilarity(record.title, title) < 0.94) return null;
    const conference = meta("citation_conference_title");
    const journal = meta("citation_journal_title");
    const arxivID = /^(?:www\.)?arxiv\.org$/.test(host) ? this.arxivID({ url }) : "";
    const containerTitle = conference || journal || meta("citation_inbook_title");
    let externalType = conference || /\b(?:conference|proceedings)\b/i.test(containerTitle)
      ? "conference-paper" : journal && !/arxiv|openreview|repository|preprint/i.test(journal) ? "journal-article" : "";
    if (arxivID) externalType = "preprint";
    const DOI = MetadataReconcilerCore.cleanDOI(meta("citation_doi"));
    if (!externalType && DOI && !/^10\.48550\/arxiv\./i.test(DOI)) {
      const data = await this.requestJSON(`https://api.crossref.org/works/${encodeURIComponent(DOI)}`);
      if (data?.message) return { ...MetadataReconcilerCore.crossrefToCandidate(data.message), requiresReview: true };
    }
    if (!externalType) return null;
    const authors = Array.from(doc.querySelectorAll('meta[name="citation_author"]')).map(node => {
      const name = node.getAttribute("content")?.trim() || "";
      if (name.includes(",")) {
        const [lastName, ...given] = name.split(",");
        return { firstName: given.join(",").trim(), lastName: lastName.trim(), creatorType: "author" };
      }
      const parts = name.split(/\s+/);
      return { firstName: parts.slice(0, -1).join(" "), lastName: parts.slice(-1).join(" "), creatorType: "author" };
    });
    const first = meta("citation_firstpage"), last = meta("citation_lastpage");
    return {
      source: arxivID ? "Scholar 发现 → arXiv 官方页面" : "Scholar 发现 → 论文页面标准元数据", sourceURL: url,
      title, DOI: arxivID ? (/^\d{4}\.\d+$/.test(arxivID) ? `10.48550/arXiv.${arxivID}` : "") : DOI,
      externalType, containerTitle: arxivID ? "arXiv" : containerTitle,
      relatedDOIs: arxivID && DOI && !/^10\.48550\/arxiv\./i.test(DOI) ? [DOI] : [],
      eventName: externalType === "conference-paper" ? containerTitle : "",
      date: meta("citation_publication_date") || meta("citation_date"),
      publisher: meta("citation_publisher"), volume: meta("citation_volume"), issue: meta("citation_issue"),
      pages: first ? `${first}${last ? `-${last}` : ""}` : "", url,
      authors, firstAuthor: authors[0]?.lastName || "", requiresReview: true
    };
  },

  async findScholarVersions(summary, onUpdate, shouldStop = () => false, onWarning = () => {}) {
    if (this.cancelled || shouldStop()) return;
    if (typeof ChromeUtils !== "undefined") {
      try {
        const records = await this.browserScholarRecords(summary, shouldStop);
        if (records.length) {
          await this.processScholarRecords(summary, records, records[0]?.inline_links?.versions?.cluster_id, onUpdate, shouldStop, onWarning, false);
          return;
        }
        if (!shouldStop()) onWarning("Scholar 后台未取得匹配结果，可在内置窗口核对。");
      } catch (error) { if (!shouldStop()) onWarning(error.message); }
    }
    if (!this.providerSettings.serpKey || this.cancelled || shouldStop()) return;
    const core = MetadataReconcilerCore;
    const data = await this.serpRequest({ engine: "google_scholar", q: `"${summary.title}"`, num: 5, hl: "en" }, shouldStop);
    const matched = (data?.organic_results || []).filter(record => core.titleSimilarity(summary.title, record.title) >= 0.94);
    if (!matched.length || this.cancelled || shouldStop()) return;
    const cluster = matched[0].inline_links?.versions?.cluster_id;
    let records = matched;
    if (cluster && /^\d+$/.test(String(cluster)) && !this.cancelled) {
      const versions = await this.serpRequest({ engine: "google_scholar", cluster: String(cluster), num: 10, hl: "en" }, shouldStop);
      records = [...records, ...(versions?.organic_results || [])];
    }
    return this.processScholarRecords(summary, records, cluster, onUpdate, shouldStop, onWarning, true);
  },

  async processScholarRecords(summary, records, cluster, onUpdate, shouldStop, onWarning, useCite) {
    const core = MetadataReconcilerCore;
    const seen = new Set();
    records = records.filter(record => {
      const key = record.result_id || record.link;
      if (!key || seen.has(key) || core.titleSimilarity(summary.title, record.title) < 0.94) return false;
      seen.add(key);
      return true;
    });
    // Rank discovery hints only. A venue word does not determine item type.
    const rank = record => /\b(?:proceedings|conference|journal|transactions)\b/i.test(record.publication_info?.summary || "") ? 2
      : /arxiv|adsabs/i.test(record.link || "") ? -1 : 0;
    records.sort((a, b) => rank(b) - rank(a));
    for (const record of records.slice(0, 10)) {
      const authors = (record.publication_info?.authors || []).map(author => {
        const parts = String(author.name || "").trim().split(/\s+/);
        return { firstName: parts.slice(0, -1).join(" "), lastName: parts.slice(-1).join(" "), creatorType: "author" };
      });
      onUpdate({
        source: useCite ? "Google Scholar / SerpApi（版本线索）" : "Zotero 内置浏览器 / Scholar（版本线索）", sourceURL: record.link || "",
        title: record.title || "", url: record.link || "", externalType: "",
        date: String(core.yearOf(record.publication_info?.summary) || ""),
        authors, firstAuthor: authors[0]?.lastName || "", requiresReview: true,
        versionEvidence: record.publication_info?.summary || "未提供结构化引用信息"
      });
    }
    let formalFound = false;
    for (const record of records.slice(0, 4)) {
      if (this.cancelled || shouldStop()) return;
      try {
        const candidate = await this.scholarLandingMetadata(record, shouldStop);
        if (!candidate) continue;
        candidate.versionEvidence = cluster ? `Scholar 版本组 ${cluster}；论文页面标准元数据` : "Scholar 标题检索；论文页面标准元数据";
        onUpdate(candidate);
        if (["conferencePaper", "journalArticle"].includes(core.inferType(candidate))) formalFound = true;
      } catch (_) {
        // One blocked landing page must not prevent trying other versions.
      }
    }
    if (formalFound || !useCite) return;
    let exportBlocked = false;
    for (const record of records.slice(0, 2)) {
      if (this.cancelled || shouldStop()) return;
      let candidate;
      try { candidate = await this.importScholarBibtex(record, shouldStop); }
      catch (error) {
        if (Number(error.status || error.xmlhttp?.status) === 403) exportBlocked = true;
        else onWarning("某个版本的引用元数据暂不可用，已尝试其他版本。");
        continue;
      }
      if (candidate) {
        candidate.versionEvidence = cluster ? `Scholar 版本组 ${cluster}` : "Scholar 标题检索";
        if (candidate.DOI && !/^10\.48550\/arxiv\./i.test(candidate.DOI)) candidate.relatedDOIs = [candidate.DOI];
        onUpdate(candidate);
      }
    }
    if (exportBlocked) onWarning("Google 拒绝了引用导出（403）；已保留找到的版本链接，可稍后重试。");
  },

  arxivID(summary) {
    const value = [summary.DOI, summary.url, summary.extra, summary.title].filter(Boolean).join(" ");
    const match = value.match(/(?:arxiv(?:\s*:\s*|[./])|arxiv\.org\/(?:abs|pdf)\/)(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?/i);
    return match?.[1] || "";
  },

  async findArxiv(summary, shouldStop = () => false) {
    const id = this.arxivID(summary);
    const query = id ? `id_list=${encodeURIComponent(id)}`
      : `search_query=${encodeURIComponent('ti:"' + String(summary.title || "").replace(/"/g, " ") + '"')}&max_results=3`;
    if (!id && (!summary.title || /^https?:\/\//i.test(summary.title))) return [];
    // Official arXiv guidance: one connection and at least 3s between calls.
    const previous = this.arxivGate.tail;
    let release;
    this.arxivGate.tail = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      if (this.cancelled || shouldStop()) return [];
      if (this.arxivGate.blockedUntil > Date.now()) throw new Error("arXiv 正在限流冷却，请稍后重试");
      const wait = Math.max(0, 3000 - (Date.now() - this.arxivGate.lastStart));
      if (wait) await Zotero.Promise.delay(wait);
      if (this.cancelled || shouldStop()) return [];
      this.arxivGate.lastStart = Date.now();
      const xml = await this.requestText(`https://export.arxiv.org/api/query?${query}`);
      if (this.cancelled) return [];
      return this.parseArxiv(xml);
    } catch (error) {
      if (Number(error.status || error.xmlhttp?.status) === 429) {
        this.arxivGate.blockedUntil = Date.now() + 60000;
        throw new Error("arXiv 返回限流，已暂停访问 60 秒");
      }
      throw error;
    } finally { release(); }
  },

  parseArxiv(xml) {
    const doc = new (Zotero.getMainWindow().DOMParser)().parseFromString(xml, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) throw new Error("arXiv XML 格式异常");
    const atom = "http://www.w3.org/2005/Atom", arxiv = "http://arxiv.org/schemas/atom";
    return Array.from(doc.getElementsByTagNameNS(atom, "entry")).map(entry => {
      const text = (name, ns = atom) => entry.getElementsByTagNameNS(ns, name)[0]?.textContent.trim().replace(/\s+/g, " ") || "";
      const url = text("id").replace(/^http:/, "https:");
      if (/\/api\/errors/.test(url)) throw new Error("arXiv 查询参数无效");
      const id = url.match(/\/abs\/(.+?)(?:v\d+)?$/)?.[1] || "";
      const authors = Array.from(entry.getElementsByTagNameNS(atom, "author")).map(author => {
        const parts = (author.getElementsByTagNameNS(atom, "name")[0]?.textContent || "").trim().split(/\s+/);
        return { firstName: parts.slice(0, -1).join(" "), lastName: parts.slice(-1).join(" "), creatorType: "author" };
      });
      const publishedDOI = MetadataReconcilerCore.cleanDOI(text("doi", arxiv));
      return {
        source: "arXiv 官方 API", sourceURL: url, externalType: "preprint",
        title: text("title"), date: text("published").slice(0, 10),
        DOI: /^\d{4}\.\d+$/.test(id) ? `10.48550/arXiv.${id}` : "", url,
        containerTitle: "arXiv", authors, firstAuthor: authors[0]?.lastName || "",
        relatedDOIs: publishedDOI ? [publishedDOI] : [],
        versionEvidence: [text("journal_ref", arxiv), text("comment", arxiv)].filter(Boolean).join("；")
      };
    });
  }
};
if (typeof module !== "undefined") module.exports = MetadataReconcilerProviders;
