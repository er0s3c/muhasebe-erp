<#
.SYNOPSIS
  Muhasebe ERP kurulum sihirbazı — Windows 10/11, Windows Server 2019+

.DESCRIPTION
  1) Uyumluluk kontrolü  2) Yol seçimi  3) Yapılandırma (sorular)  4) Gerekli paketler  5) Sistemin kurulumu

  Tek betikle kurulum VE tüm yapılandırma: demo/boş veri, lisans, e-posta (SMTP), alan adı/sertifika (HTTPS), yedekleme, portlar.
  Etkileşimli sorar; her sorunun varsayılanı vardır (Enter kabul eder).

  Kip   dev  : depodan test/geliştirme kurulumu (Node 22 + PostgreSQL 16 ya da Docker'da veritabanı, demo verisi)
        prod : müşteri kurulumu (kaynaksız sürüm kiti; kit.json varsa varsayılan)
  Yol   docker : Docker Desktop ile (veritabanı + uygulama kapta)
        native : PostgreSQL 16 + uygulama Windows hizmeti olarak (Docker ve sanallaştırma gerekmez)

  Çift tıkla: Kur.cmd. Elle:
    powershell -ExecutionPolicy Bypass -File installer\install.ps1 [-Check] [-Mode dev|prod] [-Path docker|native]
      [-Access local|lan|domain] [-Domain erp.ornek.com] [-Port 3000] [-Tls auto|byo|selfsigned|none] [-Demo|-NoDemo]
      [-Yes] [-AnswersFile DOSYA] [-Reconfigure] [-DryRun] [-Start] [-Uninstall [-Purge [-IUnderstandPurge]]] [-AllowDowngrade]
      [-PgSuperPasswordFile DOSYA] [-RestoreDb yedek.dump]   (güncelleyicinin geri dönüşü: önce veritabanını yedekten yükler)
    -Yes             tüm sorulara varsayılanı verir (sormaz)
    -AnswersFile     sormaz; KEY=VALUE yanıt dosyasından okur (örnek: installer\answers.example). Yalnızca YENİ kurulumda ya da
                     -Reconfigure ile; kurulu sistemde yanıt dosyası/farklı ayar bayrağı verilirse sihirbaz durur (yok saymaz)
    -Reconfigure     kurulu sistemde yalnızca yapılandırmayı (SMTP, HTTPS, yedek, lisans adresi) yeniden sorar ve uygular
    -DryRun          sistemi değiştirmeden ne yazılacağını/silineceğini gösterir (parolalar maskeli; -Uninstall ile de)
    -Uninstall       programı, hizmeti ve görevleri kaldırır (yerel ya da Docker); veritabanı, ayarlar ve yedekler korunur
    -Purge           -Uninstall ile: sihirbazın oluşturduğu veritabanını, ayarları ve varsayılan yedekleri de KALICI siler.
                     'SIL' yazarak onay ister (-Yes bu onayı vermez); betikte yalnızca -IUnderstandPurge ile
    -AllowDowngrade  kurulu sürümden ESKİ bir kiti kurmaya izin verir (önerilmez)
    -PgSuperPasswordFile  mevcut PostgreSQL 'postgres' parolasını içeren dosya (okunduktan sonra silinir). -PgSuperPassword da
                     kabul edilir ama parola komut satırında görünür; UAC ile yeniden başlatmada sihirbaz onu geçici dosyaya taşır

  Windows PowerShell 5.1 ile uyumludur (PowerShell 7 gerekmez). Ayrıntı: docs/OPERATIONS.md §2.
#>
[CmdletBinding()]
param(
  [switch]$Check,
  [ValidateSet('', 'dev', 'prod')][string]$Mode = '',
  [ValidateSet('', 'docker', 'native')][string]$Path = '',
  [ValidateSet('', 'local', 'lan', 'domain')][string]$Access = '',
  [string]$Domain = '',
  [int]$Port = 0,
  [ValidateSet('', 'auto', 'byo', 'selfsigned', 'none')][string]$Tls = '',
  [string]$HttpPort = '',
  [string]$HttpsPort = '',
  [switch]$Yes,
  [switch]$Demo,
  [switch]$NoDemo,
  [string]$AnswersFile = '',
  [switch]$Reconfigure,
  [switch]$DryRun,
  [switch]$Start,
  [switch]$Uninstall,
  [switch]$Purge,
  [string]$PgSuperPassword = '',
  [string]$PgSuperPasswordFile = '',
  [switch]$IUnderstandPurge,
  [switch]$AllowDowngrade,
  [string]$RestoreDb = '',
  [switch]$Elevated
)

$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -eq 'Core' -and -not $IsWindows) { Write-Host 'Bu sihirbaz Windows içindir; Linux/WSL için ./install.sh kullanın.' -ForegroundColor Red; exit 1 }
Set-StrictMode -Version 1   # 2 yapılmaz: kayıt defterinde olmayan özelliklere erişim hata olurdu
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest ilerleme çubuğu indirmeyi çok yavaşlatır
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

# Yerel araçlara (psql, docker) giden boru ve konsol çıktısı UTF-8 (Windows PowerShell 5.1 varsayılanı ASCII/ANSI)
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
# Türkçe Windows'ta psql istemci kodlaması WIN1254 olur; UTF-8 SQL dosyalarındaki bazı baytlar (ör. 0x9E) dönüştürülemez
$env:PGCLIENTENCODING = 'UTF8'

$Root = Split-Path -Parent $PSScriptRoot
$Installer = Join-Path $Root 'installer'

# ---- Sabitler ---------------------------------------------------------------------------------------------------------
$NodeMajor = 22
$NodeMin = [version]'22.9.0'
$PgMajor = 16
# winget yoksa kullanılan EDB kurulum paketi (sessiz kurulum). Daha yenisi için -PgInstallerUrl yerine bu değeri güncelleyin.
$PgEdbVersion = '16.10-1'
$MinRamMb = 2048; $RecRamMb = 4096; $MinDiskMb = 5120; $RecDiskMb = 10240
$ProgDir = Join-Path $env:ProgramFiles 'MuhasebeERP'
$DataDir = Join-Path $env:ProgramData 'MuhasebeERP'
$SvcId = 'MuhasebeERP'
$DbName = 'erp'
# Yerelleştirilmiş grup adları (ör. "Yöneticiler") yerine SID: SYSTEM, Administrators, LocalService
$SidSystem = '*S-1-5-18'; $SidAdmins = '*S-1-5-32-544'; $SidLocalService = '*S-1-5-19'

# ---- Çıktı yardımcıları --------------------------------------------------------------------------------------------------
function Say([string]$m) { Write-Host $m }
function Info([string]$m) { Write-Host "  $m" }
function Ok([string]$m) { Write-Host '  ' -NoNewline; Write-Host ([char]0x2713) -ForegroundColor Green -NoNewline; Write-Host " $m" }
function Warn([string]$m) { Write-Host '  ! ' -ForegroundColor Yellow -NoNewline; Write-Host $m }
function Stage([string]$m) { Write-Host ''; Write-Host "== $m ==" -ForegroundColor Cyan }
function Die([string]$m) {
  Write-Host ''
  Write-Host ([char]0x2717 + " $m") -ForegroundColor Red
  if ($Elevated) { Read-Host 'Kapatmak için Enter' | Out-Null }
  exit 1
}

function Ask([string]$q, [string]$def, [string[]]$opts) {
  if (-not (Test-Interactive)) { return $def }
  $a = Read-Answer "$q [$def] ($($opts -join '/')): " $false
  if ([string]::IsNullOrWhiteSpace($a)) { return $def }
  if ($opts -contains $a.Trim()) { return $a.Trim() }
  return $def
}
function Confirm-Step([string]$q) {
  if (-not (Test-Interactive)) { return $true }
  $a = Read-Answer "$q [E/h]: " $false
  return ([string]::IsNullOrWhiteSpace($a) -or $a -match '^[EeYy]')
}

function New-RandomHex([int]$bytes) {
  $b = New-Object byte[] $bytes
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  return (($b | ForEach-Object { $_.ToString('x2') }) -join '')
}
function New-RandomB64([int]$bytes) {
  $b = New-Object byte[] $bytes
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  return ([Convert]::ToBase64String($b)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

# Ortam dosyaları BOM'suz UTF-8 yazılır (Node --env-file ve docker compose BOM'u anahtarın parçası sayar)
$Utf8NoBom = New-Object System.Text.UTF8Encoding $false
function Write-TextFile([string]$file, [string]$text) {
  $dir = Split-Path -Parent $file
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  [IO.File]::WriteAllText($file, $text.Replace("`r`n", "`n"), $Utf8NoBom)
}
function Set-EnvLine([string]$file, [string]$key, [string]$value) {
  $lines = @()
  if (Test-Path $file) { $lines = @([IO.File]::ReadAllLines($file)) }
  $found = $false
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -like "$key=*") { $lines[$i] = "$key=$value"; $found = $true }
  }
  if (-not $found) { $lines += "$key=$value" }
  Write-TextFile $file (($lines -join "`n") + "`n")
}
function Get-EnvValue([string]$file, [string]$key) {
  if (-not (Test-Path $file)) { return '' }
  foreach ($l in [IO.File]::ReadAllLines($file)) { if ($l -like "$key=*") { return $l.Substring($key.Length + 1) } }
  return ''
}

