(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.MetadataReconcilerCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const VENUE_HINTS = /\b(CVPR|ICCV|ECCV|ICLR|NeurIPS|NIPS|ICML|AAAI|IJCAI|ACL|EMNLP|NAACL|SIGGRAPH|KDD|WWW|CHI)\b/i;

  function cleanDOI(value) {
    const match = String(value || "").match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i);
    return match ? match[0].replace(/[).,;]+$/, "").toLowerCase() : "";
  }

  function normalizeText(value) {
    return String(value || "")
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim()
      .toLowerCase();
  }

  function titleSimilarity(a, b) {
    const aa = new Set(normalizeText(a).split(" ").filter(Boolean));
    const bb = new Set(normalizeText(b).split(" ").filter(Boolean));
    if (!aa.size || !bb.size) return 0;
    let intersection = 0;
    for (const token of aa) if (bb.has(token)) intersection++;
    return (2 * intersection) / (aa.size + bb.size);
  }

  function yearOf(value) {
    const match = String(value || "").match(/(?:19|20)\d{2}/);
    return match ? Number(match[0]) : null;
  }

  function inferType(record) {
    const externalType = String(record.externalType || "").toLowerCase();
    const sourceType = String(record.sourceType || "").toLowerCase();
    const venue = `${record.containerTitle || ""} ${record.eventName || ""}`;
    if (["proceedings-article", "conference-paper", "conference"].includes(externalType)
      || sourceType === "conference") return "conferencePaper";
    if (["journal-article", "journal"].includes(externalType) || sourceType === "journal") {
      return "journalArticle";
    }
    if (["posted-content", "preprint"].includes(externalType)
      || (sourceType === "repository" && record.isPublished === false)) return "preprint";
    // A venue acronym may strengthen a proceedings record, but never classifies a record alone.
    if (externalType.includes("proceedings") && VENUE_HINTS.test(venue)) return "conferencePaper";
    return null;
  }

  function scoreCandidate(item, candidate) {
    const itemDOI = cleanDOI(item.DOI || item.url || item.extra);
    const candidateDOI = cleanDOI(candidate.DOI);
    if (itemDOI && candidateDOI && itemDOI === candidateDOI) return 1;
    if (candidate.requiresReview && ["conferencePaper", "journalArticle"].includes(inferType(candidate))
      && (item.itemType === "preprint" || /^10\.48550\/arxiv\./i.test(itemDOI) || /arxiv\.org\//i.test(item.url || ""))
      && titleSimilarity(item.title, candidate.title) >= 0.94
      && normalizeText(item.firstAuthor) && normalizeText(item.firstAuthor) === normalizeText(candidate.firstAuthor)) {
      const from = yearOf(item.date), to = yearOf(candidate.date);
      if (!from || !to || Math.abs(to - from) <= 3) return 0.89;
    }
    if (itemDOI && candidateDOI && itemDOI !== candidateDOI) {
      // A preprint and its published version normally have different DOIs.
      // This is a version candidate, not a DOI identity match; require review.
      const preprintPair = /^10\.48550\/arxiv\./i.test(itemDOI)
        || inferType(candidate) === "preprint" || item.itemType === "preprint";
      const sameAuthor = normalizeText(item.firstAuthor) && normalizeText(item.firstAuthor) === normalizeText(candidate.firstAuthor);
      const titleMatch = titleSimilarity(item.title, candidate.title);
      if (!preprintPair || titleMatch < 0.94 || !sameAuthor) return 0;
      const fromYear = yearOf(item.date);
      const toYear = yearOf(candidate.date);
      if (fromYear && toYear && Math.abs(toYear - fromYear) > 3) return 0;
      return 0.89;
    }
    let score = titleSimilarity(item.title, candidate.title) * 0.82;
    const itemYear = yearOf(item.date);
    const candidateYear = yearOf(candidate.date);
    if (itemYear && candidateYear) score += itemYear === candidateYear ? 0.12 : -0.12;
    const itemAuthor = normalizeText(item.firstAuthor || "");
    const candidateAuthor = normalizeText(candidate.firstAuthor || "");
    if (itemAuthor && candidateAuthor && (itemAuthor.includes(candidateAuthor) || candidateAuthor.includes(itemAuthor))) {
      score += 0.06;
    }
    return Math.max(0, Math.min(0.99, score));
  }

  function crossrefToCandidate(message) {
    const dateParts = message["published-print"]?.["date-parts"]?.[0]
      || message.published?.["date-parts"]?.[0]
      || message.issued?.["date-parts"]?.[0];
    const date = dateParts ? dateParts.filter(Boolean).join("-") : "";
    const authors = (message.author || []).map((author) => ({
      firstName: author.given || "",
      lastName: author.family || "",
      creatorType: "author"
    }));
    const containerTitle = message["container-title"]?.[0] || "";
    const eventName = message.event?.name || "";
    return {
      source: "Crossref",
      relatedDOIs: Object.entries(message.relation || {})
        .filter(([type]) => ["is-preprint-of", "has-preprint", "is-version-of", "has-version"].includes(type))
        .flatMap(([, links]) => (Array.isArray(links) ? links : []).map(link => cleanDOI(link.id)))
        .filter(Boolean),
      sourceURL: message.URL || (message.DOI ? `https://doi.org/${message.DOI}` : ""),
      externalType: message.type || "",
      title: message.title?.[0] || "",
      DOI: cleanDOI(message.DOI),
      date,
      containerTitle,
      eventName,
      publisher: message.publisher || "",
      volume: message.volume || "",
      issue: message.issue || "",
      pages: message.page || "",
      ISBN: (message.ISBN || []).join(", "),
      ISSN: (message.ISSN || []).join(", "),
      url: message.URL || "",
      place: message.event?.location || "",
      authors,
      firstAuthor: authors[0]?.lastName || ""
    };
  }

  function openAlexToCandidate(work) {
    const source = work.primary_location?.source || {};
    const authors = (work.authorships || []).map((authorship) => {
      const displayName = authorship.author?.display_name || "";
      const pieces = displayName.trim().split(/\s+/);
      return {
        firstName: pieces.slice(0, -1).join(" "),
        lastName: pieces.slice(-1).join(" "),
        creatorType: "author"
      };
    });
    return {
      source: "OpenAlex",
      sourceURL: work.id || "",
      externalType: work.type || "",
      sourceType: source.type || "",
      isPublished: work.primary_location?.is_published,
      title: work.title || work.display_name || "",
      DOI: cleanDOI(work.doi),
      date: work.publication_date || String(work.publication_year || ""),
      containerTitle: source.display_name || "",
      eventName: "",
      publisher: source.host_organization_name || "",
      volume: work.biblio?.volume || "",
      issue: work.biblio?.issue || "",
      pages: work.biblio?.first_page
        ? `${work.biblio.first_page}${work.biblio.last_page ? `-${work.biblio.last_page}` : ""}`
        : "",
      ISSN: (source.issn || []).join(", "),
      url: work.primary_location?.landing_page_url || work.doi || work.id || "",
      authors,
      firstAuthor: authors[0]?.lastName || ""
    };
  }

  function dblpToCandidate(info) {
    const rawAuthors = info.authors?.author || [];
    const authors = (Array.isArray(rawAuthors) ? rawAuthors : [rawAuthors]).map((author) => {
      const displayName = typeof author === "string" ? author : (author?.text || "");
      const pieces = displayName.trim().split(/\s+/).filter(Boolean);
      return {
        firstName: pieces.slice(0, -1).join(" "),
        lastName: pieces.slice(-1).join(" "),
        creatorType: "author"
      };
    }).filter((author) => author.firstName || author.lastName);
    const ee = Array.isArray(info.ee) ? info.ee[0] : (info.ee || "");
    const type = String(info.type || "");
    return {
      source: "DBLP",
      sourceURL: ee || info.url || "",
      externalType: /conference|workshop/i.test(type) ? "conference-paper" : (/journal/i.test(type) ? "journal-article" : type),
      sourceType: /conference|workshop/i.test(type) ? "conference" : (/journal/i.test(type) ? "journal" : ""),
      title: typeof info.title === "string" ? info.title : (info.title?.text || ""),
      DOI: cleanDOI(info.doi || ee),
      date: String(info.year || ""),
      containerTitle: info.venue || "",
      eventName: info.venue || "",
      publisher: info.publisher || "",
      volume: info.volume || "",
      issue: info.number || "",
      pages: info.pages || "",
      ISBN: info.isbn || "",
      ISSN: "",
      url: ee || info.url || "",
      authors,
      firstAuthor: authors[0]?.lastName || ""
    };
  }

  function semanticScholarToCandidate(paper) {
    const publicationTypes = paper.publicationTypes || [];
    const typeText = publicationTypes.join(" ");
    const authors = (paper.authors || []).map((author) => {
      const pieces = String(author.name || "").trim().split(/\s+/).filter(Boolean);
      return {
        firstName: pieces.slice(0, -1).join(" "),
        lastName: pieces.slice(-1).join(" "),
        creatorType: "author"
      };
    }).filter((author) => author.firstName || author.lastName);
    return {
      source: "Semantic Scholar",
      sourceURL: paper.url || "",
      externalType: /conference/i.test(typeText) ? "conference-paper" : (/journal/i.test(typeText) ? "journal-article" : (/review/i.test(typeText) ? "journal-article" : "")),
      sourceType: /conference/i.test(typeText) ? "conference" : (/journal|review/i.test(typeText) ? "journal" : ""),
      title: paper.title || "",
      DOI: cleanDOI(paper.externalIds?.DOI),
      date: paper.publicationDate || String(paper.year || ""),
      containerTitle: paper.venue || paper.journal?.name || "",
      eventName: /conference/i.test(typeText) ? (paper.venue || "") : "",
      publisher: "",
      volume: paper.journal?.volume || "",
      issue: paper.journal?.pages || "",
      pages: paper.journal?.pages || "",
      ISBN: "",
      ISSN: "",
      url: paper.openAccessPdf?.url || paper.url || "",
      authors,
      firstAuthor: authors[0]?.lastName || ""
    };
  }

  function fieldMap(candidate, type) {
    const common = {
      title: candidate.title,
      date: candidate.date,
      DOI: candidate.DOI,
      url: candidate.url,
      volume: candidate.volume,
      pages: candidate.pages,
      publisher: candidate.publisher
    };
    if (type === "conferencePaper") {
      return {
        ...common,
        proceedingsTitle: candidate.containerTitle,
        conferenceName: candidate.eventName || candidate.containerTitle,
        place: candidate.place,
        ISBN: candidate.ISBN
      };
    }
    if (type === "journalArticle") {
      return {
        ...common,
        publicationTitle: candidate.containerTitle,
        issue: candidate.issue,
        ISSN: candidate.ISSN
      };
    }
    if (type === "preprint") {
      return {
        title: candidate.title,
        date: candidate.date,
        DOI: candidate.DOI,
        url: candidate.url,
        repository: candidate.containerTitle
      };
    }
    return {};
  }

  function buildChanges(current, candidate, currentType) {
    const targetType = inferType(candidate);
    const changes = [];
    if (targetType && targetType !== currentType) {
      changes.push({ field: "itemType", before: currentType, after: targetType });
    }
    if (!targetType) return { targetType: null, changes };
    const mapped = fieldMap(candidate, targetType);
    for (const [field, afterValue] of Object.entries(mapped)) {
      const beforeValue = current[field] || "";
      if (afterValue && normalizeText(beforeValue) !== normalizeText(afterValue)) {
        changes.push({ field, before: beforeValue, after: afterValue });
      }
    }
    return { targetType, changes };
  }

  return {
    cleanDOI,
    normalizeText,
    titleSimilarity,
    yearOf,
    inferType,
    scoreCandidate,
    crossrefToCandidate,
    openAlexToCandidate,
    dblpToCandidate,
    semanticScholarToCandidate,
    fieldMap,
    buildChanges
  };
});
