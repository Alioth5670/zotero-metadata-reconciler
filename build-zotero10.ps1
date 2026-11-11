param([string]$OutputDir = (Join-Path $PSScriptRoot "build"))
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression.FileSystem
$manifest = Join-Path $PSScriptRoot "manifest-zotero10.json"
$version = (Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw "Invalid manifest version" }
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
$target = Join-Path (Resolve-Path -LiteralPath $OutputDir).Path "metadata-reconciler-zotero10-$version.xpi"
$stream = [IO.File]::Open($target, [IO.FileMode]::CreateNew)
try {
  $zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $true)
  try {
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $manifest, "manifest.json") | Out-Null
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $PSScriptRoot "bootstrap.js"), "bootstrap.js") | Out-Null
    Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot "content") -File | ForEach-Object {
      [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, "content/$($_.Name)") | Out-Null
    }
  } finally { $zip.Dispose() }
} finally { $stream.Dispose() }
Write-Output $target
