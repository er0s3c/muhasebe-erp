# Muhasebe ERP kurulum sihirbazı — yapılandırma kitaplığı (Windows, PowerShell 5.1 uyumlu).
# install.ps1 tarafından dot-source edilir. install.sh'deki installer/lib/config.sh ve wizard.sh ile aynı anahtarları ve davranışı taşır.
# İçerik: yanıt dosyası okuyucu, doğrulayıcılar, soru yardımcıları, ortam dosyası düzenleyici, SMTP adresi, Caddy dosyası, sertifika denetimi.
# Doğrulayıcılar geçerliyse $null, değilse nedenini (Türkçe metin) döndürür.

$script:AnswerKeys = @('MODE', 'INSTALL_PATH', 'ACCESS', 'DOMAIN', 'PORT', 'DEMO', 'REGISTRATION', 'LICENSE_SERVER_URL', 'LICENSE_CODE', 'MAIL_ENABLED',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURITY', 'SMTP_USER', 'SMTP_PASSWORD', 'MAIL_FROM_ADDRESS', 'MAIL_FROM_NAME', 'MAIL_TEST_TO', 'APP_BASE_URL',
  'TLS_MODE', 'ACME_EMAIL', 'CERT_FILE', 'KEY_FILE', 'HTTP_PORT', 'HTTPS_PORT', 'BACKUP_DIR', 'BACKUP_KEEP', 'BACKUP_TIME')
$script:SecretKeys = @('SMTP_PASSWORD', 'LICENSE_CODE')
$script:A = @{}
foreach ($k in $script:AnswerKeys) { $script:A[$k] = '' }
$script:Cur = @{}
$script:InputEof = $false
$script:InputQueue = $null

# ---- Yanıt dosyası ------------------------------------------------------------------------------------------------------
# Hiçbir şey çalıştırılmaz/genişletilmez. Önceden dolu (komut satırı) değerler korunur; dosyada tekrar eden anahtarın sonuncusu geçerlidir.
# Değer kuralları (install.sh load_answers ile aynı; belge: installer/answers.example, docs/OPERATIONS.md §2):
#   UTF-8 (BOM olabilir), LF/CRLF; '#' ile başlayan satır yorum. Tırnaksız değerde baş/son boşluk atılır, "boşluk + #" sonrası
#   yorumdur, '#' ile başlayan değer yorum sayılır (boş). "…" ya da '…' içi olduğu gibi alınır (kaçış yok; aynı tırnak içeremez).
function Import-Answers([string]$file) {
  if (-not (Test-Path -LiteralPath $file)) { Die "Yanıt dosyası bulunamadı: $file" }
  $fromFile = @{}
  $n = 0
  foreach ($raw in [IO.File]::ReadAllLines($file, (New-Object System.Text.UTF8Encoding $false))) {
    $n++
    $line = $raw.TrimEnd("`r")
    if ($n -eq 1) { $line = $line.TrimStart([char]0xFEFF) }   # UTF-8 BOM (Not Defteri)
    $line = $line.Trim()
    if ($line -eq '' -or $line.StartsWith('#')) { continue }
    $i = $line.IndexOf('=')
    if ($i -lt 1) { Die "Yanıt dosyası $n. satır: 'ANAHTAR=değer' biçimi bekleniyor" }
    $key = $line.Substring(0, $i).Trim()
    $val = $line.Substring($i + 1).Trim()
    if ($val -match '^"([^"]*)"(\s+#.*)?$' -or $val -match "^'([^']*)'(\s+#.*)?$") { $val = $Matches[1] }
    else {
      $val = ($val -replace '\s+#.*$', '').Trim()
      if ($val.StartsWith('#')) { $val = '' }   # "ANAHTAR=   # açıklama": değer yok, yalnızca yorum
    }
    if ($script:AnswerKeys -notcontains $key) { Die "Yanıt dosyası $n. satır: bilinmeyen anahtar '$key' (geçerli anahtarlar: docs/OPERATIONS.md §2)" }
    if ($val -eq '') { continue }
    if ($script:A[$key] -ne '' -and -not $fromFile.ContainsKey($key)) { continue }
    $script:A[$key] = $val
    $fromFile[$key] = $true
  }
  $secret = $false
  foreach ($k in $script:SecretKeys) { if ($script:A[$k] -ne '') { $secret = $true } }
  if ($secret) { Warn 'Yanıt dosyasında parola/kod var: kurulum bitince dosyayı SİLİN (sihirbaz onu hiçbir yere kopyalamaz).' }
}

