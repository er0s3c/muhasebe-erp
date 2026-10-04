# Muhasebe ERP kurulum sihirbazı — yapılandırma aşaması (Windows, PowerShell 5.1 uyumlu).
# install.ps1 tarafından dot-source edilir; install.sh + installer/lib/wizard.sh ile aynı soruları, anahtarları ve akışı uygular.
# Sorular: demo/boş, port, alan adı ve HTTPS, e-posta, lisans, yedek, kayıt. Ayrıca: yeniden yapılandırma, kuru çalıştırma, özet ekranı.

$script:Existing = $false
$script:ExistingPath = ''
$script:Chg = @()
$script:LicState = ''
$script:LicEnforced = ''
$script:SelfSignedInternal = $false
$script:MailTestDeferred = $false
$script:SeededDemo = $false
$script:SmtpUrl = ''
$script:MailFrom = ''
$script:BaseUrl = ''
$script:Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

# ---- Dosya yolları ve güvenli yazım ---------------------------------------------------------------------------------------
function Get-EnvPath { if ($script:Path -eq 'native') { return (Join-Path $DataDir 'erp.env') }; return (Join-Path $Root 'deploy\.env') }
function Get-ConfPath { if ($script:Path -eq 'native') { return (Join-Path $DataDir 'wizard.conf') }; return (Join-Path $Root 'deploy\wizard.conf') }
function Read-Lines([string]$f) { if (Test-Path -LiteralPath $f) { return @([IO.File]::ReadAllLines($f)) }; return @() }
function Set-SecureAcl([string]$file, [bool]$serviceRead) {
  & icacls $file /inheritance:r /grant:r "${SidSystem}:F" "${SidAdmins}:F" | Out-Null
  if ($serviceRead) { & icacls $file /grant "${SidLocalService}:R" | Out-Null }
}
# Yarım dosya kalmasın: önce .new yazılır, izinler verilir, sonra yerine taşınır
function Write-SecureFile([string]$file, [string[]]$lines, [bool]$serviceRead) {
  $new = "$file.new"
  Write-TextFile $new (($lines -join "`n") + "`n")
  Set-SecureAcl $new $serviceRead
  Move-Item -Force -LiteralPath $new -Destination $file
}
# Her dosyanın en yeni $script:BakKeep yedeği kalır (yedekler parola içerir; sınırsız birikmesin)
$script:BakKeep = 5
function Backup-Config([string[]]$files) {
  foreach ($f in $files) {
    if (-not (Test-Path -LiteralPath $f)) { continue }
    $b = "$f.bak-$($script:Stamp)"
    Copy-Item -LiteralPath $f -Destination $b -Force
    Set-SecureAcl $b $false
    Info "Eski ayar yedeklendi: $b"
    $leaf = Split-Path -Leaf $f
    $re = '^' + [regex]::Escape($leaf) + '\.bak-[0-9]{8}-[0-9]{6}$'
    Get-ChildItem -LiteralPath (Split-Path -Parent $f) -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match $re } |
      Sort-Object Name -Descending | Select-Object -Skip $script:BakKeep | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
  }
}

# ---- Mevcut kurulum ---------------------------------------------------------------------------------------------------------
function Find-Existing {
  $script:Existing = $false
  if ($Mode -ne 'prod') { return }
  $p = $script:Path
  if (-not $p) {
    if ((Test-Path (Join-Path $DataDir 'erp.env')) -and (Test-Path (Join-Path $DataDir 'migrate.env'))) { $p = 'native' }
    elseif (Test-Path (Join-Path $Root 'deploy\.env')) { $p = 'docker' }
  }
  if (-not $p) { return }
  $envf = if ($p -eq 'native') { Join-Path $DataDir 'erp.env' } else { Join-Path $Root 'deploy\.env' }
  if (-not (Test-Path -LiteralPath $envf)) { return }
  $script:Existing = $true; $script:ExistingPath = $p
  Import-ExistingSettings $p
}
function Import-ExistingSettings([string]$p) {
  $script:Cur = @{}
  $conf = if ($p -eq 'native') { Join-Path $DataDir 'wizard.conf' } else { Join-Path $Root 'deploy\wizard.conf' }
  $envf = if ($p -eq 'native') { Join-Path $DataDir 'erp.env' } else { Join-Path $Root 'deploy\.env' }
  foreach ($l in (Read-Lines $conf)) { if ($l -match '^([A-Z_]+)=(.*)$') { $script:Cur[$Matches[1]] = $Matches[2] } }
  if (-not (Get-Cur 'ACCESS')) {
    if ($p -eq 'docker') {
      $d = Get-EnvValue $envf 'ERP_DOMAIN'
      if ($d) { $script:Cur['ACCESS'] = 'domain'; $script:Cur['DOMAIN'] = $d; $script:Cur['TLS_MODE'] = 'auto' }
      elseif ((Get-EnvValue $envf 'APP_BIND') -eq '0.0.0.0') { $script:Cur['ACCESS'] = 'lan' } else { $script:Cur['ACCESS'] = 'local' }
      $script:Cur['PORT'] = Get-EnvValue $envf 'APP_PORT'
    } else {
      if ((Get-EnvValue $envf 'HOST') -eq '0.0.0.0') { $script:Cur['ACCESS'] = 'lan' } else { $script:Cur['ACCESS'] = 'local' }
      $script:Cur['PORT'] = Get-EnvValue $envf 'PORT'
    }
    if (-not (Get-Cur 'TLS_MODE')) { $script:Cur['TLS_MODE'] = 'none' }
  }
  if (-not (Get-Cur 'PORT')) { $script:Cur['PORT'] = '3000' }
  $su = Get-EnvValue $envf 'SMTP_URL'
  if ($su -match '^(smtps?)://(([^:/@]*):([^@]*)@)?([^:/?]+):([0-9]+)(\?(.*))?$') {
    $script:Cur['MAIL_ENABLED'] = 'yes'; $script:Cur['SMTP_HOST'] = $Matches[5]; $script:Cur['SMTP_PORT'] = $Matches[6]
    $script:Cur['SMTP_USER'] = ConvertFrom-UrlEncoded $Matches[3]; $script:Cur['SMTP_PASSWORD'] = ConvertFrom-UrlEncoded $Matches[4]
    if ($Matches[1] -eq 'smtps') { $script:Cur['SMTP_SECURITY'] = 'ssl' } elseif ($Matches[8] -like '*ignoreTLS*') { $script:Cur['SMTP_SECURITY'] = 'none' } else { $script:Cur['SMTP_SECURITY'] = 'starttls' }
    $mf = (Get-EnvValue $envf 'MAIL_FROM').Trim('"')
    if ($mf -match '^(.*)<([^>]+)>$') { $script:Cur['MAIL_FROM_NAME'] = $Matches[1].Trim(); $script:Cur['MAIL_FROM_ADDRESS'] = $Matches[2] } else { $script:Cur['MAIL_FROM_ADDRESS'] = $mf }
  } else { $script:Cur['MAIL_ENABLED'] = 'no' }
  $script:Cur['LICENSE_SERVER_URL'] = Get-EnvValue $envf 'LICENSE_SERVER_URL'
  $script:Cur['APP_BASE_URL'] = Get-EnvValue $envf 'APP_BASE_URL'
  if ((Get-EnvValue $envf 'REGISTRATION_ENABLED') -eq 'false') { $script:Cur['REGISTRATION'] = 'no' } else { $script:Cur['REGISTRATION'] = 'yes' }
  $script:Cur['APP_VERSION'] = Get-EnvValue $envf 'APP_VERSION'
  $script:DbCreated = Get-Cur 'DB_CREATED'; $script:RolesCreated = Get-Cur 'ROLES_CREATED'
  if (-not $Reconfigure) {
    if (-not $script:Access -and (Get-Cur 'ACCESS')) { $script:Access = Get-Cur 'ACCESS' }
    if (-not $script:Domain -and (Get-Cur 'DOMAIN')) { $script:Domain = Get-Cur 'DOMAIN' }
    if (-not $script:Port -and (Get-Cur 'PORT')) { $script:Port = [int](Get-Cur 'PORT') }
    foreach ($k in @('TLS_MODE', 'HTTP_PORT', 'HTTPS_PORT')) { if ($script:A[$k] -eq '' -and (Get-Cur $k)) { $script:A[$k] = Get-Cur $k } }
  }
}

