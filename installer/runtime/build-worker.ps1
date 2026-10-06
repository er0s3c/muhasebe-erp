param([string]$Python='python',[string]$Target='win-x64')
$ErrorActionPreference='Stop'
$taskRoot=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$taskDir=Join-Path $taskRoot ".runtime/compiled-worker/$Target"
New-Item -ItemType Directory -Force -Path $taskDir | Out-Null
& $Python -m pip install 'Nuitka==2.8.9' 'ordered-set==4.1.0' 'zstandard==0.25.0' -r (Join-Path $PSScriptRoot 'requirements.txt')
if($LASTEXITCODE -ne 0){throw 'İşleyici derleme bağımlılıkları kurulamadı'}
& $Python -m nuitka --mode=standalone --assume-yes-for-downloads --include-package=ifcopenshell --include-package=pypdfium2 --include-package=PIL "--output-dir=$taskDir" (Join-Path $taskRoot 'apps/api/src/modules/construction-control/construction-worker.py')
if($LASTEXITCODE -ne 0){throw 'IFC/OCR işleyicisi derlenemedi'}