# ---- Doğrulayıcılar -----------------------------------------------------------------------------------------------------------
function V-Ok([string]$v) { return $null }
function V-Port([string]$v) {
  if ($v -match '^[0-9]{1,5}$' -and [int]$v -ge 1 -and [int]$v -le 65535) { return $null }
  return 'port 1-65535 arasında bir sayı olmalı'
}
function V-Email([string]$v) {
  if ($v -match '^[^\s@"<>,;'']+@[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$') { return $null }
  return 'geçerli bir e-posta adresi yazın (örn. ad@firma.com)'
}
function V-EmailOpt([string]$v) { if ($v -eq '') { return $null }; return (V-Email $v) }
function V-Fqdn([string]$v) {
  if ($v.Length -le 253 -and $v -match '^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$') { return $null }
  return 'geçerli bir alan adı yazın (örn. erp.firmaniz.com)'
}
function Test-Ipv4([string]$v) {
  if ($v -notmatch '^[0-9]{1,3}(\.[0-9]{1,3}){3}$') { return $false }
  foreach ($o in $v.Split('.')) { if ([int]$o -gt 255) { return $false } }
  return $true
}
function V-Host([string]$v) {
  if (-not (V-Fqdn $v)) { return $null }
  if (Test-Ipv4 $v) { return $null }
  if ($v -match '^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$') { return $null }
  return 'alan adı, bilgisayar adı ya da IP adresi yazın (örn. erp.firmaniz.com ya da 192.168.1.20)'
}
function V-Time([string]$v) { if ($v -match '^([01][0-9]|2[0-3]):[0-5][0-9]$') { return $null }; return 'saati SS:DD biçiminde yazın (örn. 02:30)' }
function V-Keep([string]$v) { if ($v -match '^[0-9]{1,3}$' -and [int]$v -ge 1) { return $null }; return 'saklanacak yedek sayısı 1 ile 999 arasında olmalı' }
function V-AbsPath([string]$v) {
  if ($v -match '^([A-Za-z]:\\|\\\\)[^"<>|?*\x00-\x1f]*$') { return $null }
  return 'tam yol yazın (örn. D:\Yedek ya da \\sunucu\paylasim); tırnak ve özel karakter içermemeli'
}
function V-LicenseUrl([string]$v) {
  if ($v -eq '') { return $null }
  if ($v -match '^https://[^/\s]+(/\S*)?$') { return $null }
  if ($v.StartsWith('http://')) { return 'üretimde lisans sunucusu adresi https:// ile başlamalı' }
  return 'adres https://lisans.firma.com biçiminde olmalı'
}
function V-LicenseCode([string]$v) {
  if ($v -eq '') { return $null }
  if ($v -match '^[A-Za-z0-9]{5}(-[A-Za-z0-9]{5}){4}$') { return $null }
  return 'kod XXXXX-XXXXX-XXXXX-XXXXX-XXXXX biçiminde olmalı (25 karakter, 5 grup)'
}
function V-DisplayName([string]$v) {
  if ($v.Length -le 80 -and $v -notmatch '["$`\\<>\x00-\x1f]') { return $null }
  return 'ad en çok 80 karakter olmalı; tırnak, $, ters bölü, < > içeremez'
}
function V-Plain([string]$v) { if ($v.Length -le 200 -and $v -notmatch '[\x00-\x1f]') { return $null }; return 'geçersiz karakter' }
function V-BaseUrl([string]$v) {
  if ($v -match '^https?://[^/\s]+$') { return $null }
  return 'adres http:// ya da https:// ile başlamalı, sonunda / olmamalı (örn. https://erp.firmaniz.com)'
}
function V-FileExists([string]$v) {
  if ($v -ne '' -and (Test-Path -LiteralPath $v -PathType Leaf)) { return $null }
  return 'dosya bulunamadı ya da okunamıyor'
}
function ConvertTo-YesNo([string]$v) {
  switch ($v.ToLowerInvariant()) {
    { $_ -in @('e', 'evet', 'y', 'yes', 'true', '1', 'on') } { return 'yes' }
    { $_ -in @('h', 'hayır', 'hayir', 'n', 'no', 'false', '0', 'off') } { return 'no' }
  }
  return $null
}