function Test-Admin {
  $p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
function Update-SessionPath {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
function Invoke-Native([string]$exe, [string[]]$argv, [string]$what) {
  & $exe @argv
  if ($LASTEXITCODE -ne 0) { Die "$what başarısız (çıkış kodu $LASTEXITCODE)" }
}
function Test-PortBusy([int]$p) {
  try { return [bool](Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue) } catch { return $false }
}
function Test-Url([string]$u) {
  try { Invoke-WebRequest -Uri $u -Method Head -UseBasicParsing -TimeoutSec 8 | Out-Null; return $true } catch { return $false }
}
function Wait-Ready([string]$url, [int]$seconds) {
  for ($i = 0; $i -lt $seconds; $i++) {
    try { $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3; if ($r.StatusCode -eq 200) { return $true } } catch { }
    Start-Sleep -Seconds 1
  }
  return $false
}
function Download([string]$url, [string]$file) {
  Info "İndiriliyor: $url"
  Invoke-WebRequest -Uri $url -OutFile $file -UseBasicParsing
}

# Yapılandırma kitaplıkları (installer\lib): yanıt dosyası, doğrulayıcılar, sorular, ayar yazımı, yeniden yapılandırma
. (Join-Path $PSScriptRoot 'lib\config.ps1')
. (Join-Path $PSScriptRoot 'lib\wizard.ps1')

# Komut satırında verilen ayar bayrakları: kurulu sistemde mevcut ayarla çelişirse sihirbaz durur (sessizce yok sayılmaz)
$script:FlagVal = @{}
foreach ($pair in @(@('Port', 'PORT'), @('Access', 'ACCESS'), @('Domain', 'DOMAIN'), @('Tls', 'TLS_MODE'), @('HttpPort', 'HTTP_PORT'), @('HttpsPort', 'HTTPS_PORT'))) {
  if ($PSBoundParameters.ContainsKey($pair[0]) -and "$($PSBoundParameters[$pair[0]])" -ne '' -and "$($PSBoundParameters[$pair[0]])" -ne '0') { $script:FlagVal[$pair[1]] = "$($PSBoundParameters[$pair[0]])" }
}
if ($Demo) { $script:FlagVal['DEMO'] = 'yes' }; if ($NoDemo) { $script:FlagVal['DEMO'] = 'no' }
if ($Purge -and -not $Uninstall) { Write-Host '-Purge yalnızca -Uninstall ile kullanılır' -ForegroundColor Red; exit 2 }

# ---- Bayraklar ve yanıt dosyası ----------------------------------------------------------------------------------------------
# Komut satırı bayrakları yanıt dosyasından önceliklidir. Yanıt anahtarları install.sh ile aynıdır (docs/OPERATIONS.md §2).
if ($AnswersFile) {
  if (-not (Test-Path -LiteralPath $AnswersFile)) { Die "Yanıt dosyası bulunamadı: $AnswersFile" }
  $AnswersFile = (Resolve-Path -LiteralPath $AnswersFile).Path   # UAC ile yeniden başlatmada çalışma klasörü değişir: mutlak yol
}
if ($Mode) { $script:A['MODE'] = $Mode }
if ($Path) { $script:A['INSTALL_PATH'] = $Path }
if ($Access) { $script:A['ACCESS'] = $Access }
if ($Domain) { $script:A['DOMAIN'] = $Domain }
if ($Port) { $script:A['PORT'] = "$Port" }
if ($Tls) { $script:A['TLS_MODE'] = $Tls }
if ($HttpPort) { $script:A['HTTP_PORT'] = $HttpPort }
if ($HttpsPort) { $script:A['HTTPS_PORT'] = $HttpsPort }
if ($Demo) { $script:A['DEMO'] = 'yes' }
if ($NoDemo) { $script:A['DEMO'] = 'no' }
if ($AnswersFile) { Import-Answers $AnswersFile }
if (-not $Mode -and $script:A['MODE']) { $Mode = $script:A['MODE'] }
if (-not $Path -and $script:A['INSTALL_PATH']) { $Path = $script:A['INSTALL_PATH'] }
if (-not $Access -and $script:A['ACCESS']) { $Access = $script:A['ACCESS'] }
if (-not $Domain -and $script:A['DOMAIN']) { $Domain = $script:A['DOMAIN'] }
if (-not $Port -and $script:A['PORT']) { $m = V-Port $script:A['PORT']; if ($m) { Die "PORT: $m" }; $Port = [int]$script:A['PORT'] }
if ($Mode -and @('dev', 'prod') -notcontains $Mode) { Die 'MODE dev ya da prod olmalı' }
if ($Path -and @('docker', 'native') -notcontains $Path) { Die 'INSTALL_PATH docker ya da native olmalı' }
if ($Access -and @('local', 'lan', 'domain') -notcontains $Access) { Die 'ACCESS local, lan ya da domain olmalı' }
if ($Domain) { $m = V-Host $Domain; if ($m) { Die "DOMAIN: $m" } }
if ($script:A['TLS_MODE'] -and @('auto', 'byo', 'selfsigned', 'none') -notcontains $script:A['TLS_MODE']) { Die 'TLS_MODE auto, byo, selfsigned ya da none olmalı' }
foreach ($k in @('HTTP_PORT', 'HTTPS_PORT')) { if ($script:A[$k]) { $m = V-Port $script:A[$k]; if ($m) { Die "${k}: $m" } } }
if ($script:A['DEMO']) { $d = ConvertTo-YesNo $script:A['DEMO']; if (-not $d) { Die "DEMO: 'evet' ya da 'hayır' yazın" }; $script:A['DEMO'] = $d }

# ---- Ortam algılama ------------------------------------------------------------------------------------------------------

$Kit = $null
if (Test-Path (Join-Path $Root 'kit.json')) { $Kit = Get-Content -Raw -Encoding UTF8 (Join-Path $Root 'kit.json') | ConvertFrom-Json }
$IsRepo = (Test-Path (Join-Path $Root 'package.json')) -and (Test-Path (Join-Path $Root 'apps\api'))
if (-not $Mode) { if ($Kit) { $Mode = 'prod' } else { $Mode = 'dev' } }
if ($Mode -eq 'dev' -and -not $IsRepo) { Die 'Geliştirme kurulumu depo klasöründen çalıştırılır (package.json bulunamadı).' }

# Yönetici yetkisi: paket/hizmet kurulumu için gerekir; yoksa UAC ile kendini yeniden başlatır
if (-not $Check -and -not $DryRun -and -not (Test-Admin)) {
  Say 'Yönetici yetkisi gerekiyor; Windows izin isteyecek…'
  $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Elevated')
  foreach ($k in $PSBoundParameters.Keys) {
    $v = $PSBoundParameters[$k]
    if ($k -eq 'AnswersFile') { $v = $AnswersFile }
    # Parola komut satırında (yeni sürecin argümanlarında) görünmesin: yalnızca bu kullanıcının okuyabildiği geçici dosyaya yazılır
    if ($k -eq 'PgSuperPassword') {
      $pf = [IO.Path]::GetTempFileName()
      [IO.File]::WriteAllText($pf, [string]$v, (New-Object System.Text.UTF8Encoding $false))
      $argv += '-PgSuperPasswordFile'; $argv += "`"$pf`""; continue
    }
    if ($v -is [switch]) { if ($v.IsPresent) { $argv += "-$k" } } else { $argv += "-$k"; $argv += "`"$v`"" }
  }
  Start-Process -FilePath 'powershell.exe' -ArgumentList $argv -Verb RunAs
  exit 0
}

function Get-NodeVersion {
  $n = Get-Command node -ErrorAction SilentlyContinue
  if (-not $n) { return $null }
  try { return [version]((& node -v).TrimStart('v')) } catch { return $null }
}
function Get-PgInstall {
  # EDB kurulumu kayıt defterine yazar: HKLM\SOFTWARE\PostgreSQL\Installations\* ve \Services\*
  $best = $null
  foreach ($k in @(Get-ChildItem 'HKLM:\SOFTWARE\PostgreSQL\Installations' -ErrorAction SilentlyContinue)) {
    $p = Get-ItemProperty $k.PSPath
    $ver = $null; try { $ver = [version]($p.Version -replace '[^0-9.].*$', '') } catch { }
    if (-not $ver) { continue }
    $svc = $p.'Service ID'
    $port = 5432
    $sk = "HKLM:\SOFTWARE\PostgreSQL\Services\$svc"
    if (Test-Path $sk) { $sp = Get-ItemProperty $sk; if ($sp.Port) { $port = [int]$sp.Port } }
    $o = [pscustomobject]@{ Version = $ver; Bin = (Join-Path $p.'Base Directory' 'bin'); Service = $svc; Port = $port }
    if (-not $best -or $o.Version -gt $best.Version) { $best = $o }
  }
  return $best
}
function Test-DockerReady {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { return 'missing' }
  & docker info *> $null; if ($LASTEXITCODE -ne 0) { return 'stopped' }
  & docker compose version *> $null; if ($LASTEXITCODE -ne 0) { return 'nocompose' }
  return 'ok'
}
function Get-MachineGuid {
  try { return ((Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Cryptography').MachineGuid -replace '-', '').ToLower() } catch { return '' }
}

# ---- 1) Uyumluluk kontrolü -----------------------------------------------------------------------------------------------
$Checks = New-Object System.Collections.ArrayList
$script:Fails = 0
function Add-Check([string]$name, [string]$state, [string]$msg) {
  [void]$Checks.Add([pscustomobject]@{ Name = $name; State = $state; Msg = $msg })
  if ($state -eq 'fail') { $script:Fails++ }
}
$DockerState = 'missing'; $PgInfo = $null

function Invoke-CompatCheck {
  Stage '1/5 Sistem uyumluluk kontrolü'
  $os = Get-CimInstance Win32_OperatingSystem
  $build = [int]$os.BuildNumber
  if ($build -ge 17763) { Add-Check 'İşletim sistemi' 'ok' "$($os.Caption) (derleme $build)" }
  else { Add-Check 'İşletim sistemi' 'fail' "$($os.Caption) (derleme $build) — Windows 10 1809+/Server 2019+ gerekir" }

  $arch = $env:PROCESSOR_ARCHITECTURE
  if ($arch -eq 'AMD64') { Add-Check 'İşlemci mimarisi' 'ok' 'x64' }
  elseif ($arch -eq 'ARM64') { Add-Check 'İşlemci mimarisi' 'warn' 'ARM64 — x64 öykünmesiyle çalışır, performans düşebilir' }
  else { Add-Check 'İşlemci mimarisi' 'fail' "$arch desteklenmiyor (64 bit Windows gerekir)" }

  $ramMb = [int]([long]$os.TotalVisibleMemorySize / 1024)
  if ($ramMb -lt $MinRamMb) { Add-Check 'Bellek' 'fail' "$ramMb MB (en az $MinRamMb MB)" }
  elseif ($ramMb -lt $RecRamMb) { Add-Check 'Bellek' 'warn' "$ramMb MB ($RecRamMb MB önerilir)" }
  else { Add-Check 'Bellek' 'ok' "$ramMb MB" }

  $drive = Get-PSDrive -Name ($env:SystemDrive.TrimEnd(':'))
  $diskMb = [int]($drive.Free / 1MB)
  if ($diskMb -lt $MinDiskMb) { Add-Check 'Boş disk' 'fail' "$diskMb MB, $($env:SystemDrive) (en az $MinDiskMb MB)" }
  elseif ($diskMb -lt $RecDiskMb) { Add-Check 'Boş disk' 'warn' "$diskMb MB ($RecDiskMb MB önerilir)" }
  else { Add-Check 'Boş disk' 'ok' "$diskMb MB ($($env:SystemDrive))" }

  if (Test-Admin) { Add-Check 'Yönetici yetkisi' 'ok' 'var' }
  else { Add-Check 'Yönetici yetkisi' 'info' 'kurulumda UAC ile istenecek' }

  Add-Check 'PowerShell' 'ok' $PSVersionTable.PSVersion.ToString()

  $hv = $false
  try { $hv = [bool](Get-CimInstance Win32_ComputerSystem).HypervisorPresent } catch { }
  $vt = $false
  try { $vt = [bool]((Get-CimInstance Win32_Processor | Select-Object -First 1).VirtualizationFirmwareEnabled) } catch { }
  if ($hv -or $vt) { Add-Check 'Sanallaştırma' 'ok' 'açık (Docker Desktop/WSL2 kullanılabilir)' }
  else { Add-Check 'Sanallaştırma' 'info' 'kapalı ya da bilinmiyor — Docker yerine yerel yol kullanılır' }

  $script:DockerState = Test-DockerReady
  switch ($script:DockerState) {
    'ok' { Add-Check 'Docker' 'ok' ((& docker version --format '{{.Server.Version}}') + ' + compose v2') }
    'stopped' { Add-Check 'Docker' 'info' 'kurulu ama çalışmıyor (Docker Desktop açık mı?) — yerel yol kullanılabilir' }
    'nocompose' { Add-Check 'Docker' 'warn' 'compose v2 yok (Docker Desktop güncelleyin)' }
    default { Add-Check 'Docker' 'info' "yok — yerel (Docker'sız) yol kullanılır" }
  }

  $nv = Get-NodeVersion
  if ($Mode -eq 'prod') { Add-Check 'Node.js' 'ok' 'gerekmez (kitte gömülü çalışma zamanı)' }
  elseif ($nv -and $nv -ge $NodeMin) { Add-Check 'Node.js' 'ok' $nv.ToString() }
  elseif ($nv) { Add-Check 'Node.js' 'info' "$nv eski — Node $NodeMajor kurulacak" }
  else { Add-Check 'Node.js' 'info' "yok — Node $NodeMajor kurulacak" }

  $script:PgInfo = Get-PgInstall
  if ($script:PgInfo -and $script:PgInfo.Version.Major -ge $PgMajor) { Add-Check 'PostgreSQL' 'ok' "$($script:PgInfo.Version) (port $($script:PgInfo.Port), hizmet $($script:PgInfo.Service))" }
  elseif ($script:PgInfo) { Add-Check 'PostgreSQL' 'info' "$($script:PgInfo.Version) kurulu; yerel yolda PostgreSQL $PgMajor ayrıca kurulur" }
  else { Add-Check 'PostgreSQL' 'info' "yok — yerel yolda PostgreSQL $PgMajor kurulur" }

  $ports = @(); $pEff = $Port; if (-not $pEff) { $pEff = 3000 }; if ($Mode -eq 'dev') { $ports = @(3000, 5173) } else { $ports = @($pEff) }
  $busy = @($ports | Where-Object { Test-PortBusy $_ })
  if ($busy.Count -gt 0) {
    if ($Mode -eq 'prod' -and (Get-Service $SvcId -ErrorAction SilentlyContinue)) { Add-Check 'Portlar' 'info' "$($busy -join ', ') kullanımda (mevcut Muhasebe ERP — yükseltilecek)" }
    else { Add-Check 'Portlar' 'warn' "$($busy -join ', ') kullanımda — -Port ile değiştirin ya da uygulamayı kapatın" }
  } else { Add-Check 'Portlar' 'ok' 'boş' }

  if (Test-Url 'https://nodejs.org') { Add-Check 'İnternet' 'ok' 'erişim var' }
  else { Add-Check 'İnternet' 'warn' "nodejs.org'a erişilemedi — paket indirme gerekirse başarısız olur" }

  if (Get-MachineGuid) { Add-Check 'Makine kimliği' 'ok' 'MachineGuid' } else { Add-Check 'Makine kimliği' 'warn' 'okunamadı (lisans parmak izi zayıf kalır)' }

  if ($Kit) {
    if ($Kit.target -eq 'win-x64') { Add-Check 'Sürüm kiti' 'ok' "$($Kit.version) ($($Kit.target))" }
    else { Add-Check 'Sürüm kiti' 'fail' "$($Kit.version) hedefi $($Kit.target) — Windows için win-x64 kitini kullanın" }
  } elseif ($Mode -eq 'prod') { Add-Check 'Kaynak' 'info' 'depo: Docker yolu imajı kaynaktan derler; yerel yol için önce kit üretin (npm run release)' }

  foreach ($c in $Checks) {
    $sym = '·'; $col = 'DarkGray'
    switch ($c.State) { 'ok' { $sym = [string][char]0x2713; $col = 'Green' } 'warn' { $sym = '!'; $col = 'Yellow' } 'fail' { $sym = [string][char]0x2717; $col = 'Red' } }
    Write-Host '  ' -NoNewline; Write-Host $sym -ForegroundColor $col -NoNewline
    Write-Host (' {0,-20} {1}' -f $c.Name, $c.Msg)
  }
}

# ---- 2) Yol seçimi ---------------------------------------------------------------------------------------------------------
function Select-InstallPath {
  Stage '2/5 Kurulum yolu'
  $dockerOk = ($script:DockerState -eq 'ok')
  $pgOk = ($script:PgInfo -and $script:PgInfo.Version.Major -ge $PgMajor)
  if ($Mode -eq 'prod') { $rec = 'native'; if ($dockerOk) { $rec = 'docker' }; if (-not $Kit) { $rec = 'docker' }; if ($script:Existing -and $script:ExistingPath) { $rec = $script:ExistingPath } }
  else { $rec = 'native'; if (-not $pgOk -and $dockerOk) { $rec = 'docker' } }
  if (-not $script:Path) {
    Info "Kip: $Mode   Önerilen yol: $rec"
    if ($Mode -eq 'dev') {
      Info "  docker : PostgreSQL Docker'da çalışır, Node bu bilgisayarda"
      Info "  native : PostgreSQL $PgMajor bu bilgisayara kurulur"
    } else {
      Info '  docker : veritabanı + uygulama Docker Desktop ile'
      Info "  native : PostgreSQL $PgMajor + uygulama Windows hizmeti olarak (Docker gerekmez)"
    }
    $script:Path = Ask 'Hangi yolla kurulsun?' $rec @('docker', 'native')
  }
  if ($script:Path -eq 'docker' -and -not $dockerOk) { Die "Docker yolu seçildi ama Docker Desktop çalışmıyor. Docker Desktop'ı başlatın ya da -Path native kullanın." }
  if ($Mode -eq 'prod' -and $script:Path -eq 'native' -and -not $Kit) { Die "Yerel müşteri kurulumu sürüm kitinden yapılır: 'npm run release -- --version=X --targets=win-x64' ile üretip kitteki Kur.cmd'yi çalıştırın." }
  if ($script:Fails -gt 0) { Die 'Uyumluluk kontrolünde engelleyici sorun var. Giderip sihirbazı yeniden çalıştırın.' }
  Ask-Access
  if ($script:Access -eq 'domain' -and $script:Path -ne 'docker') { Die 'Alan adı + HTTPS şimdilik Docker yolunda desteklenir; yerel yolda lan seçin.' }
  Ok "Yol: $Mode / $($script:Path) / erişim: $($script:Access)"
}

# ---- 3) Gerekli paketler -----------------------------------------------------------------------------------------------------
function Install-Node {
  $nv = Get-NodeVersion
  if ($nv -and $nv -ge $NodeMin) { Ok "Node.js $nv hazır"; return }
  $tmp = Join-Path $env:TEMP "erp-node-$(New-RandomHex 4)"
  New-Item -ItemType Directory -Path $tmp | Out-Null
  $base = "https://nodejs.org/dist/latest-v$NodeMajor.x"
  Download "$base/SHASUMS256.txt" (Join-Path $tmp 'SHASUMS256.txt')
  $line = Get-Content (Join-Path $tmp 'SHASUMS256.txt') | Where-Object { $_ -match 'node-v[0-9.]+-x64\.msi$' } | Select-Object -First 1
  if (-not $line) { Die 'nodejs.org üzerinde Node.js MSI paketi bulunamadı' }
  $sum, $file = ($line -split '\s+', 2)
  $msi = Join-Path $tmp $file
  Download "$base/$file" $msi
  if ((Get-FileHash -Algorithm SHA256 $msi).Hash.ToLower() -ne $sum.ToLower()) { Die 'Node.js paketinin SHA-256 özeti tutmadı (indirme bozuk)' }
  Info "Node.js kuruluyor ($file)…"
  $p = Start-Process msiexec.exe -ArgumentList @('/i', "`"$msi`"", '/qn', '/norestart') -Wait -PassThru
  if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { Die "Node.js kurulamadı (msiexec $($p.ExitCode))" }
  Remove-Item -Recurse -Force $tmp
  Update-SessionPath
  Ok "Node.js $(& node -v) kuruldu"
}

$script:PgSuperCache = ''
function Get-PgSuperPassword {
  $f = Join-Path $DataDir 'pg-superuser.txt'
  if ($script:PgSuperCache) { return $script:PgSuperCache }
  if ($PgSuperPasswordFile -and (Test-Path -LiteralPath $PgSuperPasswordFile)) {
    $script:PgSuperCache = ([IO.File]::ReadAllText($PgSuperPasswordFile)).Trim()
    Remove-Item -LiteralPath $PgSuperPasswordFile -Force -ErrorAction SilentlyContinue
    return $script:PgSuperCache
  }
  if ($PgSuperPassword) { return $PgSuperPassword }
  if (Test-Path $f) { return (Get-Content -Raw $f).Trim() }
  if ($Yes) { Die "Mevcut PostgreSQL'in süper kullanıcı (postgres) parolası gerekli: -PgSuperPassword ile verin." }
  $s = Read-Host "Mevcut PostgreSQL 'postgres' kullanıcısının parolası" -AsSecureString
  return [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
}

function Protect-DataDir {
  if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null }
  # Yalnızca SYSTEM ve Yöneticiler; uygulama hizmeti (LocalService) ayar dosyasını okur, günlük/yedek klasörüne yazar
  & icacls $DataDir /inheritance:r /grant:r "${SidSystem}:(OI)(CI)F" "${SidAdmins}:(OI)(CI)F" | Out-Null
}

function Install-Postgres {
  if ($script:PgInfo -and $script:PgInfo.Version.Major -ge $PgMajor) {
    Ok "PostgreSQL $($script:PgInfo.Version) kurulu"
    $svc = Get-Service $script:PgInfo.Service -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -ne 'Running') { Start-Service $script:PgInfo.Service }
    return
  }
  Protect-DataDir
  $superPw = New-RandomHex 16
  Write-TextFile (Join-Path $DataDir 'pg-superuser.txt') $superPw
  # Süper kullanıcı parolası kurulum programına komut satırıyla değil seçenek dosyasıyla (--optionfile) verilir; dosya yalnızca
  # SYSTEM/Yöneticiler okuyabilen veri klasöründedir ve kurulumdan sonra silinir.
  $optFile = Join-Path $DataDir 'pg-install.opt'
  Write-TextFile $optFile "mode=unattended`nunattendedmodeui=none`nsuperpassword=$superPw`nserverport=5432`nservicename=postgresql-x64-$PgMajor`nenable-components=server,commandlinetools`n"
  $installArgs = "--optionfile `"$optFile`""
  $installed = $false
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Info "PostgreSQL $PgMajor winget ile kuruluyor…"
    & winget install --id "PostgreSQL.PostgreSQL.$PgMajor" -e --silent --accept-package-agreements --accept-source-agreements --override $installArgs
    $installed = ($LASTEXITCODE -eq 0)
  }
  if (-not $installed) {
    $url = "https://get.enterprisedb.com/postgresql/postgresql-$PgEdbVersion-windows-x64.exe"
    $exe = Join-Path $env:TEMP "postgresql-$PgEdbVersion-windows-x64.exe"
    Download $url $exe
    $sig = Get-AuthenticodeSignature $exe
    if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'EnterpriseDB') { Die "PostgreSQL kurulum paketinin imzası doğrulanamadı ($($sig.Status))" }
    Info "PostgreSQL $PgEdbVersion kuruluyor (birkaç dakika sürebilir)…"
    $p = Start-Process $exe -ArgumentList $installArgs -Wait -PassThru
    if ($p.ExitCode -ne 0) { Die "PostgreSQL kurulamadı (çıkış kodu $($p.ExitCode)); günlük: $env:TEMP\install-postgresql.log" }
    Remove-Item -Force $exe
  }
  Remove-Item -LiteralPath $optFile -Force -ErrorAction SilentlyContinue
  $script:PgInfo = Get-PgInstall
  if (-not $script:PgInfo) { Die 'PostgreSQL kuruldu ama kayıt defterinde bulunamadı' }
  Ok "PostgreSQL $($script:PgInfo.Version) kuruldu (port $($script:PgInfo.Port))"
}

function Invoke-Prerequisites {
  Stage '4/5 Gerekli paketler'
  if ($Mode -eq 'dev') { Install-Node }
  if ($script:Path -eq 'native') { Install-Postgres } else { Ok "Docker hazır ($(& docker version --format '{{.Server.Version}}'))" }
}

# Süper kullanıcıyla psql. Parola ortam değişkeninde (komut satırında görünmez); -Stdin verilirse SQL standart girdiden okunur
# (parola içeren \set satırları için). -NoDie: hata durdurmaz, $true/$false döner (kaldırma adımları için).
function Invoke-Psql([string[]]$argv, [string]$Stdin = $null, [switch]$NoDie) {
  $env:PGPASSWORD = Get-PgSuperPassword
  try {
    $exe = Join-Path $script:PgInfo.Bin 'psql.exe'
    $base = @('-h', '127.0.0.1', '-p', $script:PgInfo.Port, '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q')
    if ($Stdin) { $out = $Stdin | & $exe @base @argv -f - } else { $out = & $exe @base @argv }
    $ok = ($LASTEXITCODE -eq 0)
    if ($NoDie) { return $ok }
    if (-not $ok) { Die 'PostgreSQL komutu başarısız (parola doğru mu?)' }
    return $out
  } finally { Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue }
}
function Test-PsqlRow([string]$sql) { $r = Invoke-Psql @('-tA', '-c', $sql); return ([string]($r -join '') -match '1') }

# ---- 4a) Geliştirme kurulumu -------------------------------------------------------------------------------------------
function Install-Dev {
  Stage '5/5 Geliştirme ortamı kurulumu'
  Set-Location $Root
  $envFile = Join-Path $Root '.env'
  if (-not (Test-Path $envFile)) {
    Write-TextFile $envFile ([IO.File]::ReadAllText((Join-Path $Root '.env.example')))
    Set-EnvLine $envFile 'JWT_SECRET' (New-RandomB64 48)
    Ok '.env oluşturuldu (rastgele JWT_SECRET)'
  } else { Ok '.env mevcut (dokunulmadı)' }

  if ($script:Path -eq 'docker') {
    Info "PostgreSQL Docker'da başlatılıyor…"
    Invoke-Native 'docker' @('compose', 'up', '-d', 'db') 'docker compose up'
    for ($i = 0; $i -lt 60; $i++) { & docker compose exec -T db pg_isready -h 127.0.0.1 -U postgres *> $null; if ($LASTEXITCODE -eq 0) { break }; Start-Sleep 1 }
    Get-Content -Raw (Join-Path $Root 'infra\postgres\init.sql') | & docker compose exec -T db psql -U postgres -v ON_ERROR_STOP=1 -q | Out-Null
    if ($LASTEXITCODE -ne 0) { Die 'Geliştirme rolleri oluşturulamadı' }
    Ok 'Veritabanı hazır (Docker, port 5432)'
  } else {
    Invoke-Psql @('-f', (Join-Path $Root 'infra\postgres\init.sql')) | Out-Null
    if ($script:PgInfo.Port -ne 5432) {
      Set-EnvLine $envFile 'DATABASE_URL' "postgres://erp_app:erp_app@localhost:$($script:PgInfo.Port)/erp_dev"
      Set-EnvLine $envFile 'MIGRATION_DATABASE_URL' "postgres://erp:erp@localhost:$($script:PgInfo.Port)/erp_dev"
    }
    Ok "Geliştirme rolleri ve veritabanları hazır (port $($script:PgInfo.Port))"
  }

  Info 'Bağımlılıklar kuruluyor (npm)…'
  if (Test-Path (Join-Path $Root 'node_modules')) { Invoke-Native 'npm' @('install', '--no-audit', '--no-fund', '--loglevel=error') 'npm install' }
  else { Invoke-Native 'npm' @('ci', '--no-audit', '--no-fund', '--loglevel=error') 'npm ci' }
  Ok 'npm bağımlılıkları hazır'
  Invoke-Native 'npm' @('run', '--silent', 'db:migrate') 'Migration'
  Ok 'Veritabanı şeması güncel'
  if ($script:A['DEMO'] -eq 'yes') { Invoke-Native 'npm' @('run', '--silent', 'db:seed') 'Demo verisi'; Ok 'Demo verisi yüklendi (giriş: demo@ornek.local / Demo-Sifre-123)' }
  else { Ok "Demo verisi yüklenmedi: boş uygulama (ilk hesap tarayıcıda 'Kayıt ol' ile açılır)" }

  Stage 'Hazır'
  Say '  Başlatmak için:   npm run dev'
  Say '  Tarayıcı:         http://localhost:5173'
  Say '  Testler:          npm test   (uçtan uca: npm run e2e)'
  if ($Start) { & npm run dev }
}

# ---- 4b) Müşteri kurulumu — Docker -------------------------------------------------------------------------------------
function Write-HostIdFile {
  Protect-DataDir
  $f = Join-Path $DataDir 'host-machine-id'
  $g = Get-MachineGuid
  if ($g) { Write-TextFile $f "$g`n" }
  return $f
}

function Install-ProdDocker {
  Stage '5/5 Sistem kurulumu (Docker)'
  Set-Location $Root
  $envFile = Join-Path $Root 'deploy\.env'
  $buildFlag = @()
  if ($Kit) {
    $image = "muhasebe-erp:$($Kit.version)"
    & docker image inspect $image *> $null
    if ($LASTEXITCODE -eq 0) { Ok "İmaj mevcut: $image" }
    else {
      Info "İmaj kitteki derlenmiş dosyalardan oluşturuluyor (temel imaj node:$NodeMajor indirilir)…"
      Invoke-Native 'docker' @('build', '-q', '-f', 'installer/docker/Dockerfile.kit', '--build-arg', "APP_VERSION=$($Kit.version)", '--build-arg', 'NODE_MODULES=docker/node_modules', '-t', $image, '.') 'docker build'
      Ok "İmaj hazır: $image"
    }
  } else {
    $image = 'muhasebe-erp:local'; $buildFlag = @('--build')
    Info 'Depodan kurulum: imaj kaynak koddan derlenecek'
  }
  $hostId = (Write-HostIdFile).Replace('\', '/')
  $fresh = $false
  if (-not (Test-Path $envFile)) {
    $fresh = $true
    $lines = @(
      "# Kurulum sihirbazının ürettiği ayarlar ($(Get-Date -Format s)). Parolalar yalnızca burada durur: dosyayı YEDEKLEYİN.",
      "POSTGRES_PASSWORD=$(New-RandomHex 24)",
      "ERP_OWNER_PASSWORD=$(New-RandomHex 24)",
      "ERP_APP_PASSWORD=$(New-RandomHex 24)",
      "JWT_SECRET=$(New-RandomB64 48)",
      "ERP_IMAGE=$image",
      "APP_VERSION=$(if ($Kit) { $Kit.version } else { 'dev' })",
      "ERP_HOST_ID_FILE=$hostId"
    )
    Build-EnvChanges 'docker'
    Write-SecureFile $envFile (Invoke-EnvApply $lines $script:Chg) $false
    Ok 'deploy\.env oluşturuldu (rastgele parolalar; yalnızca yöneticiler okur)'
    Write-TlsFiles
    $script:DemoPending = $script:A['DEMO']; $script:DemoSeeded = 'no'
    Write-WizardConf
  } else {
    Set-EnvLine $envFile 'ERP_IMAGE' $image
    Set-EnvLine $envFile 'ERP_HOST_ID_FILE' $hostId
    if ($Kit) { Set-EnvLine $envFile 'APP_VERSION' $Kit.version }
    Ok 'deploy\.env mevcut: parolalar ve ayarlar korundu, imaj güncellendi'
    $script:DemoPending = Get-Cur 'DEMO_PENDING' 'no'; $script:DemoSeeded = Get-Cur 'DEMO_SEEDED' 'no'; $script:A['DEMO'] = Get-Cur 'DEMO' 'no'
  }
  if ($Kit) { Install-Updater 'docker' $envFile }
  if ($RestoreDb) { Restore-DbDocker $RestoreDb }
  $argv = @('compose', '-f', 'deploy/docker-compose.prod.yml', '--env-file', 'deploy/.env')
  if (Get-EnvValue $envFile 'ERP_DOMAIN') { $argv += @('--profile', 'tls') }
  $argv += @('up', '-d') + $buildFlag
  Info 'Hizmetler başlatılıyor (docker compose up -d)…'
  Invoke-Native 'docker' $argv 'docker compose up'
  $p = Get-EnvValue $envFile 'APP_PORT'; if (-not $p) { $p = '3000' }
  if (-not (Wait-Ready "http://127.0.0.1:$p/api/health/ready" 180)) { Die 'Uygulama hazır olmadı: docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env logs app' }
  Ok 'Uygulama çalışıyor'
  if ($script:DemoPending -eq 'yes') {
    Info 'Demo verisi yükleniyor…'
    if (Invoke-DemoSeedDocker) { $script:SeededDemo = $true; $script:DemoPending = 'no'; $script:DemoSeeded = 'yes'; Ok 'Demo verisi yüklendi'; Write-WizardConf }
    else { Warn 'Demo verisi yüklenemedi (docker compose ... exec app node dist/demo.js seed; ALLOW_DEMO=true gerekir)' }
  } elseif ($fresh) { Ok 'Boş uygulama: demo/örnek veri yüklenmedi' }
  Write-BackupTask   # her kurulumda yeniden yazılır (kurulum klasörü değiştiyse görev de yeni yolu gösterir)
  if ($script:Access -eq 'lan' -and $script:A['TLS_MODE'] -eq 'none') { Add-FirewallRule ([int]$p) }
  elseif ($script:A['TLS_MODE'] -ne 'none') { Add-FirewallRule ([int]$script:A['HTTPS_PORT']) }
  Invoke-PostInstallChecks "http://127.0.0.1:$p"
  Complete-Prod ([int]$p)
}

# ---- 4c) Müşteri kurulumu — yerel Windows hizmeti ------------------------------------------------------------------
function Add-FirewallRule([int]$p) {
  if (Get-NetFirewallRule -DisplayName 'Muhasebe ERP' -ErrorAction SilentlyContinue) { return }
  if (Confirm-Step "Windows Güvenlik Duvarı'nda $p/tcp (özel ve etki alanı ağları) açılsın mı?") {
    New-NetFirewallRule -DisplayName 'Muhasebe ERP' -Direction Inbound -Protocol TCP -LocalPort $p -Action Allow -Profile Domain, Private | Out-Null
    Ok "Güvenlik duvarı: $p/tcp açıldı"
  }
}

function Remove-Junction([string]$p) { if (Test-Path $p) { & cmd.exe /c rmdir "`"$p`"" | Out-Null } }

function Get-WinswExe { return (Join-Path $ProgDir 'service\MuhasebeERP.exe') }

function Write-ServiceFiles([string]$pgService) {
  $svcDir = Join-Path $ProgDir 'service'
  if (-not (Test-Path $svcDir)) { New-Item -ItemType Directory -Path $svcDir | Out-Null }
  Copy-Item -Force (Join-Path $Root 'winsw\MuhasebeERP.exe') (Join-Path $svcDir 'MuhasebeERP.exe')
  $cur = Join-Path $ProgDir 'current\app'
  $logs = Join-Path $DataDir 'logs'
  $xml = @"
<service>
  <id>$SvcId</id>
  <name>Muhasebe ERP</name>
  <description>Muhasebe ERP uygulama sunucusu</description>
  <executable>$cur\runtime\node.exe</executable>
  <arguments>--env-file="$DataDir\erp.env" "$cur\dist\server.js"</arguments>
  <workingdirectory>$cur</workingdirectory>
  <startmode>Automatic</startmode>
  <delayedAutoStart>true</delayedAutoStart>
  <depend>$pgService</depend>
  <onfailure action="restart" delay="10 sec"/>
  <onfailure action="restart" delay="30 sec"/>
  <resetfailure>1 hour</resetfailure>
  <stoptimeout>30 sec</stoptimeout>
  <logpath>$logs</logpath>
  <log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>8</keepFiles></log>
</service>
"@
  Write-TextFile (Join-Path $svcDir 'MuhasebeERP.xml') $xml
}

function Get-BackupScriptPath {
  if ($script:Path -eq 'docker') { return (Join-Path $DataDir 'bin\erp-backup-docker.ps1') }
  return (Join-Path $ProgDir 'bin\erp-backup.ps1')
}

# Günlük yedek görevi (SYSTEM). Yerel yol: pg_dump, parola ortam değişkeninde (komut satırında görünmez). Docker yolu: kap içinde
# pg_dump (yerel soket, parolasız; Docker Desktop o saatte çalışıyor olmalı). Yollar tek tırnaklı PowerShell metni olarak
# kaçışlanır. Temizlik yalnızca erp-YYYYMMDD-HHMMSS.dump adlı dosyalara dokunur; en az 1 yedek (yeni alınan) kalır.
function Write-BackupTask {
  $keep = 14; [void][int]::TryParse([string]$script:A['BACKUP_KEEP'], [ref]$keep); if ($keep -lt 1) { $keep = 1 }
  $dir = [string]$script:A['BACKUP_DIR']
  $file = Get-BackupScriptPath
  $bin = Split-Path -Parent $file
  if (-not (Test-Path $bin)) { New-Item -ItemType Directory -Path $bin -Force | Out-Null }
  $head = @"
# Muhasebe ERP yedeği (pg_dump, özel biçim). Son $keep yedek tutulur. Ayar: install.ps1 -Reconfigure. Geri yükleme: docs/OPERATIONS.md §6
`$ErrorActionPreference = 'Stop'
`$dir = $(ConvertTo-PsLiteral $dir)
`$keep = $keep
if (-not (Test-Path -LiteralPath `$dir)) { New-Item -ItemType Directory -Path `$dir -Force | Out-Null }
`$out = Join-Path `$dir ('erp-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.dump')
`$part = "`$out.partial"
"@
  if ($script:Path -eq 'docker') {
    $body = @"
# Kap içindeki yerel soketle (parolasız) döküm; çıktı bayt bayt dosyaya kopyalanır (PowerShell borusu ikili veriyi bozar)
`$psi = New-Object Diagnostics.ProcessStartInfo 'docker'
`$psi.Arguments = 'compose -f deploy/docker-compose.prod.yml --env-file deploy/.env exec -T db pg_dump -U erp -Fc $DbName'
`$psi.WorkingDirectory = $(ConvertTo-PsLiteral $Root)
`$psi.UseShellExecute = `$false; `$psi.RedirectStandardOutput = `$true; `$psi.CreateNoWindow = `$true
`$p = [Diagnostics.Process]::Start(`$psi)
`$fs = [IO.File]::Create(`$part)
try { `$p.StandardOutput.BaseStream.CopyTo(`$fs) } finally { `$fs.Close() }
`$p.WaitForExit()
if (`$p.ExitCode -ne 0 -or (Get-Item -LiteralPath `$part).Length -eq 0) { Remove-Item -LiteralPath `$part -ErrorAction SilentlyContinue; throw 'docker exec pg_dump başarısız (Docker Desktop çalışıyor mu?)' }
"@
  } else {
    # Yeniden yapılandırmada uyumluluk kontrolü çalışmaz: PostgreSQL bilgisi burada okunur
    if (-not $script:PgInfo) { $script:PgInfo = Get-PgInstall }
    if (-not $script:PgInfo) { Die 'PostgreSQL kurulumu bulunamadı (kayıt defteri); yedek görevi yazılamadı' }
    $body = @"
`$url = ((Get-Content -LiteralPath $(ConvertTo-PsLiteral (Join-Path $DataDir 'migrate.env')) | Where-Object { `$_ -like 'MIGRATION_DATABASE_URL=*' }) -replace '^MIGRATION_DATABASE_URL=', '')
if (`$url -notmatch '^postgres(ql)?://([^:@/]+):([^@]*)@([^:/]+):([0-9]+)/([^?]+)') { throw 'MIGRATION_DATABASE_URL okunamadı' }
`$env:PGUSER = [Uri]::UnescapeDataString(`$Matches[2]); `$env:PGPASSWORD = [Uri]::UnescapeDataString(`$Matches[3])
`$env:PGHOST = `$Matches[4]; `$env:PGPORT = `$Matches[5]; `$env:PGDATABASE = `$Matches[6]
& $(ConvertTo-PsLiteral (Join-Path $script:PgInfo.Bin 'pg_dump.exe')) -Fc -f `$part
if (`$LASTEXITCODE -ne 0) { Remove-Item -LiteralPath `$part -ErrorAction SilentlyContinue; throw 'pg_dump başarısız' }
"@
  }
  $tail = @"
Move-Item -Force -LiteralPath `$part -Destination `$out
Get-ChildItem -LiteralPath `$dir -File | Where-Object { `$_.Name -match '^erp-[0-9]{8}-[0-9]{6}\.dump$' } | Sort-Object Name -Descending | Select-Object -Skip `$keep | ForEach-Object { Remove-Item -LiteralPath `$_.FullName -Force }
Write-Host "Yedek: `$out"
"@
  [IO.File]::WriteAllText($file, ($head + "`r`n" + $body + "`r`n" + $tail), (New-Object System.Text.UTF8Encoding $true))
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$file`""
  $trigger = New-ScheduledTaskTrigger -Daily -At $($script:A['BACKUP_TIME'])
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries
  Register-ScheduledTask -TaskName 'Muhasebe ERP Yedek' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  $note = ''; if ($script:Path -eq 'docker') { $note = ' — Docker Desktop o saatte çalışıyor olmalı' }
  Ok "Günlük yedek: $($script:A['BACKUP_TIME']) ($dir, son $keep)$note. Elle: powershell -ExecutionPolicy Bypass -File `"$file`""
}

# Yeniden yapılandırma başarısız olursa yedek görevi ve betiği eski haline döner
function Save-BackupTaskSnapshot {
  $snap = @{ Xml = $null; Script = $null; ScriptPath = (Get-BackupScriptPath) }
  try { $snap.Xml = Export-ScheduledTask -TaskName 'Muhasebe ERP Yedek' -ErrorAction Stop } catch { }
  if (Test-Path -LiteralPath $snap.ScriptPath) { $snap.Script = [IO.File]::ReadAllBytes($snap.ScriptPath) }
  return $snap
}
function Restore-BackupTaskSnapshot($snap) {
  try {
    if ($snap.Xml) { Register-ScheduledTask -TaskName 'Muhasebe ERP Yedek' -Xml $snap.Xml -Force | Out-Null }
    else { Unregister-ScheduledTask -TaskName 'Muhasebe ERP Yedek' -Confirm:$false -ErrorAction SilentlyContinue }
    if ($snap.Script) { [IO.File]::WriteAllBytes($snap.ScriptPath, $snap.Script) }
    elseif (Test-Path -LiteralPath $snap.ScriptPath) { Remove-Item -LiteralPath $snap.ScriptPath -Force }
  } catch { Warn "Yedek görevi geri yüklenemedi: $($_.Exception.Message)" }
}
function Remove-BackupTaskSnapshot($snap) { $snap.Script = $null; $snap.Xml = $null }

function Install-ProdNative {
  Stage '5/5 Sistem kurulumu (yerel Windows hizmeti)'
  $ver = $Kit.version
  if (-not (Test-Path (Join-Path $Root 'app\runtime\node.exe'))) { Die 'Kitte çalışma zamanı yok (app\runtime\node.exe); kit bozuk olabilir' }
  if (-not (Test-Path (Join-Path $Root 'winsw\MuhasebeERP.exe'))) { Die 'Kitte hizmet sarmalayıcısı yok (winsw\MuhasebeERP.exe)' }
  Protect-DataDir
  foreach ($d in @('logs', 'backups')) { $p = Join-Path $DataDir $d; if (-not (Test-Path $p)) { New-Item -ItemType Directory -Path $p | Out-Null } }
  & icacls (Join-Path $DataDir 'logs') /grant "${SidLocalService}:(OI)(CI)M" | Out-Null

  # Çalışan hizmet durdurulur (aynı sürüm klasörü yeniden yazılabilir; migration eski kod çalışırken uygulanmaz)
  $winsw = Get-WinswExe
  $hadService = [bool](Get-Service $SvcId -ErrorAction SilentlyContinue)
  if ($hadService) { & $winsw stop | Out-Null }

  $verDir = Join-Path $ProgDir "versions\$ver"
  if ((Test-Path $verDir) -and ((Resolve-Path $verDir).Path.TrimEnd('\') -eq (Resolve-Path $Root).Path.TrimEnd('\'))) {
    Ok "Sürüm $ver zaten yerinde ($verDir)"
  } else {
    Info "Sürüm $ver kopyalanıyor → $verDir"
    if (Test-Path $verDir) { Remove-Item -Recurse -Force $verDir }
    New-Item -ItemType Directory -Path $verDir -Force | Out-Null
    Copy-Item -Recurse (Join-Path $Root 'app') $verDir
    Copy-Item (Join-Path $Root 'kit.json') $verDir
    Copy-Item -Recurse (Join-Path $Root 'installer') $verDir
    # Geri dönüşte eski sürümün sihirbazı bu klasörden çalışır (hizmet sarmalayıcısı dahil)
    Copy-Item -Recurse (Join-Path $Root 'winsw') $verDir
  }
  & icacls $ProgDir /grant "${SidLocalService}:(OI)(CI)RX" | Out-Null

  $erpEnv = Join-Path $DataDir 'erp.env'
  $migEnv = Join-Path $DataDir 'migrate.env'
  $fresh = $false
  if ((Test-Path $erpEnv) -and (Test-Path $migEnv)) {
    Ok "Mevcut ayarlar korunuyor ($DataDir)"
    $script:DemoPending = Get-Cur 'DEMO_PENDING' 'no'; $script:DemoSeeded = Get-Cur 'DEMO_SEEDED' 'no'; $script:A['DEMO'] = Get-Cur 'DEMO' 'no'
  }
  else {
    $fresh = $true
    $ownerPw = New-RandomHex 24; $appPw = New-RandomHex 24
    $script:RolesCreated = 'yes'; $script:DbCreated = 'yes'
    if (Test-PsqlRow "select 1 from pg_roles where rolname = 'erp'") { $script:RolesCreated = 'no'; Warn "PostgreSQL'de 'erp' rolleri zaten var: parolaları yeni üretilenlerle değiştirilecek." }
    if (Test-PsqlRow "select 1 from pg_database where datname = '$DbName'") { $script:DbCreated = 'no'; Warn "PostgreSQL'de '$DbName' veritabanı zaten var: kullanılacak, kaldırmada (-Purge) SİLİNMEZ." }
    # Parolalar psql'e komut satırıyla değil standart girdiyle (\set) verilir
    $sql = "\set owner_pw $ownerPw`n\set app_pw $appPw`n" + [IO.File]::ReadAllText((Join-Path $Installer 'sql\bootstrap-prod.sql'))
    Invoke-Psql @('-v', "dbname=$DbName") $sql | Out-Null
    Ok "Veritabanı '$DbName' ve roller hazır"
    $pgPort = $script:PgInfo.Port
    $hostId = Write-HostIdFile
    $baseLines = @(
      "# Muhasebe ERP çalışma zamanı ayarları (kurulum: $(Get-Date -Format s)). Gizli: yalnızca SYSTEM, Yöneticiler ve hizmet okur. YEDEKLEYİN.",
      'NODE_ENV=production',
      "DATABASE_URL=postgres://erp_app:$appPw@127.0.0.1:$pgPort/$DbName",
      "JWT_SECRET=$(New-RandomB64 48)",
      "WEB_DIST_DIR=$ProgDir\current\app\web",
      "LICENSE_HOST_ID_FILE=$hostId",
      "APP_VERSION=$ver"
    )
    Build-EnvChanges 'native'
    Write-TextFile $erpEnv ((Invoke-EnvApply $baseLines $script:Chg) -join "`n")
    Write-TextFile $migEnv "# Şema sahibi bağlantısı: yalnızca migration ve yedek kullanır (uygulama hizmeti okumaz).`nMIGRATION_DATABASE_URL=postgres://erp:$ownerPw@127.0.0.1:$pgPort/$DbName`n"
    & icacls $erpEnv /grant "${SidLocalService}:R" | Out-Null
    & icacls (Join-Path $DataDir 'host-machine-id') /grant "${SidLocalService}:R" | Out-Null
    Ok "Ayarlar yazıldı ($erpEnv, $migEnv)"
    $script:DemoPending = $script:A['DEMO']; $script:DemoSeeded = 'no'
    Write-WizardConf
  }
  Set-EnvLine $erpEnv 'APP_VERSION' $ver
  if ($RestoreDb) { Restore-DbNative $RestoreDb }

  $current = Join-Path $ProgDir 'current'
  $prevTarget = $null
  if (Test-Path $current) { $prevTarget = [string]((Get-Item $current).Target | Select-Object -First 1); Remove-Junction $current }
  New-Item -ItemType Junction -Path $current -Target $verDir | Out-Null
  Info 'Veritabanı şeması kuruluyor/yükseltiliyor…'
  & (Join-Path $current 'app\runtime\node.exe') "--env-file=$migEnv" (Join-Path $current 'app\dist\migrate.js')
  if ($LASTEXITCODE -ne 0) {
    if ($prevTarget) { Remove-Junction $current; New-Item -ItemType Junction -Path $current -Target $prevTarget | Out-Null; if ($hadService) { & $winsw start | Out-Null } }
    Die 'Migration başarısız; önceki sürüm geri alındı (veritabanı değişmediyse). Ayrıntı yukarıda.'
  }

  Write-ServiceFiles $script:PgInfo.Service
  if (-not $hadService) {
    Invoke-Native $winsw @('install') 'Hizmet kaydı'
    # Hizmet en düşük yetkili yerleşik hesapla çalışır (LocalSystem değil)
    # Windows PowerShell 5.1 boş argümanı düşürür: boş parola '""' olarak verilir
    & sc.exe config $SvcId obj= 'NT AUTHORITY\LocalService' password= '""' | Out-Null
    if ($LASTEXITCODE -ne 0) { Warn 'Hizmet hesabı LocalService yapılamadı; LocalSystem ile çalışacak' }
  }
  Invoke-Native $winsw @('start') 'Hizmet başlatma'
  Ok 'Windows hizmeti: Muhasebe ERP (otomatik başlar; services.msc)'
  Write-BackupTask
  Install-Updater 'native' $erpEnv
  if (-not (Wait-Ready "http://127.0.0.1:$Port/api/health/ready" 90)) { Die "Uygulama hazır olmadı: günlük $DataDir\logs" }
  Ok 'Uygulama çalışıyor'
  if ($script:DemoPending -eq 'yes') {
    Info 'Demo verisi yükleniyor…'
    if (Invoke-DemoSeedNative) { $script:SeededDemo = $true; $script:DemoPending = 'no'; $script:DemoSeeded = 'yes'; Ok 'Demo verisi yüklendi'; Write-WizardConf }
    else { Warn 'Demo verisi yüklenemedi (node.exe dist\demo.js seed; ALLOW_DEMO=true gerekir)' }
  } elseif ($fresh) { Ok 'Boş uygulama: demo/örnek veri yüklenmedi' }
  if ($script:Access -eq 'lan') { Add-FirewallRule $Port }
  # Masaüstü kısayolu (tüm kullanıcılar)
  $url = "http://localhost:$Port"
  [IO.File]::WriteAllText((Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'Muhasebe ERP.url'), "[InternetShortcut]`r`nURL=$url`r`n", $Utf8NoBom)
  Invoke-PostInstallChecks "http://127.0.0.1:$Port"
  Complete-Prod $Port
}

# ---- Uzaktan güncelleme: güncelleyici (dakikada bir, SYSTEM) -------------------------------------------------------------
function Add-EnvSecret([string]$file, [string]$key, [string]$value) {
  if (-not (Get-EnvValue $file $key)) { Set-EnvLine $file $key $value }
}

function Install-Updater([string]$mode, [string]$envFile) {
  $nodeSrc = Join-Path $Root 'app\runtime\node.exe'
  $jsSrc = Join-Path $Root 'app\dist\updater.js'
  if (-not ((Test-Path $nodeSrc) -and (Test-Path $jsSrc))) { Warn 'Kitte güncelleyici yok; uzaktan güncelleme kapalı'; return }
  Add-EnvSecret $envFile 'ERP_UPDATER_TOKEN' (New-RandomHex 32)
  Add-EnvSecret $envFile 'ERP_KIT_TARGET' 'win-x64'
  Protect-DataDir
  $upd = Join-Path $DataDir 'updater'
  $work = Join-Path $DataDir 'updater-work'
  foreach ($d in @($upd, $work)) { if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d | Out-Null } }
  # Çalışan güncelleyicinin node.exe dosyasının üzerine yazılamaz; Windows çalışan dosyayı yeniden adlandırmaya izin verir
  $nodeDst = Join-Path $upd 'node.exe'
  try { Copy-Item -Force $nodeSrc $nodeDst -ErrorAction Stop }
  catch {
    $old = Join-Path $upd ('node.old-' + (New-RandomHex 3) + '.exe')
    Move-Item -Force $nodeDst $old
    Copy-Item -Force $nodeSrc $nodeDst
  }
  Get-ChildItem $upd -Filter 'node.old-*.exe' -ErrorAction SilentlyContinue | ForEach-Object { Remove-Item -Force $_.FullName -ErrorAction SilentlyContinue }
  Copy-Item -Force $jsSrc (Join-Path $upd 'updater.js')
  $cfg = [ordered]@{
    mode = $mode
    platform = 'win-x64'
    appUrl = "http://127.0.0.1:$Port"
    envFile = $envFile
    workDir = $work
    installArgs = @('-Port', "$Port", '-Access', $script:Access) + $(if ($script:Domain) { @('-Domain', $script:Domain) } else { @() })
  }
  if ($mode -eq 'docker') {
    $cfg.dockerDir = $Root; $cfg.dbName = $DbName
    # HTTPS (Caddy) varsa güncelleme sonrası HTTPS üzerinden de doğrulanır
    if ($script:A['TLS_MODE'] -and $script:A['TLS_MODE'] -ne 'none' -and $script:Domain) {
      $hp = 443; if ($script:A['HTTPS_PORT']) { $hp = [int]$script:A['HTTPS_PORT'] }
      $cfg.httpsCheck = [ordered]@{ port = $hp; host = $script:Domain }
    }
  }
  else {
    $cfg.nativePrefix = $ProgDir
    $cfg.backupCommand = @('powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $ProgDir 'bin\erp-backup.ps1'))
  }
  $cfgFile = Join-Path $DataDir 'updater.json'
  Write-TextFile $cfgFile ($cfg | ConvertTo-Json -Depth 4)
  $action = New-ScheduledTaskAction -Execute $nodeDst -Argument "`"$upd\updater.js`" `"--config=$cfgFile`"" -WorkingDirectory $upd
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)
  Register-ScheduledTask -TaskName 'Muhasebe ERP Güncelleyici' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  Ok "Uzaktan güncelleme hazır: sahip onaylayınca uygulanır (günlük: $work\updater.log)"
}

function Restore-DbNative([string]$file) {
  if (-not (Test-Path $file)) { Die "Yedek dosyası yok: $file" }
  $url = Get-EnvValue (Join-Path $DataDir 'migrate.env') 'MIGRATION_DATABASE_URL'
  if (-not $url) { Die 'migrate.env okunamadı' }
  Info "Veritabanı yedekten geri yükleniyor: $file"
  Invoke-Psql @('-c', "drop database if exists $DbName with (force)", '-c', "create database $DbName owner erp", '-c', "revoke all on database $DbName from public", '-c', "grant connect on database $DbName to erp_app") | Out-Null
  # Parola komut satırında görünmesin: bağlantı bilgileri ortam değişkenleriyle verilir
  if ($url -notmatch '^postgres(ql)?://([^:@/]+):([^@]*)@([^:/]+):([0-9]+)/([^?]+)') { Die 'MIGRATION_DATABASE_URL okunamadı' }
  $env:PGUSER = [Uri]::UnescapeDataString($Matches[2]); $env:PGPASSWORD = [Uri]::UnescapeDataString($Matches[3]); $env:PGHOST = $Matches[4]; $env:PGPORT = $Matches[5]
  $restoreDb = $Matches[6]
  try { Invoke-Native (Join-Path $script:PgInfo.Bin 'pg_restore.exe') @('--exit-on-error', '--single-transaction', '--no-owner', '--role=erp', '-d', $restoreDb, $file) 'Geri yükleme' }
  finally { foreach ($v in @('PGUSER', 'PGPASSWORD', 'PGHOST', 'PGPORT')) { Remove-Item "Env:\$v" -ErrorAction SilentlyContinue } }
  Ok 'Veritabanı geri yüklendi'
}

function Restore-DbDocker([string]$file) {
  if (-not (Test-Path $file)) { Die "Yedek dosyası yok: $file" }
  Info "Veritabanı yedekten geri yükleniyor (Docker): $file"
  $dc = @('compose', '-f', 'deploy/docker-compose.prod.yml', '--env-file', 'deploy/.env')
  & docker @dc stop app *> $null
  Invoke-Native 'docker' ($dc + @('up', '-d', 'db')) 'docker compose up db'
  for ($i = 0; $i -lt 60; $i++) { & docker @dc exec -T db pg_isready -h 127.0.0.1 -U postgres *> $null; if ($LASTEXITCODE -eq 0) { break }; Start-Sleep 1 }
  Invoke-Native 'docker' ($dc + @('exec', '-T', 'db', 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-c', "drop database if exists $DbName with (force)", '-c', "create database $DbName owner erp", '-c', "revoke all on database $DbName from public", '-c', "grant connect on database $DbName to erp_app")) 'Veritabanı yeniden oluşturma'
  # Döküm ikilidir: PowerShell borusu yerine cmd yönlendirmesiyle aktarılır (bayt bayt)
  $argLine = ($dc + @('exec', '-T', 'db', 'pg_restore', '-U', 'postgres', '--exit-on-error', '--single-transaction', '--no-owner', '--role=erp', '-d', $DbName)) -join ' '
  & cmd.exe /c "docker $argLine < `"$file`""
  if ($LASTEXITCODE -ne 0) { Die 'Geri yükleme başarısız' }
  Ok 'Veritabanı geri yüklendi'
}

function Complete-Prod([int]$p) {
  if ($script:A['TLS_MODE'] -ne 'none' -and $script:Domain) { $url = $script:BaseUrl; if (-not $url) { $url = New-BaseUrl } }
  elseif ($script:Access -eq 'lan') { $url = "http://$(Get-LanIp):$p" }
  else { $url = "http://localhost:$p" }
  Show-Summary $url
  if (-not $Yes -and -not $AnswersFile) { Start-Process $url }
}

# ---- Docker kurulumunun klasörü ----------------------------------------------------------------------------------------------
# Kurulum klasörü sabittir (uzaktan güncelleme dosyaları yerinde değiştirir). Taşınmış klasörde (.erp-tasindi) ya da çalışan Docker
# projesi başka klasördeyken eski kopyadan çalıştırılmaz; bu klasörde ayar yoksa canlı kurulumun ayarları buraya taşınır.
function Get-DockerLiveRoot {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { return '' }
  try {
    $wd = @(& docker ps -a --filter 'label=com.docker.compose.project=muhasebe-erp' --filter 'label=com.docker.compose.service=app' --format '{{.Label "com.docker.compose.project.working_dir"}}' 2>$null) | Select-Object -First 1
  } catch { return '' }
  if (-not $wd) { return '' }
  $wd = [string]$wd
  if ((Split-Path -Leaf $wd) -eq 'deploy') { return (Split-Path -Parent $wd) }
  return $wd
}
function Test-SamePath([string]$a, [string]$b) {
  try { return ([IO.Path]::GetFullPath($a).TrimEnd('\', '/') -ieq [IO.Path]::GetFullPath($b).TrimEnd('\', '/')) } catch { return $false }
}
function Assert-InstallLocation {
  $guard = Join-Path $Root '.erp-tasindi'
  if (Test-Path -LiteralPath $guard) { $to = (Get-Content -LiteralPath $guard -TotalCount 1); Die "Bu klasör artık kullanılmıyor: kurulum $to klasörüne taşındı. Sihirbazı oradan çalıştırın." }
  if ($Mode -ne 'prod' -or $script:Path -eq 'native') { return }
  $live = Get-DockerLiveRoot
  if (-not $live -or -not (Test-Path -LiteralPath (Join-Path $live 'deploy\.env'))) { return }
  if (Test-SamePath $live $Root) { return }
  if (-not (Test-Path (Join-Path $Root 'deploy\.env')) -and (Test-Path (Join-Path $DataDir 'erp.env')) -and $script:Path -ne 'docker') { return }
  if ((Test-Path (Join-Path $Root 'deploy\.env')) -and -not $env:ERP_UPDATER_RUN) { Die "Çalışan Docker kurulumu başka klasörde: $live. Bu klasör ($Root) eski bir kopya; sihirbazı canlı klasörden çalıştırın." }
  if ($Uninstall -or $Reconfigure) { Die "Çalışan Docker kurulumu $live klasöründe; kaldırma/yeniden yapılandırma oradan yapılır." }
  if ($DryRun) { Info "(kuru çalıştırma) Docker kurulumu $live klasöründen bu klasöre ($Root) taşınır: deploy\.env, Caddyfile.local, certs\, wizard.conf"; return }
  if (-not $env:ERP_UPDATER_RUN) {
    Warn "Çalışan Docker kurulumu başka klasörde: $live"
    Info "Bu kit klasörü ($Root) yeni kurulum klasörü olacak: ayarlar, parolalar ve sertifikalar buraya taşınır; eski klasöre yönlendirme notu bırakılır."
    if (-not (Confirm-Step 'Kurulum bu klasöre taşınsın mı?')) { Die 'Vazgeçildi (hiçbir şey değiştirilmedi)' }
  }
  $dst = Join-Path $Root 'deploy'
  if (-not (Test-Path $dst)) { New-Item -ItemType Directory -Path $dst -Force | Out-Null }
  foreach ($f in @('.env', 'Caddyfile.local', 'wizard.conf')) {
    $src = Join-Path (Join-Path $live 'deploy') $f
    if ((Test-Path -LiteralPath $src) -and -not (Test-Path -LiteralPath (Join-Path $dst $f))) { Copy-Item -LiteralPath $src -Destination (Join-Path $dst $f) }
  }
  if (Test-Path (Join-Path $dst '.env')) { Set-SecureAcl (Join-Path $dst '.env') $false }
  $certs = Join-Path (Join-Path $live 'deploy') 'certs'
  if ((Test-Path -LiteralPath $certs) -and -not (Test-Path -LiteralPath (Join-Path $dst 'certs'))) { Copy-Item -Recurse -LiteralPath $certs -Destination (Join-Path $dst 'certs') }
  $wc = Join-Path $dst 'wizard.conf'
  if (Test-Path -LiteralPath $wc) {
    $lines = @([IO.File]::ReadAllLines($wc))
    $old = 'BACKUP_DIR=' + (Join-Path $live 'backups')
    if ($lines -contains $old) { Write-SecureFile $wc ($lines | ForEach-Object { if ($_ -eq $old) { 'BACKUP_DIR=' + (Join-Path $Root 'backups') } else { $_ } }) $false; Warn "Eski yedekler $live\backups klasöründe kaldı; yeni yedekler $Root\backups klasörüne yazılır." }
  }
  [IO.File]::WriteAllText((Join-Path $live '.erp-tasindi'), "$Root`r`n# Muhasebe ERP kurulumu bu klasöre taşındı ($(Get-Date -Format s)). Bu klasördeki sihirbaz çalışmaz.`r`n", $Utf8NoBom)
  Ok "Docker kurulumunun ayarları taşındı: $live → $Root (eski klasörde .erp-tasindi notu)"
}

# ---- Kaldırma (yerel ya da Docker kurulumu) --------------------------------------------------------------------------------
# Kalıcı silme onayı: -Yes/-AnswersFile bu onayı VERMEZ; 'SIL' yazılır ya da betikte -IUnderstandPurge verilir.
function Confirm-Purge([string]$what) {
  Say ''
  Warn "KALICI SİLME: $what"
  if ($DryRun) { Info '(kuru çalıştırma: onay istenmez, hiçbir şey silinmez)'; return }
  if ($IUnderstandPurge) { Warn '-IUnderstandPurge verildi: onay sorulmadan siliniyor.'; return }
  $ans = $null
  if ($env:ERP_WIZARD_INPUT) { $ans = [string](Get-Content -LiteralPath $env:ERP_WIZARD_INPUT -TotalCount 1) }
  else {
    $redirected = $true; try { $redirected = [Console]::IsInputRedirected } catch { }
    if (-not [Environment]::UserInteractive -or $redirected) { Die 'Kalıcı silme onayı alınamadı (etkileşimsiz). Betikte bilerek silmek için -IUnderstandPurge ekleyin.' }
    $ans = Read-Host '  Geri alınamaz. Onaylamak için büyük harflerle SIL yazın'
  }
  if ($ans -cne 'SIL' -and $ans -cne 'SİL') { Die 'Onay verilmedi; hiçbir şey silinmedi.' }
}

# Adım: kuru çalıştırmada yalnızca yazılır; hata bir sonraki adımı durdurmaz (kaldırma yarıda kalmasın)
$script:StepErrors = 0
function Invoke-Step([string]$desc, [scriptblock]$sb) {
  if ($DryRun) { Info "(kuru) $desc"; return }
  try { & $sb } catch { $script:StepErrors++; Warn "$desc başarısız: $($_.Exception.Message)" }
}

function Invoke-Uninstall {
  $native = (Test-Path (Join-Path $DataDir 'erp.env')) -or [bool](Get-Service $SvcId -ErrorAction SilentlyContinue)
  $docker = Test-Path (Join-Path $Root 'deploy\.env')
  if ($script:Path -eq 'native') { $docker = $false } elseif ($script:Path -eq 'docker') { $native = $false }
  if ($native -and $docker) { Die 'Hem yerel hem Docker kurulumu bulundu: hangisinin kaldırılacağını -Path native ya da -Path docker ile belirtin' }
  if (-not $native -and -not $docker) { Die "Kaldırılacak kurulum bulunamadı (aranan: $DataDir\erp.env, $SvcId hizmeti, $Root\deploy\.env)" }
  if ($native) { $script:Path = 'native' } else { $script:Path = 'docker' }
  Import-ExistingSettings $script:Path
  if ($DryRun) { Warn 'KURU ÇALIŞTIRMA: hiçbir şey kaldırılmayacak/silinmeyecek; yalnızca yapılacaklar listelenir.' }
  if ($native) { Uninstall-Native } else { Uninstall-Docker }
  if ($script:StepErrors -gt 0) { Warn "$($script:StepErrors) adım tamamlanamadı (yukarıya bakın); sihirbazı yeniden çalıştırabilirsiniz." }
}

function Uninstall-Native {
  Stage 'Muhasebe ERP kaldırılıyor (yerel kurulum)'
  $bdir = Get-Cur 'BACKUP_DIR'
  $defBackups = Join-Path $DataDir 'backups'
  $dbCreated = Get-Cur 'DB_CREATED'
  if ($Purge) {
    if ($dbCreated -eq 'no') { $what = "ayarlar ve varsayılan yedekler ($DataDir). Veritabanı '$DbName' kurulumdan önce vardı: SİLİNMEZ" }
    else { $what = "VERİTABANI '$DbName' (tüm şirket verisi), ayarlar ve varsayılan yedekler ($DataDir)" }
    if ($bdir -and -not (Test-SamePath $bdir $defBackups)) { $what += ". Özel yedek klasörü ($bdir) KORUNUR" }
    Confirm-Purge $what
    # Süper kullanıcı parolası silmeden ÖNCE alınır (sorun varsa hiçbir şey silinmeden durur)
    if (-not $DryRun -and $dbCreated -ne 'no') { $script:PgInfo = Get-PgInstall; if ($script:PgInfo) { [void](Get-PgSuperPassword) } }
  }
  $winsw = Get-WinswExe
  if (Get-Service $SvcId -ErrorAction SilentlyContinue) {
    Invoke-Step 'Windows hizmeti durdurulup kaydı silinir (MuhasebeERP)' { & $winsw stop | Out-Null; & $winsw uninstall | Out-Null }
  }
  Invoke-Step 'zamanlanmış görevler silinir (Muhasebe ERP Yedek, Muhasebe ERP Güncelleyici)' {
    Unregister-ScheduledTask -TaskName 'Muhasebe ERP Yedek' -Confirm:$false -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName 'Muhasebe ERP Güncelleyici' -Confirm:$false -ErrorAction SilentlyContinue
  }
  Invoke-Step "program dosyaları silinir ($ProgDir), masaüstü kısayolu ve güvenlik duvarı kuralı" {
    Remove-Junction (Join-Path $ProgDir 'current')
    if (Test-Path $ProgDir) { Remove-Item -Recurse -Force $ProgDir }
    Remove-Item -Force (Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'Muhasebe ERP.url') -ErrorAction SilentlyContinue
    Get-NetFirewallRule -DisplayName 'Muhasebe ERP' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  }
  if (-not $DryRun) { Ok 'Program dosyaları, hizmet ve zamanlanmış görevler kaldırıldı' }
  if ($Purge) {
    if ($dbCreated -eq 'no') { Info "Veritabanı '$DbName' kurulumdan önce vardı: korunuyor" }
    elseif ($DryRun) { Info "(kuru) veritabanı silinir: $DbName; erp/erp_app rolleri silinir (başka veritabanında kullanılıyorsa korunur)" }
    elseif ($script:PgInfo) {
      if (Invoke-Psql @('-c', "drop database if exists `"$DbName`" with (force)") -NoDie) { Ok "Veritabanı silindi: $DbName" } else { $script:StepErrors++; Warn "Veritabanı silinemedi: $DbName" }
      if ((Get-Cur 'ROLES_CREATED') -eq 'no') { Info 'erp/erp_app rolleri kurulumdan önce vardı: korunuyor' }
      elseif (Invoke-Psql @('-c', 'drop role if exists erp_app', '-c', 'drop role if exists erp') -NoDie) { Ok 'Roller silindi' }
      else { Info 'erp/erp_app rolleri başka veritabanlarında kullanıldığı için korundu' }
    } else { Warn 'PostgreSQL bulunamadı: veritabanı silinemedi' }
    Invoke-Step "ayarlar ve varsayılan yedekler silinir ($DataDir)" { if (Test-Path $DataDir) { Remove-Item -Recurse -Force $DataDir } }
    if (-not $DryRun) { Ok 'Veritabanı, ayarlar ve varsayılan yedekler silindi (PostgreSQL programı kaldırılmadı)' }
  } else { Info "Korunanlar: veritabanı ($DbName), ayarlar ($DataDir), yedekler ($(if ($bdir) { $bdir } else { $defBackups })). Tamamen silmek için: -Uninstall -Purge" }
}

function Uninstall-Docker {
  Stage "Muhasebe ERP kaldırılıyor (Docker kurulumu: $Root)"
  $bdir = Get-Cur 'BACKUP_DIR' (Join-Path $Root 'backups')
  $defBackups = Join-Path $Root 'backups'
  if ($Purge) {
    $what = "Docker birimleri (VERİTABANI pgdata — tüm şirket verisi — ve Caddy sertifikaları), $Root\deploy içindeki ayarlar (.env, Caddyfile.local, certs, wizard.conf)"
    if (Test-SamePath $bdir $defBackups) { $what += ", yedek klasörü ($bdir)" } else { $what += ". Özel yedek klasörü ($bdir) KORUNUR" }
    Confirm-Purge $what
  }
  $dc = @('compose', '-f', (Join-Path $Root 'deploy\docker-compose.prod.yml'), '--env-file', (Join-Path $Root 'deploy\.env'), '--profile', 'tls')
  if ($Purge) { Invoke-Step 'kaplar ve birimler (veritabanı dahil) silinir: docker compose down -v' { & docker @dc down -v --remove-orphans; if ($LASTEXITCODE -ne 0) { throw "docker compose down -v ($LASTEXITCODE)" } } }
  else { Invoke-Step 'kaplar durdurulup silinir (birimler/veritabanı korunur): docker compose down' { & docker @dc down --remove-orphans; if ($LASTEXITCODE -ne 0) { throw "docker compose down ($LASTEXITCODE)" } } }
  Invoke-Step 'zamanlanmış görevler ve güncelleyici dosyaları silinir' {
    Unregister-ScheduledTask -TaskName 'Muhasebe ERP Yedek' -Confirm:$false -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName 'Muhasebe ERP Güncelleyici' -Confirm:$false -ErrorAction SilentlyContinue
    foreach ($p in @('updater', 'updater-work', 'updater.json', 'bin')) { $x = Join-Path $DataDir $p; if (Test-Path -LiteralPath $x) { Remove-Item -Recurse -Force -LiteralPath $x } }
  }
  if ($Purge) {
    Invoke-Step "ayarlar silinir: $Root\deploy\(.env, Caddyfile.local, certs, wizard.conf)" {
      foreach ($p in @('.env', 'Caddyfile.local', 'certs', 'wizard.conf')) { $x = Join-Path (Join-Path $Root 'deploy') $p; if (Test-Path -LiteralPath $x) { Remove-Item -Recurse -Force -LiteralPath $x } }
    }
    if (Test-SamePath $bdir $defBackups) { Invoke-Step "yedekler silinir: $bdir" { if (Test-Path -LiteralPath $bdir) { Remove-Item -Recurse -Force -LiteralPath $bdir } } }
    if (-not (Test-Path (Join-Path $DataDir 'erp.env'))) { Invoke-Step "uygulama verisi silinir ($DataDir)" { if (Test-Path $DataDir) { Remove-Item -Recurse -Force $DataDir } } }
    if (-not $DryRun) { Ok 'Veritabanı birimi, ayarlar ve varsayılan yedekler silindi' }
  } else { Info "Korunanlar: veritabanı (Docker birimi muhasebe-erp_pgdata), ayarlar ($Root\deploy\.env…), yedekler ($bdir). Tamamen silmek için: -Uninstall -Purge" }
}

# ---- Akış ---------------------------------------------------------------------------------------------------------------
Say 'Muhasebe ERP kurulum sihirbazı (Windows)'
Assert-InstallLocation
if ($Uninstall) { Invoke-Uninstall; if ($Elevated) { Read-Host 'Kapatmak için Enter' | Out-Null }; exit 0 }
if ($Reconfigure) { Invoke-Reconfigure; if ($Elevated) { Read-Host 'Kapatmak için Enter' | Out-Null }; exit 0 }
if ($DryRun) { Warn 'KURU ÇALIŞTIRMA: sistemde hiçbir şey değiştirilmeyecek.' }
Find-Existing
Assert-NoDowngrade
Invoke-CompatCheck
if ($Check) {
  if ($script:Fails -gt 0) { Die 'Engelleyici sorun var.' }
  Say ''; Ok 'Kurulum yapılabilir.'; exit 0
}
Select-InstallPath
Invoke-Configure
if ($DryRun) { Show-DryRun; exit 0 }
Invoke-Prerequisites
if ($Mode -eq 'dev') { Install-Dev }
elseif ($script:Path -eq 'docker') { Install-ProdDocker }
else { Install-ProdNative }
if ($Elevated) { Read-Host 'Kapatmak için Enter' | Out-Null }