# ---- Ağ yardımcıları -----------------------------------------------------------------------------------------------------------
function Get-LanIp {
  try { return (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop | Where-Object { $_.IPAddress -notmatch '^(127|169\.254)\.' } | Select-Object -First 1).IPAddress } catch { return '' }
}
function Resolve-HostIp([string]$h) {
  try { return (@([Net.Dns]::GetHostAddresses($h) | Where-Object { $_.AddressFamily -eq 'InterNetwork' } | ForEach-Object { $_.ToString() }) -join ' ') } catch { return '' }
}
function Get-PublicIp {
  try { $r = (Invoke-WebRequest -Uri 'https://api.ipify.org' -UseBasicParsing -TimeoutSec 6).Content.Trim(); if ($r -match '^[0-9.]+$') { return $r } } catch { }
  return ''
}
function New-BaseUrl {
  if ($script:A['TLS_MODE'] -ne 'none' -and $script:Domain) {
    $hp = $script:A['HTTPS_PORT']; if (-not $hp -or $hp -eq '443') { return "https://$($script:Domain)" }; return "https://$($script:Domain):$hp"
  }
  if ($script:Access -eq 'lan') { return "http://$(Get-LanIp):$Port" }
  return "http://localhost:$Port"
}

# ---- Ortam değişikliklerinin üretimi -----------------------------------------------------------------------------------------------
function Build-EnvChanges([string]$target) {
  $c = @()
  $reg = 'true'; if ($script:A['REGISTRATION'] -eq 'no') { $reg = 'false' }
  if ($target -eq 'docker') {
    $c += "APP_PORT=$Port"
    if ($script:A['TLS_MODE'] -eq 'none') {
      if ($script:Access -eq 'lan') { $c += 'APP_BIND=0.0.0.0' } else { $c += 'APP_BIND=127.0.0.1' }
      $c += @('COOKIE_SECURE=false', 'TRUST_PROXY=false', '-ERP_DOMAIN', '-ERP_CADDYFILE', '-ERP_CERT_DIR', '-HTTP_PORT', '-HTTPS_PORT')
    } else {
      $c += @('APP_BIND=127.0.0.1', '-COOKIE_SECURE', '-TRUST_PROXY', "ERP_DOMAIN=$($script:Domain)", 'ERP_CADDYFILE=./Caddyfile.local', "HTTP_PORT=$($script:A['HTTP_PORT'])", "HTTPS_PORT=$($script:A['HTTPS_PORT'])")
      if ($script:A['TLS_MODE'] -eq 'auto') { $c += '-ERP_CERT_DIR' } else { $c += 'ERP_CERT_DIR=./certs' }
    }
  } else {
    if ($script:Access -eq 'lan') { $c += 'HOST=0.0.0.0' } else { $c += 'HOST=127.0.0.1' }
    $c += @("PORT=$Port", 'COOKIE_SECURE=false', 'TRUST_PROXY=false')
  }
  if ($script:A['MAIL_ENABLED'] -eq 'yes') { $c += @("SMTP_URL=$($script:SmtpUrl)", "MAIL_FROM=$($script:MailFrom)", "APP_BASE_URL=$($script:BaseUrl)") }
  else {
    $c += @('-SMTP_URL', '-MAIL_FROM')
    if ($script:A['TLS_MODE'] -ne 'none') { $c += "APP_BASE_URL=$($script:BaseUrl)" } else { $c += '-APP_BASE_URL' }
  }
  if ($script:A['LICENSE_SERVER_URL']) { $c += "LICENSE_SERVER_URL=$($script:A['LICENSE_SERVER_URL'])" } else { $c += '-LICENSE_SERVER_URL' }
  $c += "REGISTRATION_ENABLED=$reg"
  $c += @('-LICENSE_ENFORCEMENT_DEV', '-LICENSE_DEV_KEYRING', '-MAIL_TRANSPORT')   # üretimde geliştirme anahtarları bulunmaz
  $script:Chg = $c
}

# ---- Sorular ---------------------------------------------------------------------------------------------------------------------
function Configure-Demo {
  Write-Section 'Demo verisi'
  $def = 'no'; if ($Mode -eq 'dev') { $def = 'yes' }
  $d = Get-Cur 'DEMO' $def
  [void](Ask-YesNo 'DEMO' 'Demo verisi (örnek şirket/cari/proje) yüklensin mi?' 'Hayır = tamamen boş uygulama (örnek şirket, kullanıcı ya da veri yok; ilk hesabı siz açarsınız). Evet = deneme için örnek veriler.' $d)
  if ($script:A['DEMO'] -eq 'yes' -and $Mode -eq 'prod') { Warn 'Demo hesabının parolası herkesçe bilinir (demo@ornek.local); gerçek veri girmeden önce boş kuruluma geçin.' }
}

function Ask-FreePort([string]$key, [string]$q, [string]$help, [string]$def, [string]$allow = '') {
  $preset = ($script:A[$key] -ne '')
  while ($true) {
    $v = Ask-Val $key $q $help $def 'V-Port'
    if ($v -eq $allow -or -not (Test-PortBusy ([int]$v))) { return $v }
    if ((Test-Interactive) -and -not $preset) { Warn "Port $v başka bir uygulama tarafından kullanılıyor; başka bir port seçin."; $script:A[$key] = ''; continue }
    Die "${q}: port $v kullanımda (başka bir uygulama?). Farklı bir port seçin ya da o uygulamayı kapatın."
  }
}

function Ask-Access {
  if ($Mode -eq 'dev') { $script:Access = 'local'; return }
  $script:A['ACCESS'] = $script:Access
  Write-Help 'local = yalnızca bu bilgisayar, lan = yerel ağdaki bilgisayarlar, domain = alan adı üzerinden internet'
  $script:Access = Ask-Choice 'ACCESS' 'Uygulamaya nereden erişilecek?' '' (Get-Cur 'ACCESS' 'local') @('local', 'lan', 'domain')
  if ($script:Access -eq 'domain' -and $script:Path -ne 'docker') { Die 'Alan adı + HTTPS şimdilik Docker yolunda (Caddy) desteklenir; yerel yolda -Access lan seçip önüne bir ters vekil koyun.' }
}

function Test-AcmePrecheck {
  $bad = $false
  $ip = Resolve-HostIp $script:Domain
  if (-not $ip) { Warn "$($script:Domain) için DNS kaydı bulunamadı: alan adını bu sunucunun IP adresine yönlendirin (A kaydı), yoksa sertifika alınamaz."; $bad = $true }
  else {
    $pub = Get-PublicIp
    if (-not $pub) { Info "DNS: $($script:Domain) → $ip (bu makinenin genel IP adresi öğrenilemedi; elle doğrulayın)" }
    elseif (" $ip " -notlike "* $pub *") { Warn "DNS $($script:Domain) için $ip gösteriyor, ancak bu makinenin genel IP adresi ${pub}: kayıt başka bir sunucuya yönleniyor olabilir."; $bad = $true }
    else { Ok "DNS: $($script:Domain) → $pub (bu makine)" }
  }
  foreach ($p in @(80, 443)) { if ((Test-PortBusy $p) -and (Get-Cur 'TLS_MODE' 'none') -eq 'none') { Warn "Port $p bu makinede başka bir uygulama tarafından kullanılıyor; Caddy 80 ve 443'e ihtiyaç duyar."; $bad = $true } }
  Info "Güvenlik duvarı/yönlendirici: dışarıdan 80 ve 443 portları bu makineye açık olmalı (Let's Encrypt doğrulaması için)."
  if ($bad -and (Test-Interactive)) { if (-not (Confirm-Step 'Yine de devam edilsin mi?')) { Die 'Vazgeçildi' } }
}