# ---- Soru yardımcıları ------------------------------------------------------------------------------------------------------
function Test-Interactive {
  if ($Yes -or $AnswersFile) { return $false }
  if ($script:InputEof) { return $false }
  if ($env:ERP_WIZARD_INPUT) { return $true }   # sınama: girdi dosyadan okunur
  if (-not [Environment]::UserInteractive) { return $false }
  try { if ([Console]::IsInputRedirected) { return $false } } catch { }
  return $true
}
function Read-Answer([string]$prompt, [bool]$secret) {
  if ($env:ERP_WIZARD_INPUT) {
    if ($null -eq $script:InputQueue) { $script:InputQueue = New-Object System.Collections.Queue; foreach ($l in [IO.File]::ReadAllLines($env:ERP_WIZARD_INPUT)) { $script:InputQueue.Enqueue($l) } }
    Write-Host -NoNewline $prompt
    if ($script:InputQueue.Count -eq 0) { $script:InputEof = $true; Write-Host ''; return '' }
    $v = [string]$script:InputQueue.Dequeue(); Write-Host ''
    return $v
  }
  if ($secret) {
    $s = Read-Host $prompt -AsSecureString
    $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringAuto($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
  }
  return (Read-Host $prompt)
}
function Write-Help([string]$t) { if ($t) { Write-Host "  $t" -ForegroundColor DarkGray } }
function Write-Section([string]$t) { Write-Host ''; Write-Host "-- $t --" -ForegroundColor Cyan }

# Ask-Val ANAHTAR "Soru" "açıklama" "varsayılan" 'DoğrulayıcıAdı' [gizli] → değer; $script:A[ANAHTAR] da güncellenir.
# Önceden doluysa (bayrak/yanıt dosyası) sorulmaz, yalnızca doğrulanır. Etkileşimsiz kipte varsayılan alınır.
function Ask-Val([string]$key, [string]$q, [string]$help, [string]$def, [string]$check, [bool]$secret = $false) {
  $cur = [string]$script:A[$key]
  if ($cur -ne '') {
    $m = & $check $cur
    if ($m) { Die "${q} geçersiz: $m" }
    return $cur
  }
  if (-not (Test-Interactive)) {
    $m = & $check $def
    if ($m) { Die "$q için değer gerekli ($m); yanıt dosyasına ya da bayrağa ekleyin" }
    $script:A[$key] = $def
    return $def
  }
  Write-Help $help
  while ($true) {
    $shown = ''; if ($def -and -not $secret) { $shown = " [$def]" }
    $v = Read-Answer "$q${shown}: " $secret
    if ($v -eq '') { $v = $def }
    $m = & $check $v
    if (-not $m) { $script:A[$key] = $v; return $v }
    Write-Host "  $([char]0x2717) $m" -ForegroundColor Red
    if ($script:InputEof) { Die "${q}: geçerli değer girilmedi" }
  }
}
function Ask-YesNo([string]$key, [string]$q, [string]$help, [string]$def) {
  $cur = [string]$script:A[$key]
  if ($cur -ne '') {
    $n = ConvertTo-YesNo $cur
    if (-not $n) { Die "${q}: 'evet' ya da 'hayır' yazın ($cur)" }
    $script:A[$key] = $n; return $n
  }
  if (-not (Test-Interactive)) { $script:A[$key] = $def; return $def }
  Write-Help $help
  $suffix = '[e/H]'; if ($def -eq 'yes') { $suffix = '[h/E]' }
  while ($true) {
    $v = Read-Answer "$q ${suffix}: " $false
    if ($v -eq '') { $script:A[$key] = $def; return $def }
    $n = ConvertTo-YesNo $v
    if ($n) { $script:A[$key] = $n; return $n }
    Write-Host "  $([char]0x2717) e (evet) ya da h (hayır) yazın" -ForegroundColor Red
    if ($script:InputEof) { Die "${q}: yanıt alınamadı" }
  }
}
function Ask-Choice([string]$key, [string]$q, [string]$help, [string]$def, [string[]]$opts) {
  $cur = [string]$script:A[$key]
  if ($cur -ne '') {
    if ($opts -notcontains $cur) { Die "${q}: '$cur' geçersiz (seçenekler: $($opts -join '/'))" }
    return $cur
  }
  if (-not (Test-Interactive)) { $script:A[$key] = $def; return $def }
  Write-Help $help
  while ($true) {
    $v = Read-Answer "$q [$def] ($($opts -join '/')): " $false
    if ($v -eq '') { $v = $def }
    if ($opts -contains $v.Trim()) { $script:A[$key] = $v.Trim(); return $v.Trim() }
    Write-Host "  $([char]0x2717) şunlardan birini yazın: $($opts -join '/')" -ForegroundColor Red
    if ($script:InputEof) { Die "${q}: yanıt alınamadı" }
  }
}
function Get-Cur([string]$k, [string]$def = '') { if ($script:Cur.ContainsKey($k) -and [string]$script:Cur[$k] -ne '') { return [string]$script:Cur[$k] }; return $def }

# ---- Ortam dosyası düzenleme --------------------------------------------------------------------------------------------------
# Invoke-EnvApply satırlar değişiklikler → yeni satırlar. Değişiklik: "ANAHTAR=değer" ya da "-ANAHTAR" (siler).
function Invoke-EnvApply([string[]]$lines, [string[]]$changes) {
  $set = New-Object System.Collections.Specialized.OrderedDictionary
  $unset = @{}
  foreach ($c in $changes) {
    if ($c.StartsWith('-')) { $unset[$c.Substring(1)] = $true }
    else { $i = $c.IndexOf('='); $set[$c.Substring(0, $i)] = $c.Substring($i + 1) }
  }
  $seen = @{}
  $out = New-Object System.Collections.Generic.List[string]
  foreach ($l in $lines) {
    if ($l -match '^([A-Za-z_][A-Za-z0-9_]*)=') {
      $k = $Matches[1]
      if ($unset.ContainsKey($k)) { continue }
      if ($set.Contains($k)) {
        if ($seen.ContainsKey($k)) { continue }
        $out.Add("$k=$($set[$k])"); $seen[$k] = $true; continue
      }
    }
    $out.Add($l)
  }
  foreach ($k in $set.Keys) { if (-not $seen.ContainsKey($k) -and -not $unset.ContainsKey($k)) { $out.Add("$k=$($set[$k])") } }
  return $out.ToArray()
}
function Hide-Secrets([string[]]$lines) {
  $res = @()
  foreach ($l in $lines) {
    $x = $l -replace '^(([A-Z_]*(PASSWORD|SECRET|TOKEN))=).*', '${1}********'
    $x = $x -replace '^(SMTP_URL=[a-z]+://[^:/@]*:)[^@]*@', '${1}********@'
    $res += $x
  }
  return $res
}
function ConvertTo-UrlEncoded([string]$s) {
  $e = [Uri]::EscapeDataString($s)
  foreach ($c in @('!', "'", '(', ')', '*')) { $e = $e.Replace($c, ('%{0:X2}' -f [int][char]$c)) }
  return $e
}
function ConvertFrom-UrlEncoded([string]$s) { return [Uri]::UnescapeDataString($s) }
function New-SmtpUrl([string]$h, [string]$port, [string]$sec, [string]$user, [string]$pass) {
  $scheme = 'smtp'; $q = ''
  switch ($sec) { 'ssl' { $scheme = 'smtps' } 'starttls' { $q = '?requireTLS=true' } 'none' { $q = '?ignoreTLS=true' } }
  $auth = ''
  if ($user) { $auth = "$(ConvertTo-UrlEncoded $user):$(ConvertTo-UrlEncoded $pass)@" }
  return "${scheme}://${auth}${h}:${port}${q}"
}
function New-MailFrom([string]$addr, [string]$name) { if ($name) { return "`"$name <$addr>`"" }; return $addr }

# ---- Caddy ----------------------------------------------------------------------------------------------------------------------
function New-Caddyfile([string]$mode, [string]$email, [string]$hport, [bool]$files) {
  $l = New-Object System.Collections.Generic.List[string]
  $l.Add("# Kurulum sihirbazı tarafından üretildi ($(Get-Date -Format s)). Elle değiştirmeyin: install.ps1 -Reconfigure ile yeniden üretilir.")
  if (($mode -eq 'auto' -and $email) -or $hport -ne '443') {
    $l.Add('{')
    if ($mode -eq 'auto' -and $email) { $l.Add("`temail $email") }
    if ($hport -ne '443') { $l.Add("`tauto_https disable_redirects") }
    $l.Add('}')
  }
  $l.Add('{$ERP_DOMAIN} {')
  if ($mode -eq 'byo' -or ($mode -eq 'selfsigned' -and $files)) { $l.Add("`ttls /etc/caddy/certs/fullchain.pem /etc/caddy/certs/privkey.pem") }
  elseif ($mode -eq 'selfsigned') { $l.Add("`ttls internal") }
  $l.Add("`tencode zstd gzip")
  $l.Add("`treverse_proxy app:3000")
  $l.Add('}')
  return $l.ToArray()
}

# ---- Araçlar (Node) ---------------------------------------------------------------------------------------------------------------
function Get-ToolNode {
  $kitNode = Join-Path (Join-Path (Join-Path $Root 'app') 'runtime') 'node.exe'
  if (Test-Path $kitNode) { try { & $kitNode -v *> $null; if ($LASTEXITCODE -eq 0) { return $kitNode } } catch { } }
  $nv = Get-NodeVersion
  if ($nv -and $nv.Major -ge 20) { return (Get-Command node).Source }
  return $null
}
function Get-ToolModulesDir { if (Test-Path (Join-Path (Join-Path (Join-Path $Root 'app') 'node_modules') 'nodemailer')) { return (Join-Path $Root 'app') }; return $Root }
function Invoke-Tool([string[]]$argv) {
  $node = Get-ToolNode
  if (-not $node) { return @{ Code = 127; Out = '' } }
  $env:ERP_NODE_MODULES_DIR = Get-ToolModulesDir
  try {
    $out = & $node (Join-Path (Join-Path $Installer 'tools') 'erp-tool.mjs') @argv 2>&1 | Out-String
    return @{ Code = $LASTEXITCODE; Out = $out.Trim() }
  } finally { Remove-Item Env:\ERP_NODE_MODULES_DIR -ErrorAction SilentlyContinue }
}

# ---- Sürüm karşılaştırma (SemVer 2.0 önceliği; install.sh ver_cmp ve @erp/license-core compareVersions ile aynı) ----------
function Test-Semver([string]$v) { return ($v -match '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$') }
function Compare-SemVer([string]$a, [string]$b) {
  $pa = $a.TrimStart('v').Split('+')[0]; $pb = $b.TrimStart('v').Split('+')[0]
  $ia = $pa.IndexOf('-'); $ib = $pb.IndexOf('-')
  $ca = if ($ia -ge 0) { $pa.Substring(0, $ia) } else { $pa }; $xa = if ($ia -ge 0) { $pa.Substring($ia + 1) } else { '' }
  $cb = if ($ib -ge 0) { $pb.Substring(0, $ib) } else { $pb }; $xb = if ($ib -ge 0) { $pb.Substring($ib + 1) } else { '' }
  $na = $ca.Split('.'); $nb = $cb.Split('.')
  for ($i = 0; $i -lt 3; $i++) {
    $x = 0; $y = 0
    if ($i -lt $na.Count) { [void][long]::TryParse($na[$i], [ref]$x) }
    if ($i -lt $nb.Count) { [void][long]::TryParse($nb[$i], [ref]$y) }
    if ($x -lt $y) { return -1 }; if ($x -gt $y) { return 1 }
  }
  if (-not $xa -and -not $xb) { return 0 }
  if (-not $xa) { return 1 }; if (-not $xb) { return -1 }
  $sa = $xa.Split('.'); $sb = $xb.Split('.')
  for ($i = 0; $i -lt [Math]::Max($sa.Count, $sb.Count); $i++) {
    if ($i -ge $sa.Count) { return -1 }; if ($i -ge $sb.Count) { return 1 }
    $p = $sa[$i]; $q = $sb[$i]; $pn = $p -match '^[0-9]+$'; $qn = $q -match '^[0-9]+$'
    if ($pn -and $qn) { $d = [decimal]$p - [decimal]$q; if ($d -lt 0) { return -1 }; if ($d -gt 0) { return 1 } }
    elseif ($pn -ne $qn) { if ($pn) { return -1 } else { return 1 } }
    elseif ($p -cne $q) { if ([string]::CompareOrdinal($p, $q) -lt 0) { return -1 } else { return 1 } }
  }
  return 0
}

# PowerShell tek tırnaklı metin içine güvenli yerleştirme ('…' içinde ' iki katına çıkar)
function ConvertTo-PsLiteral([string]$s) { return "'" + $s.Replace("'", "''") + "'" }
