var MetadataReconcilerPreferences = {
  async init() {
    const pane = document.getElementById("metadata-provider-pane");
    if (!pane || pane.dataset.initialized === "true") return;
    const controller = Zotero.MetadataReconciler;
    const input = document.getElementById("metadata-serp-key");
    const status = document.getElementById("metadata-serp-status");
    const save = document.getElementById("metadata-serp-save");
    const clear = document.getElementById("metadata-serp-clear");
    if (!controller) { status.textContent = "插件尚未启动，请重启 Zotero 后再试。"; return; }
    pane.dataset.initialized = "true";
    const refresh = () => {
      const configured = Boolean(controller.providerSettings.serpKey);
      input.value = "";
      input.placeholder = configured ? "已保存密钥；输入新密钥可替换" : "输入 API Key";
      status.textContent = configured ? "SerpApi 已配置。" : "未配置 SerpApi，将使用免费来源。";
    };
    const store = async value => {
      save.disabled = clear.disabled = true;
      status.textContent = "正在保存…";
      try { await controller.saveSerpApiKey(value); refresh(); }
      catch (_) { status.textContent = "保存失败，请确认 Zotero 凭据管理器可用后重试。"; }
      finally { save.disabled = clear.disabled = false; }
    };
    save.addEventListener("click", () => {
      if (!input.value.trim()) { status.textContent = "请先输入密钥；如需停用，请点击清除按钮。"; return; }
      store(input.value);
    });
    clear.addEventListener("click", () => store(""));
    refresh();
  }
};

// Zotero loads pane scripts into a sandbox before inserting the fragment.
// Bind the subsequent fragment load event directly instead of relying on an
// inline handler to resolve a sandbox-local variable in the window scope.
function metadataPaneLoaded(event) {
  if (event.target?.id !== "metadata-provider-pane") return;
  document.removeEventListener("load", metadataPaneLoaded, true);
  const ready = MetadataReconcilerPreferences.init();
  event.waitUntil?.(ready);
}
document.addEventListener("load", metadataPaneLoaded, true);
if (document.getElementById("metadata-provider-pane")) {
  document.removeEventListener("load", metadataPaneLoaded, true);
  MetadataReconcilerPreferences.init();
}