# Sertifika/anahtar doğrulama: önce Node aracı (tüm denetimler), yoksa openssl yoksa uyarı. 0 = geçerli
function Test-CertFiles {
  $r = Invoke-Tool @('cert-check', '--cert', $script:A['CERT_FILE'], '--key', $script:A['KEY_FILE'], '--domain', $script:Domain)
  if ($r.Code -eq 127) { Warn 'Sertifika doğrulanamadı (Node bulunamadı); dosyalar olduğu gibi kullanılacak.'; return $true }
  foreach ($l in ($r.Out -split "`r?`n")) {
    if ($l.StartsWith('HATA ')) { Write-Host "  $([char]0x2717) $($l.Substring(5))" -ForegroundColor Red }
    elseif ($l.StartsWith('UYARI ')) { Warn $l.Substring(6) }
    elseif ($l.StartsWith('BİLGİ ')) { Info $l.Substring(6) }
  }
  return ($r.Code -eq 0)
}

function Configure-Tls {
  if ($script:Access -eq 'local') {
    if ($script:A['TLS_MODE'] -and $script:A['TLS_MODE'] -ne 'none') { Die "-Tls $($script:A['TLS_MODE']) için -Access lan ya da domain gerekir (local erişimde HTTPS yok)" }
    $script:A['TLS_MODE'] = 'none'; return
  }
  Write-Section 'Alan adı ve HTTPS (sertifika)'
  $defTls = 'none'; if ($script:Access -eq 'domain') { $defTls = 'auto' }
  if ((Get-Cur 'TLS_MODE') -and (Get-Cur 'ACCESS') -eq $script:Access) { $defTls = Get-Cur 'TLS_MODE' }
  Write-Help "auto = Let's Encrypt (alan adı + açık 80/443), byo = kendi sertifikanız, selfsigned = kendi imzalı (yerel ağ), none = HTTPS yok (düz http)"
  $tls = Ask-Choice 'TLS_MODE' 'Güvenli bağlantı (HTTPS) nasıl sağlansın?' '' $defTls @('auto', 'byo', 'selfsigned', 'none')
  if ($tls -eq 'none') {
    if ($script:Access -eq 'domain') { Die 'Alan adı erişiminde HTTPS gerekir (-Tls auto|byo|selfsigned). HTTPS istemiyorsanız -Access lan seçin.' }
    return
  }
  if ($script:Path -ne 'docker') { Die 'HTTPS (alan adı/sertifika) şimdilik Docker yolunda (Caddy) desteklenir. Yerel yolda -Tls none seçip kendi ters vekilinizi kullanın.' }
  $hostDef = Get-Cur 'DOMAIN'
  if (-not $hostDef -and $script:Access -eq 'lan') { $hostDef = Get-LanIp }
  $chk = 'V-Host'; if ($tls -eq 'auto') { $chk = 'V-Fqdn' }
  $script:A['DOMAIN'] = $script:Domain
  $script:Domain = Ask-Val 'DOMAIN' 'Alan adı ya da adres' 'Kullanıcıların tarayıcıya yazacağı ad (örn. erp.firmaniz.com; yerel ağda 192.168.1.20 ya da bilgisayar adı).' $hostDef $chk
  switch ($tls) {
    'auto' {
      [void](Ask-Val 'ACME_EMAIL' 'Sertifika bildirimleri için e-posta' "Let's Encrypt süre bitimi uyarılarını bu adrese gönderir (boş bırakılabilir)." (Get-Cur 'ACME_EMAIL') 'V-EmailOpt')
      if (($script:A['HTTP_PORT'] -and $script:A['HTTP_PORT'] -ne '80') -or ($script:A['HTTPS_PORT'] -and $script:A['HTTPS_PORT'] -ne '443')) { Die "Let's Encrypt (auto) için HTTP 80 ve HTTPS 443 portları gerekir" }
      $script:A['HTTP_PORT'] = '80'; $script:A['HTTPS_PORT'] = '443'
      Test-AcmePrecheck
    }
    'byo' {
      while ($true) {
        [void](Ask-Val 'CERT_FILE' 'Sertifika dosyası (.crt/.pem, tam zincir)' "Sağlayıcıdan aldığınız 'fullchain' dosyasının tam yolu (sunucu sertifikası + ara sertifikalar)." '' 'V-FileExists')
        [void](Ask-Val 'KEY_FILE' 'Özel anahtar dosyası (.key)' 'Sertifikanın özel anahtarı (parolasız PEM). İçeriği asla ekrana yazılmaz.' '' 'V-FileExists')
        if (Test-CertFiles) { Ok 'Sertifika ve anahtar doğrulandı'; break }
        if (Test-Interactive) { $script:A['CERT_FILE'] = ''; $script:A['KEY_FILE'] = ''; Warn 'Dosyaları düzeltip yeniden girin.' } else { Die 'Sertifika doğrulaması başarısız (yukarıya bakın)' }
      }
    }
    'selfsigned' { Info 'Kendi imzalı sertifika üretilecek; kullanıcı bilgisayarlarına güvenilir kök olarak eklenmelidir (kurulum sonunda adımlar yazılır).' }
  }
  if ($tls -ne 'auto') {
    [void](Ask-FreePort 'HTTP_PORT' 'HTTP portu (HTTPS''e yönlendirir)' '' '80' (Get-Cur 'HTTP_PORT'))
    [void](Ask-FreePort 'HTTPS_PORT' 'HTTPS portu' 'Tarayıcıların bağlanacağı güvenli port (standart: 443).' '443' (Get-Cur 'HTTPS_PORT'))
  }
}

function Send-TestMail {
  # 0 gönderildi, 1 başarısız, 2 çalıştırılamadı
  if ($DryRun) { Info '(kuru çalıştırma: test e-postası gönderilmez)'; return 0 }
  if (-not (Get-ToolNode)) { return 2 }
  Info "Test e-postası gönderiliyor: $($script:A['MAIL_TEST_TO']) …"
  $env:SMTP_URL = $script:SmtpUrl; $env:MAIL_FROM = $script:MailFrom
  try { $r = Invoke-Tool @('smtp-test', '--to', $script:A['MAIL_TEST_TO']) } finally { Remove-Item Env:\SMTP_URL, Env:\MAIL_FROM -ErrorAction SilentlyContinue }
  if ($r.Code -eq 0) { Ok $r.Out; return 0 }
  Write-Host "  $([char]0x2717) $($r.Out)" -ForegroundColor Red
  return 1
}
function Send-TestMailContainer([string]$to) {
  $dc = @('compose', '-f', 'deploy/docker-compose.prod.yml', '--env-file', 'deploy/.env')
  if ($script:A['TLS_MODE'] -ne 'none') { $dc += @('--profile', 'tls') }
  Push-Location $Root
  try { & docker @dc run --rm --no-deps -T -v "$($Installer)\tools:/erp-tools:ro" -e ERP_NODE_MODULES_DIR=/app app node /erp-tools/erp-tool.mjs smtp-test --to $to; return ($LASTEXITCODE -eq 0) } finally { Pop-Location }
}

function Clear-MailAnswers { foreach ($k in @('SMTP_HOST', 'SMTP_SECURITY', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'MAIL_FROM_ADDRESS', 'MAIL_FROM_NAME', 'APP_BASE_URL', 'MAIL_TEST_TO')) { $script:A[$k] = '' } }

