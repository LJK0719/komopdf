$ErrorActionPreference = 'Stop'
$project = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$out = Join-Path $project 'native\vendor\sources\pdfium-wasm\out\wasm-release'
$node = Join-Path $project 'native\vendor\tools\emsdk\node\24.19.0_64bit\node.exe'

Push-Location $out
try {
  & $node '.\pdf_editor_edit_test.cjs' '/fonts/LXGWWenKai-Regular.ttf'
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
