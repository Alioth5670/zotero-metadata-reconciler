# 文献版本核对 · Metadata Reconciler for Zotero

在 Zotero 中查找论文的不同版本，核对文献类型和元数据，并在应用前预览修改。

Find different versions of a paper in Zotero, verify its publication type and metadata, and preview changes before applying them.

## 安装与使用 / Installation and use

适用于 **Zotero 10.0.x**。从 [Releases](https://github.com/Alioth5670/zotero-metadata-reconciler/releases) 下载 `.xpi`，通过「工具 → 插件 → 从文件安装插件」安装。选中文献后，打开「核对文献类型与元数据」，对比候选来源和字段差异，再决定是否应用。

Requires **Zotero 10.0.x**. Download the `.xpi` from [Releases](https://github.com/Alioth5670/zotero-metadata-reconciler/releases), then install it under Tools → Plugins → Install Plugin From File. Select items, run the metadata review, and check sources and proposed changes before applying them.

## 来源与数据 / Sources and data

默认尝试在 Zotero 内置浏览器中后台查询 Scholar，并读取匹配结果的「所有版本」。遇到访问限制时，可手动打开内置窗口，再用「读取当前页」导入候选。arXiv、DOI 及其他公开来源提供补充信息。可选填 SerpApi 密钥作为备用；每篇最多 4 次 SerpApi 调用，按账号额度计费。

The plugin first tries a background Scholar lookup and follows “All versions” for a matching result. If access is restricted, open the built-in viewer manually and use “Read current page.” Public sources, including arXiv and DOI records, provide additional evidence. Optional SerpApi fallback can consume up to four calls per paper.

查询会向相关服务发送论文标题或 DOI，不会上传 PDF、笔记或批注。SerpApi 密钥通过 Zotero 凭据管理器保存。候选需要用户核对；仓储副本并不证明正式发表。后台 Scholar 能否加载取决于网络及站点访问限制。

Lookups send titles or DOIs to the selected services, but do not upload PDFs, notes, or annotations. SerpApi credentials are stored via Zotero's credential manager. A repository copy is not evidence of formal publication. Scholar availability depends on the network and site restrictions.

## 构建 / Build

Run `pwsh -File build-zotero10.ps1`. The XPI is written to `build/`. Standalone checks are in `tests/`; browser tests require Playwright and Microsoft Edge.