function Configure-Mail {
  Write-Section 'E-posta (SMTP)'
  [void](Ask-YesNo 'MAIL_ENABLED' 'E-posta gönderimi kurulsun mu? (parola sıfırlama, e-posta doğrulama)' "Hayır = e-posta olmadan devam; 'Şifremi unuttum' ve doğrulama kapalı kalır, parolayı yönetici sıfırlar (OPERATIONS §4). Sonra -Reconfigure ile eklenebilir." (Get-Cur 'MAIL_ENABLED' 'no'))
  if ($script:A['MAIL_ENABLED'] -ne 'yes') { return }
  while ($true) {
    [void](Ask-Val 'SMTP_HOST' 'SMTP sunucusu' 'Posta sağlayıcınızın giden sunucu adı (örn. smtp.office365.com, smtp.gmail.com).' (Get-Cur 'SMTP_HOST') 'V-Host')
    $sec = Ask-Choice 'SMTP_SECURITY' 'Güvenlik türü' 'ssl = SSL/TLS (genelde port 465), starttls = STARTTLS (genelde 587), none = şifresiz (önerilmez)' (Get-Cur 'SMTP_SECURITY' 'starttls') @('ssl', 'starttls', 'none')
    $defPort = '25'; if ($sec -eq 'ssl') { $defPort = '465' } elseif ($sec -eq 'starttls') { $defPort = '587' }
    if ((Get-Cur 'SMTP_SECURITY') -eq $sec -and (Get-Cur 'SMTP_PORT')) { $defPort = Get-Cur 'SMTP_PORT' }
    [void](Ask-Val 'SMTP_PORT' 'SMTP portu' '' $defPort 'V-Port')
    if ($sec -eq 'none') { Warn 'Şifresiz bağlantı: kullanıcı adı ve parola ağda açık gider. Yalnızca güvenilir iç ağdaki bir röle için kullanın.' }
    [void](Ask-Val 'SMTP_USER' 'Kullanıcı adı' 'Genellikle e-posta adresiniz. Kimlik doğrulama gerekmeyen bir röle ise boş bırakın.' (Get-Cur 'SMTP_USER') 'V-Plain')
    if ($script:A['SMTP_USER']) {
      $hint = ''; if (Get-Cur 'SMTP_PASSWORD') { $hint = 'Enter = mevcut parolayı koru. ' }
      [void](Ask-Val 'SMTP_PASSWORD' 'Parola' "Yazarken görünmez. ${hint}Gmail/Office365 için 'uygulama parolası' gerekebilir." (Get-Cur 'SMTP_PASSWORD') 'V-Plain' $true)
      if (-not $script:A['SMTP_PASSWORD']) { Die 'Kullanıcı adı verildiğinde parola gerekli' }
    } else { $script:A['SMTP_PASSWORD'] = '' }
    $fromDef = Get-Cur 'MAIL_FROM_ADDRESS'
    if (-not $fromDef -and -not (V-Email $script:A['SMTP_USER'])) { $fromDef = $script:A['SMTP_USER'] }
    [void](Ask-Val 'MAIL_FROM_ADDRESS' 'Gönderen e-posta adresi' "Alıcının göreceği 'kimden' adresi (genellikle posta hesabınızın adresi)." $fromDef 'V-Email')
    [void](Ask-Val 'MAIL_FROM_NAME' 'Gönderen adı' 'Alıcının göreceği ad (örn. firma adınız).' (Get-Cur 'MAIL_FROM_NAME' 'Muhasebe ERP') 'V-DisplayName')
    $baseDef = New-BaseUrl
    if ((Get-Cur 'APP_BASE_URL') -and (Get-Cur 'ACCESS') -eq $script:Access) { $baseDef = Get-Cur 'APP_BASE_URL' }
    [void](Ask-Val 'APP_BASE_URL' 'Uygulamanın adresi (e-postalardaki bağlantılar için)' 'Kullanıcılar uygulamayı hangi adresle açıyorsa o (örn. https://erp.firmaniz.com).' $baseDef 'V-BaseUrl')
    $script:BaseUrl = $script:A['APP_BASE_URL'].TrimEnd('/')
    if ($script:BaseUrl -like 'http://localhost*') { Warn "Adres 'localhost': e-postadaki bağlantılar yalnızca bu bilgisayarda açılır." }
    $script:SmtpUrl = New-SmtpUrl $script:A['SMTP_HOST'] $script:A['SMTP_PORT'] $script:A['SMTP_SECURITY'] $script:A['SMTP_USER'] $script:A['SMTP_PASSWORD']
    $script:MailFrom = New-MailFrom $script:A['MAIL_FROM_ADDRESS'] $script:A['MAIL_FROM_NAME']
    [void](Ask-Val 'MAIL_TEST_TO' 'Test e-postası hangi adrese gönderilsin? (boş = test etme)' 'Ayarların çalıştığını görmek için bir adrese deneme iletisi gönderilir.' '' 'V-EmailOpt')
    if (-not $script:A['MAIL_TEST_TO']) { Warn 'Test e-postası gönderilmedi: ayarlar denenmeden kaydedilecek.'; return }
    $rc = Send-TestMail
    if ($rc -eq 0) { return }
    if ($rc -eq 2) {
      if ($script:Path -eq 'docker') { Warn 'Bu makinede Node.js bulunamadı; test e-postası kurulumdan sonra uygulama kabında denenecek.'; $script:MailTestDeferred = $true } else { Warn 'Test atlandı (Node.js yok).' }
      return
    }
    if (-not (Test-Interactive)) { Die 'Test e-postası gönderilemedi (yukarıdaki nedene bakın). Ayarları düzeltin ya da MAIL_TEST_TO satırını kaldırın.' }
    $choice = Read-Answer '  t) tekrar dene   d) ayarları düzenle   a) e-postasız devam   y) yine de bu ayarlarla devam   [d]: ' $false
    if (-not $choice) { $choice = 'd' }
    switch -Regex ($choice) {
      '^[tT]' {
        while ($true) { if ((Send-TestMail) -eq 0) { return }; $again = Read-Answer '  Tekrar denensin mi? (t = evet, başka tuş = menüye dön): ' $false; if ($again -notmatch '^[tT]') { break } }
        Clear-MailAnswers
      }
      '^[aA]' { $script:A['MAIL_ENABLED'] = 'no'; Warn 'E-posta olmadan devam ediliyor (sonra -Reconfigure ile eklenebilir).'; return }
      '^[yY]' { Warn 'E-posta ayarları denenmeden kaydediliyor.'; return }
      default { Clear-MailAnswers }
    }
  }
}

