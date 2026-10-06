param([string]$Python = 'python', [string]$RuntimeDir = '', [string]$TessdataDir = '')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $RuntimeDir) { $RuntimeDir = Join-Path $projectRoot '.runtime\construction' }
if (-not $TessdataDir) { $TessdataDir = Join-Path $projectRoot 'apps\api\data\construction-runtime\tessdata' }
$runtimePython = Join-Path $RuntimeDir 'Scripts\python.exe'
if (-not (Test-Path -LiteralPath $runtimePython)) {
  & $Python -m venv $RuntimeDir
  if ($LASTEXITCODE -ne 0) { throw 'Python 3.10–3.12 ile sanal ortam oluşturulamadı.' }
}
& $runtimePython -m pip install -r (Join-Path $projectRoot 'installer\runtime\requirements.txt') --cache-dir (Join-Path $projectRoot '.cache\pip')
if ($LASTEXITCODE -ne 0) { throw 'Yerel IFC/PDF bağımlılıkları kurulamadı.' }
& $runtimePython (Join-Path $projectRoot 'installer\runtime\install-languages.py') $TessdataDir
if ($LASTEXITCODE -ne 0) { throw 'OCR dil dosyaları doğrulanamadı.' }
Write-Host "CONSTRUCTION_PYTHON=$runtimePython"
Write-Host "CONSTRUCTION_TESSDATA_DIR=$TessdataDir"
