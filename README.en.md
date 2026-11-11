# Metadata Reconciler for Zotero

[简体中文](README.md) | English

Find different versions of a paper in Zotero, verify its publication type and metadata, and preview changes before applying them.

## Installation and use

Requires **Zotero 10.0.x**. Download the `.xpi` from [Releases](https://github.com/Alioth5670/zotero-metadata-reconciler/releases), then install it under Tools → Plugins → Install Plugin From File. Select items, run the metadata review, and check sources and proposed changes before applying them.

## Sources and data

The plugin first tries a background Scholar lookup and follows “All versions” for a matching result. If access is restricted, open the built-in viewer manually and use “Read current page.” Public sources, including arXiv and DOI records, provide additional evidence. Optional SerpApi fallback can consume up to four calls per paper.

Lookups send titles or DOIs to the selected services, but do not upload PDFs, notes, or annotations. SerpApi credentials are stored via Zotero's credential manager. A repository copy is not evidence of formal publication. Scholar availability depends on the network and site restrictions.

## Build

Run `pwsh -File build-zotero10.ps1`. The XPI is written to `build/`. Standalone checks are in `tests/`; browser tests require Playwright and Microsoft Edge.