# Kurulu sistemde yanıt dosyası ya da mevcut ayardan FARKLI bayrak sessizce yok sayılmaz: sihirbaz durur, -Reconfigure önerir.
# Güncelleyicinin çalıştırmasında (ERP_UPDATER_RUN) bayraklar kurulumdaki değerlerdir; uyuşmazlık yalnızca uyarılır.
function Assert-NoSettingsOnExisting {
  $diffs = @()
  foreach ($k in $script:FlagVal.Keys) {
    $cur = Get-Cur $k
    if ($k -eq 'PORT' -and -not $cur) { $cur = '3000' }; if ($k -eq 'TLS_MODE' -and -not $cur) { $cur = 'none' }; if ($k -eq 'DEMO' -and -not $cur) { $cur = 'no' }
    if ([string]$script:FlagVal[$k] -ne $cur) { $diffs += "${k}: kurulu=$cur, verilen=$($script:FlagVal[$k])" }
  }
  if ($env:ERP_UPDATER_RUN) { if ($diffs.Count -gt 0) { Warn "Güncelleyici bayrakları mevcut ayarlardan farklı; mevcut ayarlar korunuyor ($($diffs -join '; '))" }; return }
  if ($AnswersFile) { Die "Kurulu sistem bulundu ($($script:ExistingPath)): yanıt dosyası yalnızca YENİ kurulumda okunur, burada yok sayılmaz. Ayarları değiştirmek için: install.ps1 -Reconfigure -AnswersFile `"$AnswersFile`" (önce -DryRun ile bakabilirsiniz)" }
  if ($diffs.Count -gt 0) { Die "Kurulu sistemin ayarlarından farklı bayrak verildi: $($diffs -join '; '). Yükseltme/onarım mevcut ayarlarla yapılır; değiştirmek için: install.ps1 -Reconfigure" }
}

# Kurulu sürümden ESKİ kit kurulmaz (veritabanı yeni şemada olabilir). İstisna: -RestoreDb (güncelleyicinin geri dönüşü) ya da -AllowDowngrade.
function Assert-NoDowngrade {
  if (-not $script:Existing -or -not $Kit) { return }
  $cur = Get-Cur 'APP_VERSION'
  if (-not (Test-Semver $cur) -or -not (Test-Semver $Kit.version)) { return }
  if ((Compare-SemVer $Kit.version $cur) -ge 0) { return }
  if ($RestoreDb) { Warn "Sürüm $cur → $($Kit.version) geri dönülüyor (yedekten geri yüklemeyle)"; return }
  if ($AllowDowngrade) { Warn "Sürüm DÜŞÜRÜLÜYOR: $cur → $($Kit.version) (-AllowDowngrade). Veritabanı şeması yeni sürümde kalır."; return }
  Die "Kurulu sürüm $cur, bu kit $($Kit.version) (daha eski). Sürüm düşürme yapılmaz: yeni sürümün kitini kullanın."
}

function Configure-License {
  Write-Section 'Lisans'
  if ($Mode -eq 'dev') { Info 'Geliştirme kurulumunda lisans denetimi kapalıdır (yalnızca NODE_ENV≠production). Müşteri/üretim kurulumunda denetim derlemeye gömülüdür ve kapatılamaz.'; return }
  Info 'Uygulama lisans etkinleştirilmeden çalışmaz: yalnızca etkinleştirme ekranı açılır. Etkinleştirme için satıcıdan aldığınız kod gerekir.'
  $kitUrl = ''; if ($Kit -and $Kit.PSObject.Properties['licenseServerUrl'] -and $Kit.licenseServerUrl) { $kitUrl = [string]$Kit.licenseServerUrl }
  if ($kitUrl) { Info "Bu kitte lisans sunucusu adresi gömülü: $kitUrl (boş bırakırsanız bu kullanılır)." }
  elseif ($Kit) { Warn 'Bu kitte lisans sunucusu adresi YOK: adres girmezseniz yalnızca çevrimdışı etkinleştirme yapılabilir (OPERATIONS §4). Satıcıdan adresi isteyin.' }
  $u = Ask-Val 'LICENSE_SERVER_URL' 'Lisans sunucusu adresi (boş = kitteki varsayılan)' 'Boş bırakın: satıcının uygulamaya gömdüğü adres kullanılır. Yalnızca satıcı farklı bir adres verdiyse yazın (https://…).' (Get-Cur 'LICENSE_SERVER_URL') 'V-LicenseUrl'
  if ($u) {
    if ($DryRun) { Info '(kuru çalıştırma: lisans sunucusuna bağlanılmaz)' }
    else {
      $okHealth = $false
      try { $r = Invoke-WebRequest -Uri ($u.TrimEnd('/') + '/healthz') -UseBasicParsing -TimeoutSec 10; $okHealth = ($r.StatusCode -eq 200) } catch { }
      if ($okHealth) { Ok "Lisans sunucusuna erişildi: $u" }
      else { Warn "Lisans sunucusuna (HTTPS) ulaşılamadı: $u. Bu sunucudan lisans sunucusuna 443 çıkışı açık olmalı; yoksa etkinleştirme yapılamaz (çevrimdışı etkinleştirme mümkündür: OPERATIONS §4)." }
    }
  } elseif ($kitUrl -or -not $Kit) { Info 'Varsayılan lisans sunucusu kullanılacak; erişimi etkinleştirme sırasında sınanır.' }
  else { Warn 'Lisans sunucusu yok: çevrimiçi etkinleştirme yapılamaz (yalnızca çevrimdışı etkinleştirme).' }
  [void](Ask-Val 'LICENSE_CODE' 'Lisans etkinleştirme kodu (boş = tarayıcıda girerim)' 'Satıcıdan aldığınız 25 karakterlik kod (XXXXX-XXXXX-XXXXX-XXXXX-XXXXX). Yazarken görünmez. Kurulum bitince burada etkinleştirilir.' '' 'V-LicenseCode' $true)
}

function Configure-Backup {
  Write-Section 'Yedekleme'
  $defDir = Join-Path $DataDir 'backups'
  if ($script:Path -eq 'docker') { $defDir = Join-Path $Root 'backups' }
  [void](Ask-Val 'BACKUP_DIR' 'Yedek klasörü' 'Günlük veritabanı yedeklerinin yazılacağı klasör (yalnızca yöneticiler okur). Ofis dışına kopyalama (UNC/robocopy) elle kurulur: OPERATIONS §6.' (Get-Cur 'BACKUP_DIR' $defDir) 'V-AbsPath')
  [void](Ask-Val 'BACKUP_KEEP' 'Kaç yedek saklansın?' 'En yeni bu kadar yedek tutulur, eskiler silinir.' (Get-Cur 'BACKUP_KEEP' '14') 'V-Keep')
  [void](Ask-Val 'BACKUP_TIME' 'Günlük yedek saati (SS:DD)' 'Her gün bu saatte otomatik yedek alınır.' (Get-Cur 'BACKUP_TIME' '02:30') 'V-Time')
  if ($script:Path -eq 'docker') { Info 'Docker yolunda günlük yedek zamanlanmış görevle alınır (docker exec pg_dump); o saatte Docker Desktop çalışıyor olmalıdır.' }
}

function Configure-Registration {
  Write-Section 'Kayıt (ilk hesap)'
  [void](Ask-YesNo 'REGISTRATION' 'Yeni kullanıcı/şirket kaydı açık olsun mu?' "Evet (ilk kurulumda gerekli): ilk sahip hesabını tarayıcıda 'Kayıt ol' ile açarsınız. İlk hesaptan sonra install.ps1 -Reconfigure ile kapatın." (Get-Cur 'REGISTRATION' 'yes'))
}

function Show-Settings {
  Say "  Kip / yol:        $Mode / $($script:Path)"
  if ($Mode -eq 'prod') {
    $d = ''; if ($script:Domain) { $d = " ($($script:Domain))" }
    Say "  Erişim:           $($script:Access)$d  — HTTPS: $($script:A['TLS_MODE'])   uygulama portu: $Port"
  }
  if ($script:A['DEMO'] -eq 'yes') { Say '  Veri:             DEMO verisi yüklenecek' } else { Say '  Veri:             BOŞ uygulama (demo/örnek veri yok)' }
  if ($Mode -eq 'prod') {
    if ($script:A['MAIL_ENABLED'] -eq 'yes') { Say "  E-posta:          açık — $($script:A['SMTP_HOST']):$($script:A['SMTP_PORT']) ($($script:A['SMTP_SECURITY'])), gönderen $($script:MailFrom)" } else { Say '  E-posta:          kapalı (parola sıfırlama/doğrulama yok)' }
    $lu = $script:A['LICENSE_SERVER_URL']
    if (-not $lu) {
      if ($Kit -and $Kit.PSObject.Properties['licenseServerUrl'] -and $Kit.licenseServerUrl) { $lu = "kitteki varsayılan ($($Kit.licenseServerUrl))" }
      elseif ($Kit) { $lu = 'YOK (kitte de yok: yalnızca çevrimdışı etkinleştirme)' } else { $lu = 'derlemedeki varsayılan' }
    }
    $lc = 'girilmedi (tarayıcıda girilecek)'; if ($script:A['LICENSE_CODE']) { $lc = 'girildi (kurulumda etkinleştirilecek)' }
    Say "  Lisans sunucusu:  $lu   kod: $lc"
    Say "  Yedek:            her gün $($script:A['BACKUP_TIME']) → $($script:A['BACKUP_DIR']) (son $($script:A['BACKUP_KEEP']))"
    $rg = 'açık'; if ($script:A['REGISTRATION'] -eq 'no') { $rg = 'kapalı' }
    Say "  Yeni kayıt:       $rg"
  }
}

# Tüm soruları sorar (yeni kurulum). Mevcut kurulumda atlanır (yeniden yapılandırma ayrı akıştır).
function Invoke-Configure {
  Stage '3/5 Yapılandırma'
  if ($script:Existing) {
    Assert-NoSettingsOnExisting
    Info 'Mevcut kurulum bulundu: ayarlar korunuyor (değiştirmek için: install.ps1 -Reconfigure).'
    if (-not $script:Port) { $script:Port = [int](Get-Cur 'PORT' '3000') }
    if (-not $script:A['TLS_MODE']) { $script:A['TLS_MODE'] = 'none' }
    $script:A['DEMO'] = Get-Cur 'DEMO' 'no'
    foreach ($k in @('BACKUP_DIR', 'BACKUP_KEEP', 'BACKUP_TIME', 'LICENSE_SERVER_URL')) { $script:A[$k] = Get-Cur $k }
    if (-not $script:A['BACKUP_DIR']) { if ($script:Path -eq 'native') { $script:A['BACKUP_DIR'] = (Join-Path $DataDir 'backups') } else { $script:A['BACKUP_DIR'] = (Join-Path $Root 'backups') } }
    if (-not $script:A['BACKUP_KEEP']) { $script:A['BACKUP_KEEP'] = '14' }
    if (-not $script:A['BACKUP_TIME']) { $script:A['BACKUP_TIME'] = '02:30' }
    $script:A['MAIL_ENABLED'] = Get-Cur 'MAIL_ENABLED' 'no'; $script:A['REGISTRATION'] = Get-Cur 'REGISTRATION' 'yes'
    return
  }
  if (-not (Test-Interactive)) { Info 'Etkileşimsiz kip: sorulmayan değerler için varsayılanlar kullanılıyor.' }
  else { Info 'Her soruda Enter varsayılanı kabul eder. Hiçbir şey henüz yazılmadı; en sonda özet gösterilir.' }
  Configure-Demo
  if ($Mode -eq 'dev') {
    Configure-License
    if (-not $script:Port) { $script:Port = 3000 }
    $script:A['TLS_MODE'] = 'none'; $script:A['MAIL_ENABLED'] = 'no'; $script:A['REGISTRATION'] = 'yes'
    return
  }
  Write-Section 'Port'
  $pv = Ask-FreePort 'PORT' 'Uygulama portu' "Uygulamanın dinleyeceği port. Başka bir program 3000'i kullanıyorsa farklı bir port seçin. (Veritabanı portu dışarıya açılmaz; yerel yolda mevcut PostgreSQL kullanılır.)" '3000'
  $script:Port = [int]$pv
  Configure-Tls
  Configure-Mail
  Configure-License
  Configure-Backup
  Configure-Registration
  if ($script:A['MAIL_ENABLED'] -eq 'yes' -and -not $script:MailFrom) { $script:MailFrom = New-MailFrom $script:A['MAIL_FROM_ADDRESS'] $script:A['MAIL_FROM_NAME'] }
  if (-not $script:BaseUrl) { $script:BaseUrl = New-BaseUrl }
  Write-Section 'Özet'
  Show-Settings
  if (-not (Confirm-Step 'Bu ayarlarla devam edilsin mi?')) { Die 'Vazgeçildi (hiçbir şey yazılmadı)' }
}

# ---- Dosyaların yazımı ----------------------------------------------------------------------------------------------------------------
function New-SelfSignedFiles([string]$dir, [string]$h) {
  $san = "DNS:$h"; if (Test-Ipv4 $h) { $san = "IP:$h" }
  & openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 825 -keyout (Join-Path $dir 'privkey.pem.new') -out (Join-Path $dir 'fullchain.pem.new') -subj "/CN=$h/O=Muhasebe ERP" -addext "subjectAltName=$san,DNS:localhost" *> $null
  if ($LASTEXITCODE -ne 0) { return $false }
  Move-Item -Force (Join-Path $dir 'privkey.pem.new') (Join-Path $dir 'privkey.pem')
  Move-Item -Force (Join-Path $dir 'fullchain.pem.new') (Join-Path $dir 'fullchain.pem')
  return $true
}

function Write-TlsFiles {
  # Docker yolunda Caddyfile.local ve sertifika dosyaları
  if ($script:Path -ne 'docker' -or $script:A['TLS_MODE'] -eq 'none') { return }
  $cdir = Join-Path $Root 'deploy\certs'
  $files = $false
  $script:SelfSignedInternal = $false
  if ($script:A['TLS_MODE'] -eq 'byo') {
    if (-not (Test-Path $cdir)) { New-Item -ItemType Directory -Path $cdir -Force | Out-Null }
    & icacls $cdir /inheritance:r /grant:r "${SidSystem}:(OI)(CI)F" "${SidAdmins}:(OI)(CI)F" | Out-Null
    Copy-Item -Force $script:A['CERT_FILE'] (Join-Path $cdir 'fullchain.pem')
    Copy-Item -Force $script:A['KEY_FILE'] (Join-Path $cdir 'privkey.pem')
    $files = $true; Ok 'Sertifika kopyalandı: deploy\certs (yalnızca yöneticiler erişir)'
  } elseif ($script:A['TLS_MODE'] -eq 'selfsigned') {
    if (Get-Command openssl -ErrorAction SilentlyContinue) {
      if (-not (Test-Path $cdir)) { New-Item -ItemType Directory -Path $cdir -Force | Out-Null }
      & icacls $cdir /inheritance:r /grant:r "${SidSystem}:(OI)(CI)F" "${SidAdmins}:(OI)(CI)F" | Out-Null
      if (-not (New-SelfSignedFiles $cdir $script:Domain)) { Die 'Kendi imzalı sertifika üretilemedi (openssl)' }
      $files = $true; Ok 'Kendi imzalı sertifika üretildi (825 gün): deploy\certs\fullchain.pem'
    } else {
      $script:SelfSignedInternal = $true
      Warn "openssl yok: Caddy'nin kendi yerel sertifika otoritesi kullanılacak (kök sertifika Caddy veri biriminden alınır)."
    }
  }
  $cf = New-Caddyfile $script:A['TLS_MODE'] $script:A['ACME_EMAIL'] $script:A['HTTPS_PORT'] $files
  Write-TextFile (Join-Path $Root 'deploy\Caddyfile.local') (($cf -join "`n") + "`n")
  Ok 'Caddy yapılandırması yazıldı: deploy\Caddyfile.local'
}

function Write-WizardConf {
  $l = @('# Kurulum sihirbazının durumu (gizli bilgi içermez; parolalar yalnızca ortam dosyasındadır). Elle değiştirmeyin: -Reconfigure kullanın.')
  $l += "WIZARD_SAVED=$(Get-Date -Format s)"
  $l += "INSTALL_PATH=$($script:Path)"
  $l += "ACCESS=$($script:Access)"; $l += "DOMAIN=$($script:Domain)"; $l += "PORT=$Port"
  foreach ($k in @('TLS_MODE', 'ACME_EMAIL', 'HTTP_PORT', 'HTTPS_PORT', 'MAIL_ENABLED', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURITY', 'SMTP_USER', 'MAIL_FROM_ADDRESS', 'MAIL_FROM_NAME', 'BACKUP_DIR', 'BACKUP_KEEP', 'BACKUP_TIME', 'REGISTRATION', 'LICENSE_SERVER_URL', 'APP_BASE_URL', 'DEMO')) { $l += "$k=$($script:A[$k])" }
  $l += "DEMO_PENDING=$($script:DemoPending)"; $l += "DEMO_SEEDED=$($script:DemoSeeded)"
  $l += "DB_NAME=$DbName"; $l += "DB_CREATED=$($script:DbCreated)"; $l += "ROLES_CREATED=$($script:RolesCreated)"
  Write-SecureFile (Get-ConfPath) $l $false
}
$script:DemoPending = ''
$script:DemoSeeded = ''
$script:DbCreated = ''
$script:RolesCreated = ''

# ---- Lisans: durum, kapı doğrulaması, etkinleştirme -----------------------------------------------------------------------------------
function Invoke-Http([string]$method, [string]$url, [string]$body = '') {
  # → @{ Status = kod; Body = metin }; ağ hatasında Status = 0
  try {
    $p = @{ Uri = $url; Method = $method; UseBasicParsing = $true; TimeoutSec = 60 }
    if ($body) { $p.Body = $body; $p.ContentType = 'application/json' }
    $r = Invoke-WebRequest @p
    return @{ Status = [int]$r.StatusCode; Body = [string]$r.Content }
  } catch {
    $resp = $_.Exception.Response
    if ($resp) {
      $txt = ''
      try { $sr = New-Object IO.StreamReader($resp.GetResponseStream()); $txt = $sr.ReadToEnd(); $sr.Close() } catch { }
      return @{ Status = [int]$resp.StatusCode; Body = $txt }
    }
    return @{ Status = 0; Body = '' }
  }
}
function Read-LicenseState([string]$base) {
  $script:LicState = ''; $script:LicEnforced = ''
  $r = Invoke-Http 'GET' "$base/api/public-config"
  if ($r.Status -eq 200) {
    try { $j = $r.Body | ConvertFrom-Json; $script:LicEnforced = ([string]$j.license.enforced).ToLower(); $script:LicState = [string]$j.license.state } catch { }
  }
}
function Test-LicenseGate([string]$base) {
  Read-LicenseState $base
  if ($script:LicEnforced -ne 'true') { Warn "DİKKAT: lisans denetimi AÇIK görünmüyor ($base/api/public-config). Üretim kurulumunda denetim her zaman açık olmalı; kiti/imajı satıcıdan yeniden alın."; return }
  if ($script:LicState -eq 'unlicensed') {
    $r = Invoke-Http 'GET' "$base/api/accounts"
    if ($r.Status -eq 402) { Ok 'Lisans kapısı doğrulandı: lisans etkinleştirilmedikçe uygulama iş uçlarını açmıyor (HTTP 402)' }
    else { Warn "Lisanssız kurulumda iş ucu 402 yerine $($r.Status) döndü; lisans kapısı beklenen gibi çalışmıyor." }
  }
}
function Invoke-LicenseActivation([string]$base) {
  $code = $script:A['LICENSE_CODE']
  if (-not $code) { return }
  if ($script:LicState -ne 'unlicensed') { Info "Lisans zaten etkin ya da kısıtlı ($($script:LicState)); kod kullanılmadı."; return }
  Info 'Lisans etkinleştiriliyor…'
  $r = Invoke-Http 'POST' "$base/api/license/activate" ('{"code":"' + $code + '"}')
  if ($r.Status -eq 200) { Ok 'Lisans etkinleştirildi' }
  else {
    $msg = ''; if ($r.Body -match '"message":"([^"]*)"') { $msg = $Matches[1] }
    if (-not $msg) { $msg = 'bilinmeyen hata' }
    Warn "Lisans etkinleştirilemedi (HTTP $($r.Status)): $msg. Tarayıcıda açılışta çıkan 'Lisans etkinleştirme' sayfasından tekrar deneyebilirsiniz."
  }
  Read-LicenseState $base
}
function Get-LicenseText {
  switch ($script:LicState) {
    'active' { return 'etkin' }
    'grace' { return 'etkin (tolerans süresinde: lisans sunucusuna ulaşılamıyor)' }
    'restricted' { return 'kısıtlı (salt-okunur): lisansı yenileyin/yeniden etkinleştirin' }
    'unlicensed' { return "ETKİNLEŞTİRİLMEDİ — uygulama lisans kodu girilmeden çalışmaz (açılışta 'Lisans etkinleştirme' ekranı)" }
  }
  return 'bilinmiyor'
}

function Invoke-DemoSeedNative {
  $env:ALLOW_DEMO = 'true'
  try {
    & (Join-Path $ProgDir 'current\app\runtime\node.exe') "--env-file=$(Join-Path $DataDir 'erp.env')" (Join-Path $ProgDir 'current\app\dist\demo.js') seed
    return ($LASTEXITCODE -eq 0)
  } finally { Remove-Item Env:\ALLOW_DEMO -ErrorAction SilentlyContinue }
}
function Invoke-DemoSeedDocker {
  Push-Location $Root
  try { & docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env exec -T -e ALLOW_DEMO=true app node dist/demo.js seed; return ($LASTEXITCODE -eq 0) } finally { Pop-Location }
}

function Invoke-PostInstallChecks([string]$base) {
  Test-LicenseGate $base
  if ($script:A['LICENSE_CODE']) { Invoke-LicenseActivation $base }
  if ($script:MailTestDeferred -and $script:A['MAIL_TEST_TO']) { if (-not (Send-TestMailContainer $script:A['MAIL_TEST_TO'])) { Warn 'Test e-postası gönderilemedi (yukarıya bakın)' } }
}

# ---- Özet ekranı ------------------------------------------------------------------------------------------------------------------------
function Show-Summary([string]$url) {
  Stage 'Hazır'
  Say "  Adres:            $url"
  Say "  Kurulum:          prod / $($script:Path) — erişim: $($script:Access), HTTPS: $($script:A['TLS_MODE'])"
  if ($script:A['DEMO'] -eq 'yes' -and ($script:SeededDemo -or (Get-Cur 'DEMO_SEEDED') -eq 'yes')) { Say '  Veri:             DEMO verisi yüklü — giriş: demo@ornek.local / Demo-Sifre-123 (yalnızca deneme; gerçek veri girmeyin)' }
  else { Say '  Veri:             boş uygulama (demo/örnek veri yok)' }
  Say "  Lisans:           $(Get-LicenseText)"
  if ($script:A['MAIL_ENABLED'] -eq 'yes') { Say "  E-posta:          açık ($($script:A['SMTP_HOST']):$($script:A['SMTP_PORT']), $($script:A['SMTP_SECURITY']))" } else { Say '  E-posta:          kapalı (parola sıfırlama: yönetici komutuyla, OPERATIONS §4)' }
  Say "  Yedek:            her gün $($script:A['BACKUP_TIME']) → $($script:A['BACKUP_DIR']) (son $($script:A['BACKUP_KEEP']))"
  Say "  Ayar dosyaları:   $(Get-EnvPath) (gizli; yedekleyin)  ·  $(Get-ConfPath)"
  if ($script:Path -eq 'native') { Say "  Günlükler:        $DataDir\logs  ·  Yeniden yapılandırma: powershell -ExecutionPolicy Bypass -File `"$ProgDir\current\installer\install.ps1`" -Reconfigure" }
  else { Say '  Günlükler:        docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env logs app  ·  Yeniden yapılandırma: Kur.cmd -Reconfigure' }
  Say ''
  Say '  İlk giriş:'
  if ($script:LicState -eq 'unlicensed') { Say "   1) Tarayıcıda adresi açın → 'Lisans etkinleştirme' ekranına satıcıdan aldığınız kodu girin." }
  if ($script:A['DEMO'] -eq 'yes') { Say '   • Demo hesabıyla girin (yukarıda).' } else { Say "   • 'Kayıt ol' ile ilk kuruluş, şirket ve sahip hesabını oluşturun (e-posta + güçlü parola)." }
  if ($script:A['REGISTRATION'] -eq 'yes') { Say "   • İlk sahip hesabı açılınca kaydı kapatın: Kur.cmd -Reconfigure (`"Yeni kayıt açık olsun mu?`" → h)." }
  if ($script:A['TLS_MODE'] -eq 'selfsigned') {
    Say ''
    Say '  Kendi imzalı sertifika — istemcilerde güvenilir yapmak için:'
    if ($script:SelfSignedInternal) { Say '   Kök sertifikayı alın: docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env --profile tls cp caddy:/data/caddy/pki/authorities/local/root.crt .\caddy-root.crt' }
    else { Say "   Dosya: $Root\deploy\certs\fullchain.pem (yalnızca bu dosyayı dağıtın; .key dosyasını ASLA paylaşmayın)" }
    Say '   Windows (yönetici): certutil -addstore -f Root dosya.crt     ·    Linux: sudo cp dosya.crt /usr/local/share/ca-certificates/muhasebe-erp.crt && sudo update-ca-certificates'
  }
  Say ''
  Say '  Not: Bu yazılımın ürettiği fatura, irsaliye, bordro ve defter çıktıları resmî belge yerine geçmez; yasal oran/değerler doğrulanmamıştır'
  Say '  (mali müşavirle teyit edin: docs/LEGAL-NOTES.md). E-posta SPF/DKIM/DMARC kayıtları alan adınızda sizin işinizdir.'
  if ($AnswersFile -and ($script:A['SMTP_PASSWORD'] -or $script:A['LICENSE_CODE'])) { Say ''; Warn "Yanıt dosyasında parola/kod olabilir: $AnswersFile dosyasını şimdi silin." }
}

# ---- Kuru çalıştırma --------------------------------------------------------------------------------------------------------------------
function Show-DryRun {
  Stage 'Kuru çalıştırma — sistemde hiçbir şey değiştirilmedi'
  Say '  Planlanan yapılandırma:'
  Show-Settings
  Say ''
  if ($Mode -eq 'prod') {
    Build-EnvChanges $script:Path
    Say "  $(Get-EnvPath) — yazılacak/güncellenecek ayarlar (gizli değerler maskeli; rastgele parolalar kurulumda üretilir):"
    $show = @()
    foreach ($c in $script:Chg) { if ($c.StartsWith('-')) { if ($script:Existing) { $show += "(silinir) $($c.Substring(1))" } } else { $show += $c } }
    foreach ($l in (Hide-Secrets $show)) { Say "    $l" }
    if ($script:A['TLS_MODE'] -ne 'none' -and $script:Path -eq 'docker') {
      Say '  deploy\Caddyfile.local:'
      foreach ($l in (New-Caddyfile $script:A['TLS_MODE'] $script:A['ACME_EMAIL'] $script:A['HTTPS_PORT'] ($script:A['TLS_MODE'] -eq 'byo'))) { Say "    $l" }
      if ($script:A['TLS_MODE'] -eq 'byo') { Say '  deploy\certs\fullchain.pem ve privkey.pem kopyalanır (yalnızca yöneticiler okur; anahtar içeriği gösterilmez)' }
      if ($script:A['TLS_MODE'] -eq 'selfsigned') { Say '  deploy\certs\ altında kendi imzalı sertifika üretilir (openssl varsa; yoksa Caddy yerel CA)' }
    }
    Say "  Yedek: her gün $($script:A['BACKUP_TIME']), $($script:A['BACKUP_DIR']), son $($script:A['BACKUP_KEEP'])"
    Say "  Durum dosyası: $(Get-ConfPath) (gizli bilgi içermez)"
  } else { $d = ''; if ($script:A['DEMO'] -eq 'yes') { $d = ', demo verisi' }; Say "  Geliştirme: .env, npm bağımlılıkları, migration$d" }
}

# ---- Yeniden yapılandırma ---------------------------------------------------------------------------------------------------------------
function Restart-AndVerify([int]$p) {
  if ($script:Path -eq 'native') { & (Get-WinswExe) restart | Out-Null }
  else {
    Push-Location $Root
    try {
      $dc = @('compose', '-f', 'deploy/docker-compose.prod.yml', '--env-file', 'deploy/.env')
      if ((Get-Cur 'TLS_MODE' 'none') -ne 'none' -and $script:A['TLS_MODE'] -eq 'none') { & docker @dc --profile tls rm -sf caddy *> $null }
      $prof = @(); if ($script:A['TLS_MODE'] -ne 'none') { $prof = @('--profile', 'tls') }
      & docker @dc @prof up -d | Out-Null
    } finally { Pop-Location }
  }
  return (Wait-Ready "http://127.0.0.1:$p/api/health/ready" 120)
}

function Invoke-Reconfigure {
  if ($Mode -ne 'prod') { Die '-Reconfigure yalnızca müşteri (prod) kurulumları içindir' }
  Find-Existing
  if (-not $script:Existing) { Die "Kurulu bir sistem bulunamadı (önce Kur.cmd ile kurun). Aranan: $DataDir\erp.env ve $Root\deploy\.env" }
  $script:Path = $script:ExistingPath
  Stage "Yeniden yapılandırma ($($script:Path))"
  Info 'Yalnızca ayarlar sorulur (e-posta, HTTPS/sertifika, yedek, lisans adresi, kayıt). Uygulama sürümü, veritabanı ve veriler değişmez.'
  if (-not $script:Port) { $script:Port = [int](Get-Cur 'PORT' '3000') }
  $script:A['DEMO'] = 'no'
  Ask-Access
  Configure-Tls
  Configure-Mail
  Configure-License
  Configure-Backup
  Configure-Registration
  if ($script:A['MAIL_ENABLED'] -eq 'yes' -and -not $script:MailFrom) { $script:MailFrom = New-MailFrom $script:A['MAIL_FROM_ADDRESS'] $script:A['MAIL_FROM_NAME'] }
  if (-not $script:BaseUrl) { $script:BaseUrl = New-BaseUrl }
  Write-Section 'Özet'
  Show-Settings
  if ($DryRun) { Show-DryRun; return }
  if (-not (Confirm-Step 'Bu ayarlar uygulansın mı? (eski ayarlar yedeklenir, uygulama yeniden başlatılır)')) { Die 'Vazgeçildi (hiçbir şey değiştirilmedi)' }

  $envf = Get-EnvPath; $conf = Get-ConfPath
  $cad = Join-Path $Root 'deploy\Caddyfile.local'
  $bak = @($envf, $conf); if ($script:Path -eq 'docker') { $bak += $cad }
  Backup-Config $bak
  Build-EnvChanges $script:Path
  $serviceRead = ($script:Path -eq 'native')
  Write-SecureFile $envf (Invoke-EnvApply (Read-Lines $envf) $script:Chg) $serviceRead
  Ok "Ayar dosyası güncellendi: $envf"
  Write-TlsFiles
  $script:DemoPending = 'no'; $script:DemoSeeded = Get-Cur 'DEMO_SEEDED' 'no'; $script:A['DEMO'] = Get-Cur 'DEMO' 'no'
  Write-WizardConf
  $taskSnap = Save-BackupTaskSnapshot
  Write-BackupTask
  if (-not (Restart-AndVerify $Port)) {
    Warn 'Uygulama yeni ayarlarla hazır olmadı; eski ayarlar ve yedek görevi geri yükleniyor…'
    foreach ($f in $bak) { $b = "$f.bak-$($script:Stamp)"; if (Test-Path -LiteralPath $b) { Copy-Item -Force -LiteralPath $b -Destination $f } }
    Restore-BackupTaskSnapshot $taskSnap
    $script:A['TLS_MODE'] = Get-Cur 'TLS_MODE' 'none'
    [void](Restart-AndVerify ([int](Get-Cur 'PORT' "$Port")))
    Die "Yeniden yapılandırma başarısız; önceki ayarlar geri yazıldı (yedek: $envf.bak-$($script:Stamp)). Günlüğe bakın: $DataDir\logs"
  }
  Remove-BackupTaskSnapshot $taskSnap
  Ok 'Uygulama yeni ayarlarla çalışıyor'
  $base = "http://127.0.0.1:$Port"
  Test-LicenseGate $base; Invoke-LicenseActivation $base
  $pc = Invoke-Http 'GET' "$base/api/public-config"
  if ($script:A['MAIL_ENABLED'] -eq 'yes' -and $pc.Body -match '"mailEnabled":true') { Ok 'E-posta etkin (public-config: mailEnabled)' }
  if ($script:MailTestDeferred -and $script:A['MAIL_TEST_TO']) { if (-not (Send-TestMailContainer $script:A['MAIL_TEST_TO'])) { Warn 'Test e-postası gönderilemedi (yukarıya bakın).' } }
  if ($Kit) { try { if ($script:Path -eq 'native') { Install-Updater 'native' $envf } else { Install-Updater 'docker' $envf } } catch { } }
  if ($script:A['TLS_MODE'] -ne 'none') { $url = $script:BaseUrl; if (-not $url) { $url = "https://$($script:Domain)" } }
  elseif ($script:Access -eq 'lan') { $url = "http://$(Get-LanIp):$Port" } else { $url = "http://localhost:$Port" }
  Show-Summary $url
}
