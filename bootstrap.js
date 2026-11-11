var MetadataReconciler;
var MetadataReconcilerChromeHandle;

function log(message) {
  Zotero.debug("Metadata Reconciler: " + message);
}

function install() {
  log("installed");
}

async function startup({ id, version, rootURI }) {
  // Dialog documents must be loaded from a privileged chrome:// URL in Zotero
  // 10. Loading an XHTML window directly from the XPI's jar: URI can produce
  // an empty window even though the plugin itself is active.
  const aomStartup = Cc["@mozilla.org/addons/addon-manager-startup;1"]
    .getService(Ci.amIAddonManagerStartup);
  const manifestURI = Services.io.newURI(rootURI + "manifest.json");
  MetadataReconcilerChromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "metadata-reconciler", "content/"]
  ]);
  Services.scriptloader.loadSubScript(rootURI + "content/core.js");
  Services.scriptloader.loadSubScript(rootURI + "content/providers.js");
  Services.scriptloader.loadSubScript(rootURI + "content/reconciler.js");
  await MetadataReconciler.init({ id, version, rootURI });
  await Zotero.PreferencePanes.register({
    pluginID: id,
    id: "metadata-reconciler-settings",
    label: "文献类型与元数据核对",
    src: "chrome://metadata-reconciler/content/preferences.xhtml",
    scripts: ["chrome://metadata-reconciler/content/preferences.js"]
  });
  MetadataReconciler.addToAllWindows();
  log("started " + version);
}

function onMainWindowLoad({ window }) {
  MetadataReconciler?.addToWindow(window);
}

function onMainWindowUnload({ window }) {
  MetadataReconciler?.removeFromWindow(window);
}

function shutdown() {
  MetadataReconciler?.dispose();
  MetadataReconciler?.removeFromAllWindows();
  MetadataReconciler = undefined;
  MetadataReconcilerChromeHandle?.destruct();
  MetadataReconcilerChromeHandle = undefined;
  log("stopped");
}

function uninstall() {
  log("uninstalled");
}
