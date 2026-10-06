param([Parameter(Mandatory=$true)][ValidateSet('Status','Restart','Backup','Restore','Repair','Support','OfflineUpdate')][string]$Operation,[string]$File='',[string]$Manifest='',[switch]$Confirmed)
$ErrorActionPreference='Stop'
$taskData=Join-Path $env:ProgramData 'MuhasebeERP'
$taskProgram=Join-Path $env:ProgramFiles 'MuhasebeERP'
$taskCurrent=Join-Path $taskProgram 'current'
$taskEnv=Join-Path $taskData 'erp.env'
if(-not (Test-Path -LiteralPath $taskEnv)){throw 'Bu bilgisayarda Muhasebe ERP kurulumu bulunamadı'}
$taskLines=Get-Content -LiteralPath $taskEnv
$taskPort=3000;$taskPortLine=$taskLines | Where-Object {$_ -match '^PORT=\d+$'} | Select-Object -First 1
if($taskPortLine){$taskPort=[int]($taskPortLine -split '=')[1]}
$taskKit=Get-Content -Raw -LiteralPath (Join-Path $taskCurrent 'kit.json') | ConvertFrom-Json
function Backup-Installation { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $taskProgram 'bin/erp-backup.ps1'); if($LASTEXITCODE -ne 0){throw 'Yedekleme başarısız; bakım işlemi başlamadı'} }
function Assert-Checksum([string]$Path) { if(-not (Test-Path -LiteralPath $Path) -or -not (Test-Path -LiteralPath "$Path.sha256")){throw 'Yedek dosyası veya doğrulama özeti eksik'};$expected=((Get-Content -Raw -LiteralPath "$Path.sha256").Trim() -split '\s+')[0];if($expected -notmatch '^[0-9a-fA-F]{64}$' -or (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -ine $expected){throw 'Yedek değiştirilmiş veya bozulmuş'} }
$taskStatus=[ordered]@{product='MuhasebeERP';version=$taskKit.version;windowsBuild=[Environment]::OSVersion.Version.Build;services=@(Get-Service 'MuhasebeERP','MuhasebeERP-HTTPS','MuhasebeERP-PostgreSQL' -ErrorAction SilentlyContinue | Select-Object Name,@{n='Status';e={$_.Status.ToString()}});backupTask=(Get-ScheduledTask 'Muhasebe ERP Yedek' -ErrorAction SilentlyContinue | Select-Object TaskName,@{n='State';e={$_.State.ToString()}})}
switch($Operation){
  Status { $taskStatus | ConvertTo-Json -Depth 5 }
  Restart { Restart-Service 'MuhasebeERP';if(Get-Service 'MuhasebeERP-HTTPS' -ErrorAction SilentlyContinue){Restart-Service 'MuhasebeERP-HTTPS'};Write-Host 'Hizmetler yeniden başlatıldı.' }
  Backup { Backup-Installation }
  Repair { Backup-Installation;& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $taskCurrent 'installer/install.ps1') -Port $taskPort -Access local -DedicatedPostgres -Yes;if($LASTEXITCODE -ne 0){throw 'Onarım tamamlanamadı'} }
  Restore {
    if(-not $Confirmed){throw 'Geri yükleme için açık kullanıcı onayı gerekli'}
    $File=(Resolve-Path -LiteralPath $File).Path
    foreach($archive in @($File,"$File.files.gz","$File.settings.json")){Assert-Checksum $archive}
    Backup-Installation
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $taskCurrent 'installer/install.ps1') -Port $taskPort -Access local -DedicatedPostgres -RestoreDb $File -Yes
    if($LASTEXITCODE -ne 0){throw 'Geri yükleme tamamlanamadı; öncesinde alınan yedeği koruyun'}
    Write-Host 'Veritabanı ve bağlı dosyalar geri yüklendi.'
  }
  OfflineUpdate {
    if(-not $Confirmed){throw 'Çevrimdışı güncelleme için açık kullanıcı onayı gerekli'}
    $File=(Resolve-Path -LiteralPath $File).Path;$Manifest=(Resolve-Path -LiteralPath $Manifest).Path
    & (Join-Path $taskData 'updater/node.exe') (Join-Path $taskData 'updater/updater.js') "--config=$(Join-Path $taskData 'updater.json')" "--offline-archive=$File" "--offline-manifest=$Manifest" --confirm-offline
    if($LASTEXITCODE -ne 0){throw 'İmzalı güncelleme uygulanamadı'}
  }
  Support {
    # Deliberate allowlist: no logs, database rows, accounts, env values, license codes or local paths.
    $taskSupport=Join-Path $taskData 'support';New-Item -ItemType Directory -Path $taskSupport -Force | Out-Null
    $taskFile=Join-Path $taskSupport ('support-'+(Get-Date -Format yyyyMMdd-HHmmss)+'.json')
    [IO.File]::WriteAllText($taskFile,($taskStatus | ConvertTo-Json -Depth 5),(New-Object Text.UTF8Encoding $false))
    Write-Host "Kişisel bilgi içermeyen destek dosyası: $taskFile"
  }
}
