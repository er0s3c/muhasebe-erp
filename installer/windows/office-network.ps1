param([ValidateSet('Enable','Trust')][string]$Mode='Enable',[string]$CertificateFile='',[string]$ExpectedThumbprint='')
$ErrorActionPreference='Stop'
if($Mode -eq 'Trust') {
  if(-not $CertificateFile -or $ExpectedThumbprint -notmatch '^[A-Fa-f0-9]{40}$'){throw 'Sertifika ve beklenen parmak izi gerekli'}
  $certificate=New-Object Security.Cryptography.X509Certificates.X509Certificate2((Resolve-Path -LiteralPath $CertificateFile).Path)
  if($certificate.Thumbprint -ne $ExpectedThumbprint){throw 'Sertifika parmak izi uyuşmuyor'}
  Write-Host "Ofis sunucusu sertifika parmak izi: $ExpectedThumbprint"
  if((Read-Host 'Satıcınızın/sunucu yöneticinizin verdiği parmak iziyle karşılaştırdınız mı? EVET yazın') -cne 'EVET'){throw 'Sertifika güveni onaylanmadı'}
  Import-Certificate -FilePath $CertificateFile -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
  exit 0
}
$taskData=Join-Path $env:ProgramData 'MuhasebeERP'
$taskProgram=Join-Path $env:ProgramFiles 'MuhasebeERP'
$taskEnv=Join-Path $taskData 'erp.env'
$taskLines=[IO.File]::ReadAllLines($taskEnv)
$taskPortLine=$taskLines | Where-Object {$_ -match '^PORT=([0-9]+)$'} | Select-Object -First 1
$taskPort=3000;if($taskPortLine){$taskPort=[int]($taskPortLine -split '=')[1]}
$taskHost=$env:COMPUTERNAME.ToLowerInvariant();if($taskHost -notmatch '^[a-z0-9-]+$'){throw 'Bilgisayar adı HTTPS için uygun değil'}
$taskProxy=Join-Path $taskData 'proxy';New-Item -ItemType Directory -Force -Path $taskProxy | Out-Null
& icacls $taskProxy /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-19:(OI)(CI)M' | Out-Null
$taskCaddy=Join-Path $taskProgram 'current\app\proxy\caddy.exe'
if(-not (Test-Path -LiteralPath $taskCaddy)){throw 'Kurulum paketinde HTTPS bileşeni yok'}
$taskConf=Join-Path $taskProxy 'Caddyfile'
[IO.File]::WriteAllText($taskConf,"https://${taskHost}:3443 {`n tls internal`n reverse_proxy 127.0.0.1:$taskPort`n}`n",(New-Object Text.UTF8Encoding $false))
$taskSvc=Join-Path $taskProgram 'proxy-service';New-Item -ItemType Directory -Force -Path $taskSvc | Out-Null
Copy-Item -LiteralPath (Join-Path $taskProgram 'service\MuhasebeERP.exe') -Destination (Join-Path $taskSvc 'MuhasebeERP-HTTPS.exe') -Force
$escape={param($value)[Security.SecurityElement]::Escape($value)}
$taskXml=@"
<service><id>MuhasebeERP-HTTPS</id><name>Muhasebe ERP HTTPS</name><executable>$(& $escape $taskCaddy)</executable><arguments>run --config &quot;$(& $escape $taskConf)&quot;</arguments><workingdirectory>$(& $escape $taskProxy)</workingdirectory><env name="XDG_DATA_HOME" value="$(& $escape $taskProxy)"/><env name="XDG_CONFIG_HOME" value="$(& $escape $taskProxy)"/><startmode>Automatic</startmode><serviceaccount><username>NT AUTHORITY\LocalService</username></serviceaccount><onfailure action="restart" delay="10 sec"/><logpath>$(& $escape (Join-Path $taskData 'logs'))</logpath><log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>5</keepFiles></log></service>
"@
[IO.File]::WriteAllText((Join-Path $taskSvc 'MuhasebeERP-HTTPS.xml'),$taskXml,(New-Object Text.UTF8Encoding $false))
$taskWrapper=Join-Path $taskSvc 'MuhasebeERP-HTTPS.exe'
if(Get-Service 'MuhasebeERP-HTTPS' -ErrorAction SilentlyContinue){& $taskWrapper restart | Out-Null}else{& $taskWrapper install | Out-Null;& $taskWrapper start | Out-Null}
if($LASTEXITCODE -ne 0){throw 'HTTPS hizmeti kurulamadı'}
if(-not (Get-NetFirewallRule -Name 'MuhasebeERP-Office-HTTPS' -ErrorAction SilentlyContinue)){New-NetFirewallRule -Name 'MuhasebeERP-Office-HTTPS' -DisplayName 'Muhasebe ERP ofis HTTPS' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3443 -Profile Private -RemoteAddress LocalSubnet | Out-Null}
$taskRootCert=Join-Path $taskProxy 'caddy\pki\authorities\local\root.crt'
for($taskTry=0;$taskTry -lt 30 -and -not (Test-Path -LiteralPath $taskRootCert);$taskTry++){Start-Sleep -Seconds 1}
if(-not (Test-Path -LiteralPath $taskRootCert)){throw 'Ofis sertifikası oluşturulamadı'}
Import-Certificate -FilePath $taskRootCert -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
$taskThumb=(New-Object Security.Cryptography.X509Certificates.X509Certificate2($taskRootCert)).Thumbprint
$taskLines=@($taskLines | Where-Object {$_ -notmatch '^(HOST|COOKIE_SECURE|TRUST_PROXY|APP_BASE_URL)='})+@('HOST=127.0.0.1','COOKIE_SECURE=true','TRUST_PROXY=loopback',"APP_BASE_URL=https://${taskHost}:3443")
[IO.File]::WriteAllLines($taskEnv,$taskLines,(New-Object Text.UTF8Encoding $false));Restart-Service 'MuhasebeERP'
$taskOffice=Join-Path $taskData 'office-connect';New-Item -ItemType Directory -Force -Path $taskOffice | Out-Null
Copy-Item -LiteralPath $taskRootCert -Destination (Join-Path $taskOffice 'office-root.crt') -Force
Copy-Item -LiteralPath $PSCommandPath -Destination (Join-Path $taskOffice 'connect.ps1') -Force
[IO.File]::WriteAllText((Join-Path $taskOffice 'README.txt'),"Adres: https://${taskHost}:3443`r`nSertifika parmak izi: $taskThumb`r`nYönetici PowerShell: .\connect.ps1 -Mode Trust -CertificateFile .\office-root.crt -ExpectedThumbprint $taskThumb`r`nYalnızca office-connect klasörünü diğer bilgisayarlara aktarın; veri/ayar klasörlerini paylaşmayın.")
[IO.File]::WriteAllText((Join-Path $taskData 'launch-url.txt'),"https://${taskHost}:3443")
$taskUpdaterFile=Join-Path $taskData 'updater.json'
if(Test-Path -LiteralPath $taskUpdaterFile){$taskUpdater=Get-Content -Raw -LiteralPath $taskUpdaterFile | ConvertFrom-Json; $taskUpdater | Add-Member -Force NoteProperty httpsCheck @{port=3443;host=$taskHost;caFile=$taskRootCert};[IO.File]::WriteAllText($taskUpdaterFile,($taskUpdater | ConvertTo-Json -Depth 5),(New-Object Text.UTF8Encoding $false))}
Write-Host "Ofis HTTPS hazır: https://${taskHost}:3443"
