$ErrorActionPreference = 'Stop'
$project = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$source = Join-Path $project 'native\vendor\sources\pdfium-wasm'
$out = Join-Path $source 'out\wasm-release'
$archive = Join-Path $out 'obj\libpdfium.a'
$emsdk = Join-Path $project 'native\vendor\tools\emsdk'
$work = Join-Path $project 'tmp\m0-wasm'
$probe = Join-Path $PSScriptRoot 'pdfium_wasm_probe.cpp'
$probeOut = Join-Path $work 'pdfium_wasm_probe.cjs'
$emxx = Join-Path $emsdk 'upstream\emscripten\em++.exe'
$node = Join-Path $emsdk 'node\24.19.0_64bit\node.exe'

if (-not (Test-Path $archive)) {
  throw "PDFium archive not found: $archive"
}

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
$env:EMSDK_NODE = $node
$env:EMSDK_PYTHON = Join-Path $emsdk 'python\3.13.3_64bit\python.exe'

& $emxx $probe $archive "-I$source" -O2 `
  -sALLOW_MEMORY_GROWTH=1 `
  -sMAXIMUM_MEMORY=1073741824 `
  -sINITIAL_MEMORY=67108864 `
  -sENVIRONMENT=node `
  -sEXIT_RUNTIME=1 `
  -sASSERTIONS=1 `
  -o $probeOut
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& $node $probeOut
exit $LASTEXITCODE
