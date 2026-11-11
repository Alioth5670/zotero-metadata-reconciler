(function () {
  "use strict";
  const args = window.arguments?.[0];
  const controller = args?.controller;
  const resultsNode = document.getElementById("results");
  const statusNode = document.getElementById("status");
  const applyButton = document.getElementById("apply");
  const applyHint = document.getElementById("apply-hint");
  let querying = true;
  let disposed = false;
  let renderTimer;
  let pendingResults;
  function detachQueryUI() {
    if (disposed) return;
    disposed = true;
    window.clearTimeout(renderTimer);
    pendingResults = null;
    controller?.cancelQueries?.();
    window._metadataResults = null;
  }
  window.addEventListener("pagehide", detachQueryUI, { once: true });
  window.addEventListener("unload", detachQueryUI, { once: true });

  function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[char]);
  }

  function render(results) {
    const safeResults = Array.isArray(results) ? results : [];
    resultsNode.innerHTML = safeResults.map((result, itemIndex) => {
      try {
      const allCandidates = Array.isArray(result?.candidates) ? result.candidates : [];
      const errors = Array.isArray(result?.errors) ? result.errors : [];
      const summary = result?.summary || {};
      const hasPreprint = allCandidates.some(candidate => candidate.targetType === "preprint" && candidate.score >= 0.82);
      const hasFormal = allCandidates.some(candidate => ["conferencePaper", "journalArticle"].includes(candidate.targetType) && candidate.score >= 0.82);
      const goodCandidates = allCandidates.filter((candidate) => Number(candidate?.score) >= 0.82 && candidate?.targetType);
      const candidateHTML = goodCandidates.map((candidate, candidateIndex) => {
        const defaultCandidate = candidateIndex === 0 && candidate.score >= 0.9;
        const changes = Array.isArray(candidate.changes) ? candidate.changes : [];
        const rows = changes.map((change) => `
          <tr>
            <td><button type="button" class="field-toggle" aria-pressed="${defaultCandidate ? "true" : "false"}" data-field="${escapeHTML(change.field)}" title="切换此字段">${defaultCandidate ? "☑" : "☐"}</button></td>
            <td>${escapeHTML(change.field)}</td>
            <td class="before">${escapeHTML(change.before || "（空）")}</td>
            <td class="after">${escapeHTML(change.after || "（空）")}</td>
          </tr>`).join("");
        return `<section class="candidate ${defaultCandidate ? "selected" : ""}" data-item-index="${itemIndex}" data-candidate-index="${allCandidates.indexOf(candidate)}">
          <div class="candidate-head">
            <button type="button" class="candidate-select" aria-pressed="${defaultCandidate ? "true" : "false"}">${defaultCandidate ? "已选择" : "选择此候选"}</button>
            <strong>${escapeHTML(candidate.source)}：${escapeHTML(candidate.title)}</strong>
            <span>${escapeHTML(candidate.versionLabel || "")}</span>
            <span class="score">匹配 ${(candidate.score * 100).toFixed(0)}%</span>
            ${candidate.sourceURL ? `<a href="${escapeHTML(candidate.sourceURL)}" target="_blank" rel="noreferrer">查看来源</a>` : ""}
          </div>
          ${candidate.versionEvidence ? `<div class="meta">版本线索：${escapeHTML(candidate.versionEvidence)}</div>` : ""}
          <table><thead><tr><th></th><th>字段</th><th>修复前</th><th>修复后</th></tr></thead><tbody>${rows || "<tr><td colspan='4'>没有字段差异</td></tr>"}</tbody></table>
        </section>`;
      }).join("");
      const discoveries = allCandidates.filter(candidate => !candidate.targetType && candidate.sourceURL).map(candidate =>
        `<div class="meta">发现版本（尚不能确定类型）：<a href="${escapeHTML(candidate.sourceURL)}" target="_blank" rel="noreferrer">${escapeHTML(candidate.title)}</a> · ${escapeHTML(candidate.versionEvidence || candidate.source)}</div>`
      ).join("");
      const conciseError = value => String(value || "").replace(/<!DOCTYPE[\s\S]*|<html[\s\S]*/i, "")
        .replace(/https?:\/\/([^\s/?]+)[^\s]*/g, "$1").slice(0, 180);
      const errorText = errors.length ? `<div class="warning">部分查询失败：${escapeHTML(errors.map(conciseError).join("；"))}</div>` : "";
      return `<article class="item"><h2>${escapeHTML(summary.title || "（无标题）")}</h2>
        <div class="meta">当前类型：${escapeHTML(summary.itemType)} · Zotero Key：${escapeHTML(summary.key)}</div>
        ${summary.createParent ? '<div class="notice">这是独立附件：选择并应用候选后，将按候选类型创建文献父条目，并挂接原附件。</div>' : ""}
        ${errorText}
        ${hasPreprint && !hasFormal ? '<div class="notice">已识别预印本版本；本次尚未核实正式发表版本。仓储副本不代表已被会议或期刊录用。</div>' : ""}
        ${candidateHTML || "<div class='warning'>未找到可信且可分类的候选；没有提出修改。</div>"}
        ${discoveries}
      </article>`;
      } catch (error) {
        return `<article class="item"><div class="warning">此条结果无法显示：${escapeHTML(error.message)}</div></article>`;
      }
    }).join("");

    for (const [index, article] of Array.from(resultsNode.querySelectorAll(".item")).entries()) {
      const title = safeResults[index]?.summary?.title || "";
      const button = document.createElementNS("http://www.w3.org/1999/xhtml", "button");
      button.type = "button";
      button.className = "scholar-search";
      button.textContent = controller.openScholarViewer ? "打开 Scholar 内置窗口" : "在 Google Scholar 中搜索";
      button.addEventListener("click", () => {
        if (controller.openScholarViewer) {
          try {
            controller.openScholarViewer(title);
            statusNode.textContent = "可在 Scholar 打开“所有版本”，然后回来点“读取当前页”。";
          } catch (_) { statusNode.textContent = "无法打开 Zotero 内置网页查看器。"; }
          return;
        }
        const url = `https://scholar.google.com/scholar?q=${encodeURIComponent('"' + title + '"')}`;
        if (controller.openExternalURL) controller.openExternalURL(url);
        else window.open(url, "_blank");
      });
      article.querySelector(".meta")?.append(" · ", button);
      if (controller.readScholarViewer) {
        const read = document.createElementNS("http://www.w3.org/1999/xhtml", "button");
        read.type = "button";
        read.className = "scholar-search";
        read.textContent = "读取当前页";
        read.disabled = querying;
        read.addEventListener("click", async () => {
          if (querying || disposed) return;
          read.disabled = true;
          const results = window._metadataResults;
          const result = results[index];
          statusNode.textContent = "正在核对内置窗口中的候选…";
          try {
            const imported = await controller.readScholarViewer(result.summary);
            if (disposed || results !== window._metadataResults) return;
            results[index] = { summary: result.summary, ...controller.prepareCandidates(result.summary,
              [...imported.candidates, ...result.candidates], [...result.errors, ...imported.errors]) };
            render(results);
            statusNode.textContent = "已读取当前页，请核对候选后选择应用。";
          } catch (error) {
            if (!disposed) statusNode.textContent = error.message || "无法读取当前页。";
          } finally { read.disabled = false; }
        });
        article.querySelector(".meta")?.append(" ", read);
      }
    }

    // Privileged Zotero documents sanitize interactive elements inserted through
    // innerHTML. Create controls with the DOM API after rendering static text.
    for (const section of resultsNode.querySelectorAll(".candidate")) {
      const result = safeResults[Number(section.dataset.itemIndex)];
      const candidate = result.candidates[Number(section.dataset.candidateIndex)];
      const selected = section.classList.contains("selected");
      const makeButton = (className, text, pressed) => {
        const button = document.createElementNS("http://www.w3.org/1999/xhtml", "button");
        button.type = "button";
        button.className = className;
        button.disabled = querying;
        button.textContent = text;
        button.setAttribute("aria-pressed", pressed ? "true" : "false");
        return button;
      };
      const head = section.querySelector(".candidate-head");
      head.querySelector(".candidate-select")?.remove();
      head.prepend(makeButton("candidate-select", selected ? "已选择" : "选择此候选", selected));
      const rows = section.querySelectorAll("tbody tr");
      (candidate.changes || []).forEach((change, index) => {
        const cell = rows[index]?.firstElementChild;
        if (!cell) return;
        const toggle = makeButton("field-toggle", selected ? "☑" : "☐", selected);
        toggle.dataset.field = change.field;
        toggle.title = "切换此字段";
        toggle.setAttribute("aria-label", `选择字段 ${change.field}`);
        cell.replaceChildren(toggle);
      });
    }

    function selectCandidate(section, selectAll) {
        const item = section.closest(".item");
        for (const other of item.querySelectorAll(".candidate")) {
          other.classList.toggle("selected", other === section);
          const selectButton = other.querySelector(".candidate-select");
          selectButton.setAttribute("aria-pressed", other === section ? "true" : "false");
          selectButton.textContent = other === section ? "已选择" : "选择此候选";
          if (selectAll || other !== section) {
            for (const toggle of other.querySelectorAll(".field-toggle")) {
              const enabled = other === section;
              toggle.setAttribute("aria-pressed", enabled ? "true" : "false");
              toggle.textContent = enabled ? "☑" : "☐";
            }
          }
        }
        updateApplyState();
    }

    for (const button of document.querySelectorAll(".candidate-select")) {
      button.addEventListener("click", (event) => {
        selectCandidate(event.target.closest(".candidate"), true);
      });
    }
    for (const toggle of document.querySelectorAll(".field-toggle")) {
      toggle.addEventListener("click", (event) => {
        const section = event.target.closest(".candidate");
        if (!section.classList.contains("selected")) selectCandidate(section, false);
        const enabled = event.target.getAttribute("aria-pressed") !== "true";
        event.target.setAttribute("aria-pressed", enabled ? "true" : "false");
        event.target.textContent = enabled ? "☑" : "☐";
        updateApplyState();
      });
    }
    updateApplyState();
    window._metadataResults = safeResults;
  }

  function updateApplyState() {
    const hasCandidate = Boolean(document.querySelector(".candidate.selected"));
    const selectedFields = document.querySelectorAll('.candidate.selected .field-toggle[aria-pressed="true"]').length;
    applyButton.disabled = querying || !hasCandidate || selectedFields === 0;
    applyHint.textContent = querying ? "正在查询，完成后可应用修改" : !hasCandidate
      ? "请先点击“选择此候选”"
      : selectedFields === 0 ? "请至少勾选一个字段" : `已选择 ${selectedFields} 个字段`;
  }

  async function run() {
    if (controller?.findScholarVersions) controller.LOOKUP_BUDGET_MS = 25000;
    querying = true;
    applyButton.textContent = "应用所选修改";
    updateApplyState();
    const deepSearch = document.getElementById("deep-search");
    if (deepSearch) deepSearch.disabled = true;
    for (const id of ["save-serp", "clear-serp", "serp-key"]) {
      const control = document.getElementById(id);
      if (control) control.disabled = true;
    }
    const providerStatus = document.getElementById("provider-status");
    if (providerStatus) providerStatus.textContent = controller?.providerSettings?.serpKey
      ? "优先后台浏览 Scholar；SerpApi 已配置为备用。"
      : "优先后台浏览 Scholar；arXiv 与其他免费来源可用。";
    document.title = `核对文献类型与元数据 ${controller?.version || ""}`;
    if (!controller || !args.itemIDs?.length) {
      statusNode.textContent = "无法读取选中文献";
      return;
    }
    try {
      const results = await controller.analyze(args.itemIDs, (done, total, title, partialResults) => {
        if (disposed) return;
        statusNode.textContent = `已完成 ${done}/${total}，查询中：${title}`;
        if (partialResults) {
          pendingResults = partialResults;
          if (!renderTimer) renderTimer = window.setTimeout(() => {
            renderTimer = null;
            if (!disposed && pendingResults) render(pendingResults);
            pendingResults = null;
          }, 300);
        }
      });
      if (disposed) return;
      window.clearTimeout(renderTimer);
      renderTimer = null;
      pendingResults = null;
      querying = false;
      render(results);
      statusNode.textContent = `查询完成：${results.length} 条文献`;
      if (deepSearch) deepSearch.disabled = false;
      for (const id of ["save-serp", "clear-serp", "serp-key"]) {
        const control = document.getElementById(id);
        if (control) control.disabled = false;
      }
    } catch (error) {
      if (disposed) return;
      querying = false;
      statusNode.textContent = "查询失败";
      resultsNode.textContent = error.stack || error.message;
      if (deepSearch) deepSearch.disabled = false;
      for (const id of ["save-serp", "clear-serp", "serp-key"]) {
        const control = document.getElementById(id);
        if (control) control.disabled = false;
      }
    }
  }

  applyButton.addEventListener("click", async () => {
    const selections = [];
    for (const section of document.querySelectorAll(".candidate.selected")) {
      const result = window._metadataResults[Number(section.dataset.itemIndex)];
      const candidate = result.candidates[Number(section.dataset.candidateIndex)];
      const enabledFields = new Set(Array.from(section.querySelectorAll('.field-toggle[aria-pressed="true"]')).map((node) => node.dataset.field));
      const changes = candidate.changes.filter((change) => enabledFields.has(change.field));
      if (!changes.length) continue;
      selections.push({
        itemID: result.summary.id,
        targetType: result.summary.createParent
          ? candidate.targetType
          : (enabledFields.has("itemType") ? candidate.targetType : result.summary.itemType),
        changes,
        creators: candidate.authors,
        replaceCreators: Boolean(result.summary.createParent),
        createParent: Boolean(result.summary.createParent),
        sourceAttachmentID: result.summary.sourceAttachmentID || null
      });
    }
    if (!selections.length) {
      statusNode.textContent = "没有可应用的字段，请先选择候选和字段。";
      return;
    }
    applyButton.disabled = true;
    statusNode.textContent = "正在写入并创建撤销快照…";
    try {
      const outcome = await controller.applySelections(selections);
      statusNode.textContent = `已应用 ${outcome.applied} 条、写入 ${outcome.changedFields} 个字段${outcome.skippedFields ? `，跳过 ${outcome.skippedFields} 个不适用字段` : ""}。`;
      applyButton.textContent = "已应用";
      for (const button of document.querySelectorAll(".candidate-select, .field-toggle")) button.disabled = true;
      applyHint.textContent = "修改已保存，可撤销最近一次应用";
    } catch (error) {
      statusNode.textContent = `应用失败：${error.message}`;
      applyButton.disabled = false;
    }
  });

  document.getElementById("undo").addEventListener("click", async () => {
    statusNode.textContent = "正在撤销…";
    try {
      const outcome = await controller.undoLast();
      statusNode.textContent = outcome.restored ? `已恢复 ${outcome.restored} 条。` : "没有可撤销的记录。";
    } catch (error) { statusNode.textContent = `撤销失败：${error.message}`; }
  });
  document.getElementById("close").addEventListener("click", () => {
    detachQueryUI();
    window.close();
  });
  document.getElementById("deep-search")?.addEventListener("click", () => {
    if (querying || disposed) return;
    controller.LOOKUP_BUDGET_MS = 25000;
    controller.lookupCache?.clear();
    run();
  });
  document.getElementById("provider-preferences")?.addEventListener("click", () => controller.openSettings?.());
  window.addEventListener("DOMContentLoaded", run, { once: true });
})();
