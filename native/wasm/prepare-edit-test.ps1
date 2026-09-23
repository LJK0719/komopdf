$ErrorActionPreference = 'Stop'
$project = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$source = Join-Path $project 'native\vendor\sources\pdfium-wasm'
$destination = Join-Path $source 'pdf_editor_bridge'
$testdata = Join-Path $destination 'testdata'

New-Item -ItemType Directory -Force -Path $destination, $testdata | Out-Null
Copy-Item (Join-Path $project 'native\pdf-core\pdfium\form_edit.cc') $destination -Force
Copy-Item (Join-Path $project 'native\pdf-core\pdfium\form_edit.h') $destination -Force
Copy-Item (Join-Path $project 'native\pdf-core\pdfium\form_fields.cc') $destination -Force
Copy-Item (Join-Path $project 'native\pdf-core\pdfium\form_fields.h') $destination -Force
Copy-Item (Join-Path $project 'native\pdf-core\tests\pdfium_edit_test.cc') $destination -Force
Copy-Item (Join-Path $PSScriptRoot 'edit-test.BUILD.gn') (Join-Path $destination 'BUILD.gn') -Force
Copy-Item (Join-Path $project 'resources\downloads\fonts\lxgw-wenkai\LXGWWenKai-Regular.ttf') $testdata -Force
