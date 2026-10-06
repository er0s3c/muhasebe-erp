param([Parameter(Mandatory)][string]$Version,[Parameter(Mandatory)][string]$KitArchive,[string]$OutDir='release/windows')
$ErrorActionPreference='Stop'
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Windows paket sürümü X.Y.Z olmalı' }
$taskRoot=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$taskKit=(Resolve-Path -LiteralPath $KitArchive).Path
$taskOut=[IO.Path]::GetFullPath((Join-Path $taskRoot $OutDir))
if (-not $taskOut.StartsWith($taskRoot+'\')) { throw 'Çıktı depo içinde olmalı' }
New-Item -ItemType Directory -Force -Path $taskOut | Out-Null
& dotnet publish (Join-Path $PSScriptRoot 'Wizard/Wizard.csproj') -c Release -o "$taskOut/wizard" "-p:KitArchive=$taskKit"
if($LASTEXITCODE -ne 0){throw 'Görsel kurulum derlenemedi'}
& dotnet build (Join-Path $PSScriptRoot 'Bundle/Bundle.wixproj') -c Release "-p:WizardExe=$taskOut/wizard/MuhasebeERP-Kurulum.exe" "-p:ProductVersion=$Version" "-p:OutputPath=$taskOut/bundle/"
if($LASTEXITCODE -ne 0){throw 'Burn paketi derlenemedi'}
Write-Output "Kurulum: $taskOut/bundle/MuhasebeERP-Kurulum.exe"
