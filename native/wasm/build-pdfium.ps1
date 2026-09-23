param(
  [switch]$SkipGenerate,
  [switch]$EditProbe
)

$ErrorActionPreference = 'Stop'
$project = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$source = Join-Path $project 'native\vendor\sources\pdfium-wasm'
$out = Join-Path $source 'out\wasm-release'
$emsdk = Join-Path $project 'native\vendor\tools\emsdk'
$work = Join-Path $project 'tmp\m0-wasm'
$gn = Join-Path $project 'native\vendor\tools\gn\gn.exe'
$ninja = Join-Path $project 'native\vendor\tools\ninja\ninja.exe'

$env:HOME = Join-Path $work 'home'
$env:USERPROFILE = $env:HOME
$env:LOCALAPPDATA = Join-Path $work 'local-app-data'
$env:APPDATA = Join-Path $work 'roaming-app-data'
$env:TEMP = Join-Path $work 'temp'
$env:TMP = $env:TEMP
$env:XDG_CACHE_HOME = Join-Path $work 'cache'
$env:EM_CACHE = Join-Path $work 'cache\emscripten'
$env:EMSDK = $emsdk.Replace('\', '/')
$env:EM_CONFIG = Join-Path $emsdk '.emscripten'
$env:EMSDK_NODE = Join-Path $emsdk 'node\24.19.0_64bit\node.exe'
$env:EMSDK_PYTHON = Join-Path $emsdk 'python\3.13.3_64bit\python.exe'
$env:PATH = @(
  $emsdk,
  (Join-Path $project 'native\vendor\tools\depot_tools'),
  (Join-Path $emsdk 'upstream\emscripten'),
  (Join-Path $emsdk 'upstream\bin'),
  (Split-Path $env:EMSDK_NODE),
  (Split-Path $env:EMSDK_PYTHON),
  (Split-Path $gn),
  (Split-Path $ninja),
  $env:PATH
) -join ';'

foreach ($path in @($env:HOME, $env:LOCALAPPDATA, $env:APPDATA, $env:TEMP, $env:EM_CACHE, $out)) {
  New-Item -ItemType Directory -Force -Path $path | Out-Null
}

if (-not $SkipGenerate) {
  Copy-Item (Join-Path $PSScriptRoot 'args.gn') (Join-Path $out 'args.gn') -Force
  $gnArgs = @("--root=$source", 'gen', $out)
  if ($EditProbe) { $gnArgs += '--root-target=//pdf_editor_bridge' }
  & $gn $gnArgs
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$target = if ($EditProbe) { 'pdf_editor_edit_test' } else { 'pdfium' }
& $ninja -C $out $target
exit $LASTEXITCODE
