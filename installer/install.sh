#!/usr/bin/env bash
# =====================================================================================================================
# Muhasebe ERP kurulum sihirbazı — Linux ve WSL (Ubuntu/Debian)
#
#   1) Uyumluluk kontrolü   2) Yol seçimi   3) Yapılandırma (sorular)   4) Gerekli paketler   5) Sistemin kurulumu
#
# Tek betikle kurulum VE tüm yapılandırma: demo/boş veri, lisans, e-posta (SMTP), alan adı/sertifika (HTTPS), yedekleme, portlar.
# Etkileşimli (terminalde) sorar; her sorunun varsayılanı vardır (Enter kabul eder).
#
# Kip:
#   dev   Depodan test/geliştirme kurulumu (Node 22 + PostgreSQL 16 ya da Docker'da veritabanı, demo verisi)
#   prod  Müşteri kurulumu (kaynaksız sürüm kiti; kit.json varsa varsayılan)
# Yol:
#   docker  PostgreSQL + uygulama Docker Compose ile
#   native  PostgreSQL 16 yerel kurulur; uygulama systemd hizmeti (systemd yoksa erpctl) olarak çalışır
#
# Kullanım:  ./install.sh [--check] [--mode=dev|prod] [--path=docker|native] [--access=local|lan|domain]
#                         [--domain=erp.ornek.com] [--port=3000] [--tls=auto|byo|selfsigned|none] [--demo|--no-demo]
#                         [--yes] [--answers=DOSYA] [--reconfigure] [--dry-run] [--start]
#                         [--uninstall [--purge [--i-understand-purge]]] [--allow-downgrade]
#                         [--restore-db=yedek.dump]   (güncelleyicinin geri dönüşü: kurmadan önce veritabanını yedekten yükler)
#   --yes            tüm sorulara varsayılanı verir (sormaz)
#   --answers=DOSYA  sormaz; KEY=VALUE yanıt dosyasından okur (örnek: installer/answers.example). Yalnızca YENİ kurulumda ya da
#                    --reconfigure ile; kurulu sistemde yanıt dosyası/farklı ayar bayrağı verilirse sihirbaz durur (yok saymaz)
#   --reconfigure    kurulu sistemde yalnızca yapılandırmayı (SMTP, HTTPS, yedek, lisans adresi) yeniden sorar ve uygular
#   --dry-run        sistemi değiştirmeden ne yazılacağını/silineceğini gösterir (parolalar maskeli; --uninstall ile de)
#   --uninstall      programı ve hizmetleri kaldırır (yerel ya da Docker); veritabanı, ayarlar ve yedekler korunur
#   --purge          --uninstall ile: sihirbazın oluşturduğu veritabanını, ayarları ve varsayılan yedek klasörünü de KALICI siler.
#                    Terminalde 'SIL' yazarak onay ister (--yes bu onayı vermez); betikte yalnızca --i-understand-purge ile
#   --allow-downgrade kurulu sürümden ESKİ bir kiti kurmaya izin verir (veritabanı yeni şemada kalır; önerilmez)
# Ayrıntı:   docs/OPERATIONS.md §2 (Kurulum sihirbazı)
# =====================================================================================================================
# shellcheck disable=SC2034  # değişkenler yapılandırma kitaplıklarında (source) ve dolaylı atamalarla kullanılır
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALLER="$ROOT/installer"

# ---- Sabitler -------------------------------------------------------------------------------------------------------
NODE_MAJOR=22
NODE_MIN="22.9.0"
PG_MAJOR=16
MIN_RAM_MB=2048
REC_RAM_MB=4096
MIN_DISK_MB=5120
REC_DISK_MB=10240
PREFIX=/opt/muhasebe-erp
ETC=/etc/muhasebe-erp
VARDIR=/var/lib/muhasebe-erp
SVC_USER=muhasebe-erp
SVC_NAME=muhasebe-erp
DB_NAME=erp
# Yönetici (root) işlerinin klasörleri: hizmet kullanıcısının yazabildiği $VARDIR altında OLMAZ (sembolik bağ/yer değiştirme
# saldırısıyla root yetkisi alınmasın). Eski kurulumlardaki $VARDIR/updater ve $VARDIR/backups buraya taşınır.
UPD_WORK=/var/lib/muhasebe-erp-updater
NATIVE_BACKUP_DIR=/var/backups/muhasebe-erp

# ---- Seçenekler -----------------------------------------------------------------------------------------------------
OPT_CHECK=0 OPT_YES=0 OPT_START=0 OPT_UNINSTALL=0 OPT_PURGE=0 OPT_PURGE_ACK=0 OPT_DRYRUN=0 OPT_RECONFIGURE=0 OPT_ALLOW_DOWNGRADE=0 ANSWERS_FILE=""
declare -A FLAG_VAL=()   # komut satırında verilen ayar bayrakları (kurulu sistemde mevcut ayarla çelişirse sihirbaz durur)
DB_CREATED="" ROLES_CREATED=""
MODE="" PATH_CHOICE="" ACCESS="" DOMAIN="" PORT="" RESTORE_DB=""
# Yanıt anahtarları (installer/lib/config.sh ANSWER_KEYS); komut satırı bayrakları yanıt dosyasından önceliklidir
DEMO="" REGISTRATION="" LICENSE_SERVER_URL="" LICENSE_CODE="" MAIL_ENABLED="" SMTP_HOST="" SMTP_PORT="" SMTP_SECURITY="" SMTP_USER=""
SMTP_PASSWORD="" MAIL_FROM_ADDRESS="" MAIL_FROM_NAME="" MAIL_TEST_TO="" APP_BASE_URL="" TLS_MODE="" ACME_EMAIL="" CERT_FILE="" KEY_FILE=""
HTTP_PORT="" HTTPS_PORT="" BACKUP_DIR="" BACKUP_KEEP="" BACKUP_TIME="" DEMO_PENDING="" DEMO_SEEDED="" WIZARD_TMP=""
UPD_DIR=$PREFIX/updater

usage() { sed -n '2,/^set -E/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }

while (( $# )); do
  arg="$1"; shift
  case "$arg" in
    --check) OPT_CHECK=1 ;;
    --yes|-y) OPT_YES=1 ;;
    --demo) DEMO=yes; FLAG_VAL[DEMO]=yes ;;
    --no-demo) DEMO=no; FLAG_VAL[DEMO]=no ;;
    --start) OPT_START=1 ;;
    --uninstall) OPT_UNINSTALL=1 ;;
    --purge) OPT_PURGE=1 ;;
    --i-understand-purge) OPT_PURGE_ACK=1 ;;
    --allow-downgrade) OPT_ALLOW_DOWNGRADE=1 ;;
    --dry-run) OPT_DRYRUN=1 ;;
    --reconfigure) OPT_RECONFIGURE=1 ;;
    --answers) (( $# )) || { echo "--answers bir dosya yolu ister" >&2; exit 2; }; ANSWERS_FILE="$1"; shift ;;
    --answers=*) ANSWERS_FILE="${arg#*=}" ;;
    --mode=*) MODE="${arg#*=}" ;;
    --path=*) PATH_CHOICE="${arg#*=}" ;;
    --access=*) ACCESS="${arg#*=}"; FLAG_VAL[ACCESS]="$ACCESS" ;;
    --domain=*) DOMAIN="${arg#*=}"; FLAG_VAL[DOMAIN]="$DOMAIN" ;;
    --port=*) PORT="${arg#*=}"; FLAG_VAL[PORT]="$PORT" ;;
    --tls=*) TLS_MODE="${arg#*=}"; FLAG_VAL[TLS_MODE]="$TLS_MODE" ;;
    --http-port=*) HTTP_PORT="${arg#*=}"; FLAG_VAL[HTTP_PORT]="$HTTP_PORT" ;;
    --https-port=*) HTTPS_PORT="${arg#*=}"; FLAG_VAL[HTTPS_PORT]="$HTTPS_PORT" ;;
    --restore-db=*) RESTORE_DB="${arg#*=}" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Bilinmeyen seçenek: $arg (yardım: --help)" >&2; exit 2 ;;
  esac
done

# ---- Çıktı yardımcıları -----------------------------------------------------------------------------------------------
if [[ -t 1 ]]; then
  C_OK=$'\e[32m' C_WARN=$'\e[33m' C_FAIL=$'\e[31m' C_DIM=$'\e[2m' C_B=$'\e[1m' C_0=$'\e[0m'
else
  C_OK='' C_WARN='' C_FAIL='' C_DIM='' C_B='' C_0=''
fi
say()  { printf '%s\n' "$*"; }
info() { printf '  %s\n' "$*"; }
okm()  { printf '  %s✓%s %s\n' "$C_OK" "$C_0" "$*"; }
warn() { printf '  %s!%s %s\n' "$C_WARN" "$C_0" "$*" >&2; }
die()  { printf '\n%s✗ %s%s\n' "$C_FAIL" "$*" "$C_0" >&2; exit 1; }
stage() { printf '\n%s== %s ==%s\n' "$C_B" "$*" "$C_0"; }
trap 'die "Beklenmeyen hata (satır $LINENO). Yukarıdaki çıktıyı kontrol edin; sihirbaz güvenle yeniden çalıştırılabilir."' ERR

# Etkileşimli girdi, yardımcılar ve yapılandırma kitaplığı (installer/lib/config.sh): ask/confirm da burada tanımlanır
# shellcheck source=lib/config.sh
. "$INSTALLER/lib/config.sh"
# shellcheck source=lib/wizard.sh
. "$INSTALLER/lib/wizard.sh"

ask() { # ask "Soru" varsayılan seçenek1 seçenek2 ... → seçilen değer (stdout)
  local q="$1" def="$2" o; shift 2
  if ! interactive; then printf '%s' "$def"; return; fi
  prompt_line "$q [$def] ($(IFS=/; echo "$*")): "
  local ans="${REPLY_VAL:-$def}"
  for o in "$@"; do [[ "$o" == "$ans" ]] && { printf '%s' "$ans"; return; }; done
  printf '%s' "$def"
}
confirm() { # confirm "Soru" → 0 evet (etkileşimsiz kipte her zaman evet)
  if ! interactive; then return 0; fi
  prompt_line "$1 [E/h]: "
  [[ -z "$REPLY_VAL" || "$REPLY_VAL" =~ ^[EeYy] ]]
}
section() { printf '\n%s-- %s --%s\n' "$C_B" "$1" "$C_0" >&2; }

rand_hex() { if command -v openssl >/dev/null; then openssl rand -hex "$1"; else head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; fi; }
rand_b64() { head -c "$1" /dev/urandom | base64 | tr -d '\n=' | tr '+/' '-_'; }

pad() { # çok baytlı (Türkçe) karakterlerde de doğru hizalama
  local s="$1" n="$2" len
  len="$(printf '%s' "$s" | LC_ALL=C.UTF-8 wc -m 2>/dev/null || printf '%s' "${#s}")"
  printf '%s%*s' "$s" $(( n > len ? n - len : 0 )) ''
}
ver_ge() { [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" == "$2" ]]; }

# Yönetici komutları: root değilsek sudo
SUDO=""
if [[ $EUID -ne 0 ]]; then command -v sudo >/dev/null && SUDO="sudo"; fi
as_root() { if [[ $EUID -eq 0 ]]; then "$@"; elif [[ -n "$SUDO" ]]; then sudo "$@"; else die "Bu adım yönetici yetkisi ister (sudo bulunamadı): $*"; fi; }
# İstemci kodlaması UTF-8 (C yerelinde SQL_ASCII olur; SQL dosyaları UTF-8'dir). sudo ortamı sıfırladığından env ile verilir.
as_postgres() { if [[ $EUID -eq 0 ]]; then runuser -u postgres -- env PGCLIENTENCODING=UTF8 "$@"; else sudo -u postgres env PGCLIENTENCODING=UTF8 "$@"; fi; }
# Depodaki npm adımları kurulumu başlatan kullanıcıyla çalışır (sudo ile başlatıldıysa yetki düşürülür)
as_user() { if [[ $EUID -eq 0 && -n "${SUDO_USER:-}" && "${SUDO_USER}" != root ]]; then sudo -u "$SUDO_USER" -H "$@"; else "$@"; fi; }

# ---- Ortam algılama -----------------------------------------------------------------------------------------------------
OS_ID="" OS_VER="" OS_CODENAME="" OS_PRETTY="" IS_WSL=0 ARCH="" HAS_SYSTEMD=0 HAS_APT=0
KIT=0 KIT_VERSION="" KIT_TARGET="" KIT_LICENSE_URL="" REPO=0
detect() {
  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    OS_ID="${ID:-}"; OS_VER="${VERSION_ID:-}"; OS_CODENAME="${VERSION_CODENAME:-}"; OS_PRETTY="${PRETTY_NAME:-$ID}"
  fi
  if grep -qi microsoft /proc/version 2>/dev/null || [[ -n "${WSL_DISTRO_NAME:-}" ]]; then IS_WSL=1; fi
  case "$(uname -m)" in x86_64|amd64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;; *) ARCH="$(uname -m)" ;; esac
  [[ "$(cat /proc/1/comm 2>/dev/null)" == systemd ]] && HAS_SYSTEMD=1
  command -v apt-get >/dev/null && HAS_APT=1
  if [[ -f "$ROOT/kit.json" ]]; then
    KIT=1
    KIT_VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/kit.json" | head -n1)"
    KIT_TARGET="$(sed -n 's/.*"target": *"\([^"]*\)".*/\1/p' "$ROOT/kit.json" | head -n1)"
    KIT_LICENSE_URL="$(sed -n 's/.*"licenseServerUrl": *"\([^"]*\)".*/\1/p' "$ROOT/kit.json" | head -n1)"
  fi
  [[ -f "$ROOT/package.json" && -d "$ROOT/apps/api" ]] && REPO=1
  [[ -z "$MODE" ]] && { if (( KIT )); then MODE=prod; else MODE=dev; fi; }
  [[ "$MODE" == dev || "$MODE" == prod ]] || die "--mode dev ya da prod olmalı"
  if [[ "$MODE" == dev && $REPO -eq 0 ]]; then die "Geliştirme kurulumu depo klasöründen çalıştırılır (package.json bulunamadı)"; fi
  return 0
}

node_version() { command -v node >/dev/null && node -v 2>/dev/null | sed 's/^v//' || true; }
pg_server_version() { # kurulu PostgreSQL sunucusunun ana sürümü (yoksa boş)
  local v=""
  # pipefail + set -e: PostgreSQL hiç kurulu değilse (dizin yok) boru hattı hata döner; "yok" geçerli bir yanıttır
  if command -v pg_lsclusters >/dev/null; then v="$(pg_lsclusters -h 2>/dev/null | awk '{print $1}' | sort -V | tail -n1 || true)"; fi
  if [[ -z "$v" ]]; then v="$(ls /usr/lib/postgresql 2>/dev/null | sort -V | tail -n1 || true)"; fi
  printf '%s' "$v"
}
pg_port() { # PG_MAJOR kümesinin portu (Debian postgresql-common); bulunamazsa 5432
  local p=""
  command -v pg_lsclusters >/dev/null && p="$(pg_lsclusters -h 2>/dev/null | awk -v v="$PG_MAJOR" '$1==v {print $3; exit}')"
  printf '%s' "${p:-5432}"
}
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && { exec 3>&- 3<&-; return 0; } || return 1; }
docker_ok() { command -v docker >/dev/null && docker info >/dev/null 2>&1; }
compose_ok() { docker compose version >/dev/null 2>&1; }
net_ok() { command -v curl >/dev/null && curl -fsSI --max-time 8 "$1" >/dev/null 2>&1; }

# ---- 1) Uyumluluk kontrolü ----------------------------------------------------------------------------------------------
declare -a CK_NAME=() CK_STATE=() CK_MSG=()
FAILS=0 DOCKER_READY=0 NODE_READY=0 PG_READY=0
ck() { CK_NAME+=("$1"); CK_STATE+=("$2"); CK_MSG+=("$3"); [[ "$2" == fail ]] && FAILS=$((FAILS+1)); return 0; }

compat_check() {
  stage "1/5 Sistem uyumluluk kontrolü"
  local supported=0
  case "$OS_ID" in
    ubuntu) ver_ge "$OS_VER" 22.04 && supported=1 ;;
    debian) ver_ge "$OS_VER" 12 && supported=1 ;;
  esac
  local osdesc="${OS_PRETTY:-bilinmiyor}"; (( IS_WSL )) && osdesc="$osdesc (WSL)"
  if (( supported )); then ck "İşletim sistemi" ok "$osdesc"
  elif (( HAS_APT )); then ck "İşletim sistemi" warn "$osdesc — sınanmamış dağıtım (Ubuntu 22.04+/Debian 12+ önerilir)"
  else ck "İşletim sistemi" warn "$osdesc — apt yok: paketler otomatik kurulamaz, yalnızca Docker yolu"
  fi

  if [[ "$ARCH" == x64 ]]; then ck "İşlemci mimarisi" ok "x64"
  elif [[ "$ARCH" == arm64 ]]; then
    if [[ "$MODE" == prod && "$KIT_TARGET" == linux-x64 ]]; then ck "İşlemci mimarisi" fail "arm64 — bu kit x64 içindir (Docker yolu da x64 bağımlılık içerir)"
    else ck "İşlemci mimarisi" warn "arm64 — geliştirme kurulumu çalışır; müşteri kitleri x64'tür"; fi
  else ck "İşlemci mimarisi" fail "$ARCH desteklenmiyor"; fi

  local ram_mb; ram_mb=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null || echo 0) / 1024 ))
  if (( ram_mb < MIN_RAM_MB )); then ck "Bellek" fail "${ram_mb} MB (en az ${MIN_RAM_MB} MB)"
  elif (( ram_mb < REC_RAM_MB )); then ck "Bellek" warn "${ram_mb} MB (${REC_RAM_MB} MB önerilir)"
  else ck "Bellek" ok "${ram_mb} MB"; fi

  local disk_mb; disk_mb=$(( $(df -Pk "$ROOT" 2>/dev/null | awk 'NR==2 {print $4}') / 1024 ))
  if (( disk_mb < MIN_DISK_MB )); then ck "Boş disk" fail "${disk_mb} MB (en az ${MIN_DISK_MB} MB)"
  elif (( disk_mb < REC_DISK_MB )); then ck "Boş disk" warn "${disk_mb} MB (${REC_DISK_MB} MB önerilir)"
  else ck "Boş disk" ok "${disk_mb} MB"; fi

  if [[ $EUID -eq 0 ]]; then ck "Yönetici yetkisi" ok "root"
  elif [[ -n "$SUDO" ]]; then ck "Yönetici yetkisi" ok "sudo (parola sorulabilir)"
  else ck "Yönetici yetkisi" warn "sudo yok: paket ve hizmet kurulumu yapılamaz"; fi

  if (( HAS_SYSTEMD )); then ck "Hizmet yöneticisi" ok "systemd"
  elif (( IS_WSL )); then ck "Hizmet yöneticisi" warn "WSL'de systemd kapalı: uygulama erpctl ile başlatılır (açmak için sihirbaz önerir)"
  else ck "Hizmet yöneticisi" warn "systemd yok: uygulama erpctl ile başlatılır, açılışta kendiliğinden başlamaz"; fi

  if docker_ok && compose_ok; then DOCKER_READY=1; ck "Docker" ok "$(docker version --format '{{.Server.Version}}' 2>/dev/null) + compose v2"
  elif docker_ok; then ck "Docker" warn "çalışıyor ama compose v2 eklentisi yok (docker-compose-plugin)"
  elif command -v docker >/dev/null; then
    if (( IS_WSL )); then ck "Docker" info "kurulu ama erişilemiyor (Docker Desktop açık ve WSL entegrasyonu etkin mi?) — yerel yol kullanılabilir"
    else ck "Docker" info "kurulu ama hizmet çalışmıyor ya da yetki yok — yerel yol kullanılabilir"; fi
  else ck "Docker" info "yok — yerel (Docker'sız) yol kullanılır"; fi

  local nv; nv="$(node_version)"
  if [[ "$MODE" == prod ]]; then ck "Node.js" ok "gerekmez (kitte gömülü çalışma zamanı)"; NODE_READY=1
  elif [[ -n "$nv" ]] && ver_ge "$nv" "$NODE_MIN"; then NODE_READY=1; ck "Node.js" ok "$nv"
  elif [[ -n "$nv" ]]; then ck "Node.js" info "$nv eski — Node $NODE_MAJOR kurulacak"
  else ck "Node.js" info "yok — Node $NODE_MAJOR kurulacak"; fi

  local pv; pv="$(pg_server_version)"
  if [[ -n "$pv" ]] && ver_ge "$pv" "$PG_MAJOR"; then PG_READY=1; ck "PostgreSQL" ok "$pv (port $(pg_port))"
  elif [[ -n "$pv" ]]; then ck "PostgreSQL" info "$pv kurulu; yerel yolda PostgreSQL $PG_MAJOR ayrıca kurulur"
  else ck "PostgreSQL" info "yok — yerel yolda PostgreSQL $PG_MAJOR kurulur"; fi

  local busy=()
  if [[ "$MODE" == dev ]]; then for p in 3000 5173; do port_busy "$p" && busy+=("$p"); done
  else port_busy "${PORT:-3000}" && busy+=("${PORT:-3000}"); fi
  if (( ${#busy[@]} )); then
    if [[ "$MODE" == prod ]] && { [[ -L "$PREFIX/current" ]] || docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^muhasebe-erp-app'; }; then
      ck "Portlar" info "${busy[*]} kullanımda (mevcut Muhasebe ERP kurulumu — yükseltilecek)"
    else ck "Portlar" warn "${busy[*]} kullanımda (başka bir uygulama?) — --port ile değiştirin ya da uygulamayı durdurun"; fi
  else ck "Portlar" ok "boş"; fi

  if net_ok https://nodejs.org; then ck "İnternet" ok "erişim var"
  else ck "İnternet" warn "nodejs.org'a erişilemedi — paket indirme gerekirse başarısız olur"; fi

  if grep -Eq '^[0-9a-f]{32}$' /etc/machine-id 2>/dev/null; then ck "Makine kimliği" ok "/etc/machine-id"
  else ck "Makine kimliği" warn "/etc/machine-id yok (lisans parmak izi zayıf kalır; sihirbaz oluşturur)"; fi

  if (( KIT )); then
    if [[ "$KIT_TARGET" == linux-x64 ]]; then ck "Sürüm kiti" ok "$KIT_VERSION ($KIT_TARGET)"
    else ck "Sürüm kiti" fail "$KIT_VERSION hedefi $KIT_TARGET — Linux için linux-x64 kitini kullanın"; fi
  elif [[ "$MODE" == prod ]]; then ck "Kaynak" info "depo: Docker yolu imajı kaynaktan derler; yerel yol için önce kit üretin (npm run release)"; fi

  local i sym col
  for i in "${!CK_NAME[@]}"; do
    case "${CK_STATE[$i]}" in ok) sym="✓"; col="$C_OK" ;; warn) sym="!"; col="$C_WARN" ;; fail) sym="✗"; col="$C_FAIL" ;; *) sym="·"; col="$C_DIM" ;; esac
    printf '  %s%s%s %s %s\n' "$col" "$sym" "$C_0" "$(pad "${CK_NAME[$i]}" 20)" "${CK_MSG[$i]}"
  done
}

# ---- 2) Yol seçimi ----------------------------------------------------------------------------------------------------------
choose_path() {
  stage "2/5 Kurulum yolu"
  local rec
  if [[ "$MODE" == prod ]]; then
    if (( DOCKER_READY )); then rec=docker; else rec=native; fi
    (( KIT == 0 )) && rec=docker
    (( EXISTING )) && [[ -n "$EXISTING_PATH" ]] && rec="$EXISTING_PATH"
  else
    if (( PG_READY )); then rec=native; elif (( DOCKER_READY )); then rec=docker; else rec=native; fi
  fi
  if [[ -z "$PATH_CHOICE" ]]; then
    info "Kip: $MODE   Önerilen yol: $rec"
    if [[ "$MODE" == dev ]]; then
      info "  docker : PostgreSQL Docker'da çalışır, Node bu bilgisayarda"
      info "  native : PostgreSQL $PG_MAJOR bu bilgisayara kurulur"
    else
      info "  docker : veritabanı + uygulama Docker Compose ile (izole, kolay yedek)"
      info "  native : PostgreSQL $PG_MAJOR + uygulama hizmeti doğrudan bu bilgisayarda (Docker gerekmez)"
    fi
    PATH_CHOICE="$(ask "Hangi yolla kurulsun?" "$rec" docker native)"
  fi
  [[ "$PATH_CHOICE" == docker || "$PATH_CHOICE" == native ]] || die "--path docker ya da native olmalı"
  if [[ "$PATH_CHOICE" == docker && $DOCKER_READY -eq 0 ]]; then
    die "Docker yolu seçildi ama Docker (compose v2 ile) çalışmıyor. Docker'ı kurup başlatın ya da --path=native kullanın."
  fi
  if [[ "$MODE" == prod && "$PATH_CHOICE" == native && $KIT -eq 0 ]]; then
    die "Yerel müşteri kurulumu derlenmiş bir sürüm kitinden yapılır: 'npm run release -- --version=X --targets=linux-x64' ile üretip kitin içinden çalıştırın."
  fi
  if (( FAILS )); then
    die "Uyumluluk kontrolünde engelleyici sorun var (✗). Giderip sihirbazı yeniden çalıştırın."
  fi

  if [[ "$MODE" == prod ]]; then ask_access; else ACCESS=local; fi
  [[ "$ACCESS" == local || "$ACCESS" == lan || "$ACCESS" == domain ]] || die "--access local, lan ya da domain olmalı"
  if [[ "$ACCESS" == domain && "$PATH_CHOICE" != docker ]]; then
    die "Alan adı + HTTPS şimdilik Docker yolunda (Caddy) desteklenir; yerel yolda lan seçip önüne bir ters vekil koyun."
  fi
  okm "Yol: $MODE / $PATH_CHOICE / erişim: $ACCESS"
}

# ---- 3) Gerekli paketler ---------------------------------------------------------------------------------------------------
APT_UPDATED=0
apt_install() {
  (( HAS_APT )) || die "apt bulunamadı; şu paketleri elle kurun: $*"
  if (( ! APT_UPDATED )); then as_root env DEBIAN_FRONTEND=noninteractive apt-get update -qq; APT_UPDATED=1; fi
  as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "$@" >/dev/null
}

install_node() {
  local nv; nv="$(node_version)"
  if [[ -n "$nv" ]] && ver_ge "$nv" "$NODE_MIN"; then okm "Node.js $nv hazır"; return; fi
  info "Node.js $NODE_MAJOR resmî paketten kuruluyor (nodejs.org, SHA-256 doğrulamalı)…"
  command -v curl >/dev/null && command -v xz >/dev/null || apt_install curl ca-certificates xz-utils
  local base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x" tmp file sum
  tmp="$(mktemp -d)"
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  file="$(awk -v a="linux-$ARCH.tar.xz" '$2 ~ a"$" {print $2; exit}' "$tmp/SHASUMS256.txt")"
  [[ -n "$file" ]] || die "nodejs.org üzerinde linux-$ARCH paketi bulunamadı"
  curl -fsSL "$base/$file" -o "$tmp/$file"
  sum="$(awk -v f="$file" '$2==f {print $1}' "$tmp/SHASUMS256.txt")"
  echo "$sum  $tmp/$file" | sha256sum -c --quiet - || die "Node.js paketinin SHA-256 özeti tutmadı (indirme bozuk)"
  as_root mkdir -p /usr/local/lib/nodejs
  as_root tar -xJf "$tmp/$file" -C /usr/local/lib/nodejs
  local dir="/usr/local/lib/nodejs/${file%.tar.xz}"
  for b in node npm npx; do as_root ln -sf "$dir/bin/$b" "/usr/local/bin/$b"; done
  rm -rf "$tmp"
  hash -r
  okm "Node.js $(node -v) kuruldu ($dir)"
}

start_postgres() {
  if (( HAS_SYSTEMD )); then as_root systemctl enable --now postgresql >/dev/null 2>&1 || true
  elif command -v pg_ctlcluster >/dev/null; then as_root pg_ctlcluster "$PG_MAJOR" main start >/dev/null 2>&1 || true
  else as_root service postgresql start >/dev/null 2>&1 || true; fi
  local i
  for i in $(seq 1 30); do
    as_postgres psql -p "$(pg_port)" -tAc 'select 1' >/dev/null 2>&1 && return 0
    sleep 1
  done
  die "PostgreSQL $PG_MAJOR başlatılamadı (günlük: /var/log/postgresql/)"
}

install_postgres() {
  if [[ -d "/usr/lib/postgresql/$PG_MAJOR/bin" ]]; then okm "PostgreSQL $PG_MAJOR kurulu"; start_postgres; return; fi
  (( HAS_APT )) || die "PostgreSQL $PG_MAJOR otomatik kurulamaz (apt yok). Elle kurup sihirbazı yeniden çalıştırın."
  info "PostgreSQL $PG_MAJOR kuruluyor…"
  apt_install ca-certificates curl gnupg
  if ! apt-cache policy "postgresql-$PG_MAJOR" 2>/dev/null | grep -q 'Candidate: [0-9]'; then
    info "Dağıtım deposunda yok; resmî PostgreSQL (PGDG) deposu ekleniyor…"
    [[ -n "$OS_CODENAME" ]] || die "Dağıtım kod adı bulunamadı (VERSION_CODENAME)"
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | as_root gpg --dearmor --yes -o /usr/share/keyrings/postgresql.gpg
    echo "deb [signed-by=/usr/share/keyrings/postgresql.gpg] https://apt.postgresql.org/pub/repos/apt ${OS_CODENAME}-pgdg main" \
      | as_root tee /etc/apt/sources.list.d/pgdg.list >/dev/null
    APT_UPDATED=0
  fi
  apt_install "postgresql-$PG_MAJOR"
  start_postgres
  okm "PostgreSQL $PG_MAJOR kuruldu (port $(pg_port))"
}

prerequisites() {
  stage "4/5 Gerekli paketler"
  command -v curl >/dev/null || apt_install curl ca-certificates
  if [[ "$MODE" == dev ]]; then install_node; fi
  if [[ "$PATH_CHOICE" == native ]]; then install_postgres; else okm "Docker hazır ($(docker version --format '{{.Server.Version}}'))"; fi
  if ! grep -Eq '^[0-9a-f]{32}$' /etc/machine-id 2>/dev/null; then
    if command -v systemd-machine-id-setup >/dev/null; then as_root systemd-machine-id-setup >/dev/null 2>&1 || true
    else rand_hex 16 | as_root tee /etc/machine-id >/dev/null; fi
    grep -Eq '^[0-9a-f]{32}$' /etc/machine-id 2>/dev/null && okm "/etc/machine-id oluşturuldu"
  fi
}

# ---- 4a) Geliştirme kurulumu -----------------------------------------------------------------------------------------------
set_env_line() { # set_env_line dosya ANAHTAR değer (varsa değiştirir, yoksa ekler)
  local f="$1" k="$2" v="$3" tmp
  tmp="$(mktemp)"
  if grep -q "^${k}=" "$f" 2>/dev/null; then
    awk -v k="$k" -v v="$v" 'BEGIN{FS=OFS="="} $1==k {print k"="v; next} {print}' "$f" > "$tmp"
  else cat "$f" > "$tmp" 2>/dev/null || true; printf '%s=%s\n' "$k" "$v" >> "$tmp"; fi
  cat "$tmp" > "$f"; rm -f "$tmp"
}

install_dev() {
  stage "5/5 Geliştirme ortamı kurulumu"
  cd "$ROOT"
  if [[ ! -f .env ]]; then
    as_user cp .env.example .env
    as_user bash -c "$(declare -f set_env_line); set_env_line .env JWT_SECRET '$(rand_b64 48)'"
    okm ".env oluşturuldu (rastgele JWT_SECRET)"
  else okm ".env mevcut (dokunulmadı)"; fi

  if [[ "$PATH_CHOICE" == docker ]]; then
    info "PostgreSQL Docker'da başlatılıyor (docker compose up -d db)…"
    as_user docker compose up -d db >/dev/null
    local i
    for i in $(seq 1 60); do as_user docker compose exec -T db pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && break; sleep 1; done
    as_user docker compose exec -T db psql -U postgres -v ON_ERROR_STOP=1 -q -f - < infra/postgres/init.sql >/dev/null
    okm "Veritabanı hazır (Docker, port 5432)"
  else
    local port; port="$(pg_port)"
    as_postgres psql -p "$port" -v ON_ERROR_STOP=1 -q -f - < infra/postgres/init.sql >/dev/null
    if [[ "$port" != 5432 ]]; then
      as_user bash -c "$(declare -f set_env_line); set_env_line .env DATABASE_URL 'postgres://erp_app:erp_app@localhost:$port/erp_dev'; set_env_line .env MIGRATION_DATABASE_URL 'postgres://erp:erp@localhost:$port/erp_dev'"
    fi
    okm "Geliştirme rolleri ve veritabanları hazır (port $port)"
  fi

  info "Bağımlılıklar kuruluyor (npm)…"
  if [[ -d node_modules ]]; then as_user npm install --no-audit --no-fund --loglevel=error
  else as_user npm ci --no-audit --no-fund --loglevel=error; fi
  okm "npm bağımlılıkları hazır"
  as_user npm run --silent db:migrate
  okm "Veritabanı şeması güncel"
  if [[ "$DEMO" == yes ]]; then as_user npm run --silent db:seed && okm "Demo verisi yüklendi (giriş: demo@ornek.local / Demo-Sifre-123)"
  else okm "Demo verisi yüklenmedi: boş uygulama (ilk hesap tarayıcıda 'Kayıt ol' ile açılır)"; fi

  stage "Hazır"
  say "  Başlatmak için:   npm run dev"
  say "  Tarayıcı:         http://localhost:5173"
  say "  Testler:          npm test   (uçtan uca: npm run e2e)"
  if (( OPT_START )); then as_user npm run dev; fi
}

# ---- 4b) Müşteri kurulumu — Docker -------------------------------------------------------------------------------------
wait_ready() { # wait_ready url saniye
  local i
  for i in $(seq 1 "$2"); do curl -fsS --max-time 3 "$1" >/dev/null 2>&1 && return 0; sleep 1; done
  return 1
}

install_prod_docker() {
  stage "5/5 Sistem kurulumu (Docker)"
  cd "$ROOT"
  local envf=deploy/.env image build_flag=()
  WIZARD_TMP="$(mktemp)"
  if (( KIT )); then
    image="muhasebe-erp:$KIT_VERSION"
    if docker image inspect "$image" >/dev/null 2>&1; then okm "İmaj mevcut: $image"
    elif compgen -G "image/*.tar.gz" >/dev/null; then
      info "İmaj yükleniyor (docker load)…"; gunzip -c image/*.tar.gz | docker load >/dev/null; okm "İmaj yüklendi: $image"
    else
      info "İmaj kitteki derlenmiş dosyalardan oluşturuluyor (temel imaj node:$NODE_MAJOR indirilir)…"
      docker build -q -f installer/docker/Dockerfile.kit --build-arg "APP_VERSION=$KIT_VERSION" --build-arg NODE_MODULES=app/node_modules -t "$image" . >/dev/null
      okm "İmaj hazır: $image"
    fi
  else
    image="muhasebe-erp:local"; build_flag=(--build)
    info "Depodan kurulum: imaj kaynak koddan derlenecek (lisans anahtarı derlemeye gömülür; docs/LICENSING.md)"
  fi

  local fresh=0
  if [[ ! -f "$envf" ]]; then
    fresh=1
    {
      echo "# Kurulum sihirbazının ürettiği ayarlar ($(date -Iseconds)). Parolalar yalnızca burada durur: dosyayı YEDEKLEYİN."
      echo "POSTGRES_PASSWORD=$(rand_hex 24)"
      echo "ERP_OWNER_PASSWORD=$(rand_hex 24)"
      echo "ERP_APP_PASSWORD=$(rand_hex 24)"
      echo "JWT_SECRET=$(rand_b64 48)"
      echo "ERP_IMAGE=$image"
      echo "APP_VERSION=${KIT_VERSION:-dev}"
    } > "$WIZARD_TMP"
    build_env_changes docker
    env_apply "${CHG[@]}" < "$WIZARD_TMP" | install_file "$ROOT/$envf" 600
    rm -f "$WIZARD_TMP"
    okm "deploy/.env oluşturuldu (rastgele parolalar; chmod 600)"
    apply_tls_files
    DEMO_PENDING="$DEMO"; DEMO_SEEDED=no
    write_wizard_conf
  else
    set_env_line "$envf" ERP_IMAGE "$image"
    [[ -n "$KIT_VERSION" ]] && set_env_line "$envf" APP_VERSION "$KIT_VERSION"
    okm "deploy/.env mevcut: parolalar ve ayarlar korundu, imaj $image olarak güncellendi"
    DEMO_PENDING="${CUR[DEMO_PENDING]:-no}"; DEMO_SEEDED="${CUR[DEMO_SEEDED]:-no}"; DEMO="${CUR[DEMO]:-no}"
  fi

  (( KIT )) && install_updater docker "$ROOT/$envf"
  [[ -n "$RESTORE_DB" ]] && restore_db_docker "$RESTORE_DB"
  local profile=()
  local construction_files
  construction_files="$(sed -n 's/^CONSTRUCTION_FILES_DIR=//p' "$envf")"
  construction_files="${construction_files:-construction-data}"
  [[ "$construction_files" = /* ]] || construction_files="$ROOT/deploy/$construction_files"
  as_root mkdir -p "$construction_files"
  # API imajındaki node kullanıcısının UID/GID'si; yeni dosyalar özel kalır.
  as_root chown 1000:1000 "$construction_files"
  as_root chmod 700 "$construction_files"
  grep -q '^ERP_DOMAIN=.\+' "$envf" && profile=(--profile tls)
  info "Hizmetler başlatılıyor (docker compose up -d)…"
  docker compose -f deploy/docker-compose.prod.yml --env-file "$envf" "${profile[@]}" up -d "${build_flag[@]}"
  local port; port="$(sed -n 's/^APP_PORT=//p' "$envf")"; port="${port:-3000}"
  wait_ready "http://127.0.0.1:$port/api/health/ready" 180 || die "Uygulama hazır olmadı: docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env logs app"
  okm "Uygulama çalışıyor"
  if [[ "$DEMO_PENDING" == yes ]]; then
    info "Demo verisi yükleniyor…"
    seed_demo_docker >/dev/null && { SEEDED_DEMO=1; DEMO_PENDING=no; DEMO_SEEDED=yes; okm "Demo verisi yüklendi"; write_wizard_conf; } || warn "Demo verisi yüklenemedi (docker compose … exec app node dist/demo.js seed; ALLOW_DEMO=true gerekir)"
  elif (( fresh )); then okm "Boş uygulama: demo/örnek veri yüklenmedi"; fi
  install_backup_docker   # her kurulumda yeniden yazılır (kurulum klasörü değiştiyse birim de yeni yolu gösterir)
  post_install_checks "http://127.0.0.1:$port"
  finish_prod "$port"
}

# ---- 4c) Müşteri kurulumu — yerel (Docker'sız) -------------------------------------------------------------------------
NODE_BIN="$PREFIX/current/app/runtime/node"
write_unit() {
  as_root tee "/etc/systemd/system/$SVC_NAME.service" >/dev/null <<UNIT
[Unit]
Description=Muhasebe ERP
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_USER
WorkingDirectory=$PREFIX/current/app
ExecStart=$NODE_BIN --env-file=$ETC/erp.env $PREFIX/current/app/dist/server.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$VARDIR

[Install]
WantedBy=multi-user.target
UNIT
  as_root systemctl daemon-reload
}

write_erpctl() {
  as_root mkdir -p "$PREFIX/bin" "$VARDIR/logs"
  as_root chown "$SVC_USER:$SVC_USER" "$VARDIR/logs"
  as_root tee "$PREFIX/bin/erpctl" >/dev/null <<'CTL'
#!/usr/bin/env bash
# Muhasebe ERP hizmet denetimi (systemd'siz sistemler için): erpctl start|stop|restart|status|logs
set -euo pipefail
PREFIX=/opt/muhasebe-erp; ETC=/etc/muhasebe-erp; VARDIR=/var/lib/muhasebe-erp; PIDF=$VARDIR/app.pid
if command -v systemctl >/dev/null && [[ "$(cat /proc/1/comm 2>/dev/null)" == systemd ]]; then
  case "${1:-status}" in logs) exec journalctl -u muhasebe-erp -n 200 -f ;; *) exec systemctl "${1:-status}" muhasebe-erp ;; esac
fi
running() { [[ -f $PIDF ]] && kill -0 "$(cat $PIDF)" 2>/dev/null; }
start() {
  running && { echo "Zaten çalışıyor (pid $(cat $PIDF))"; return; }
  cd "$PREFIX/current/app"
  setsid runuser -u muhasebe-erp -- "$PREFIX/current/app/runtime/node" --env-file="$ETC/erp.env" "$PREFIX/current/app/dist/server.js" \
    >> "$VARDIR/logs/app.log" 2>&1 < /dev/null &
  echo $! > "$PIDF"; echo "Başlatıldı (pid $!; günlük: $VARDIR/logs/app.log)"
}
stop() {
  running || { echo "Çalışmıyor"; rm -f "$PIDF"; return; }
  local pid; pid="$(cat $PIDF)"; kill "$pid"
  for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  kill -0 "$pid" 2>/dev/null && kill -9 "$pid" || true
  rm -f "$PIDF"; echo "Durduruldu"
}
case "${1:-status}" in
  start) start ;; stop) stop ;; restart) stop; start ;;
  status) if running; then echo "Çalışıyor (pid $(cat $PIDF))"; else echo "Çalışmıyor"; exit 3; fi ;;
  logs) exec tail -n 200 -f "$VARDIR/logs/app.log" ;;
  *) echo "Kullanım: erpctl start|stop|restart|status|logs"; exit 2 ;;
esac
CTL
  as_root chmod 755 "$PREFIX/bin/erpctl"
  as_root ln -sf "$PREFIX/bin/erpctl" /usr/local/bin/erpctl
}

write_backup_tool() {
  local dir="${BACKUP_DIR:-$NATIVE_BACKUP_DIR}" keep="${BACKUP_KEEP:-14}" at="${BACKUP_TIME:-02:30}"
  (( 10#$keep >= 1 )) || keep=1
  case "$dir/" in "$VARDIR"/*) warn "Yedek klasörü ($dir) hizmet kullanıcısının yazabildiği $VARDIR altında: yönetici işleri için güvenli değil; $NATIVE_BACKUP_DIR önerilir." ;; esac
  as_root mkdir -p "$dir"
  as_root chown root:root "$dir"
  as_root chmod 700 "$dir"
  # Yollar %q ile tırnaklanır (boşluk/özel karakter); parola komut satırına yazılmaz (PG* ortam değişkenleri, yalnızca root okur)
  as_root tee "$PREFIX/bin/erp-backup" >/dev/null <<BK
#!/usr/bin/env bash
# Muhasebe ERP yedeği (pg_dump, sıkıştırılmış özel biçim). Son $keep yedek tutulur. Ayar: sudo erp-setup --reconfigure. Geri yükleme: docs/OPERATIONS.md §6
set -euo pipefail
DIR=$(printf '%q' "$dir")
KEEP=$keep
set -a; . $(printf '%q' "$ETC/migrate.env"); set +a
umask 077
# postgres://kullanıcı:parola@sunucu:port/veritabanı → libpq ortam değişkenleri (parola komut satırında/ps çıktısında görünmez)
re='^postgres(ql)?://([^:@/]+):([^@]*)@([^:/]+):([0-9]+)/([^?]+)'
[[ "\$MIGRATION_DATABASE_URL" =~ \$re ]] || { echo "MIGRATION_DATABASE_URL okunamadı" >&2; exit 1; }
dec() { printf '%b' "\${1//%/\\\\x}"; }
PGUSER="\$(dec "\${BASH_REMATCH[2]}")"; PGPASSWORD="\$(dec "\${BASH_REMATCH[3]}")"
PGHOST="\${BASH_REMATCH[4]}"; PGPORT="\${BASH_REMATCH[5]}"; PGDATABASE="\${BASH_REMATCH[6]}"
export PGUSER PGPASSWORD PGHOST PGPORT PGDATABASE
mkdir -p "\$DIR"
out="\$DIR/erp-\$(date +%Y%m%d-%H%M%S).dump"
trap 'rm -f "\$out.partial"' EXIT
/usr/lib/postgresql/$PG_MAJOR/bin/pg_dump -Fc -f "\$out.partial"
FILES_DIR="\$(sed -n 's/^CONSTRUCTION_STORAGE_DIR=//p' $(printf '%q' "$ETC/erp.env"))"
$(printf '%q' "$PREFIX/current/app/runtime/node") $(printf '%q' "$PREFIX/current/app/dist/construction-files.mjs") --mode=backup --root="\${FILES_DIR:-$VARDIR/construction}" --archive="\$out.files.gz"
mv -f "\$out.partial" "\$out"
chmod 600 "\$out"
# Temizlik: yalnızca bu betiğin adlandırdığı dosyalar (erp-YYYYMMDD-HHMMSS.dump); en az 1 (yeni alınan) kalır
find "\$DIR" -maxdepth 1 -type f -regextype posix-extended -regex '.*/erp-[0-9]{8}-[0-9]{6}\.dump' -printf '%f\n' | sort -r | tail -n +\$((KEEP + 1)) \\
  | while IFS= read -r old; do rm -f -- "\$DIR/\$old" "\$DIR/\$old.files.gz" "\$DIR/\$old.files.gz.sha256"; done
echo "Yedek: \$out"
BK
  as_root chmod 700 "$PREFIX/bin/erp-backup"
  if (( HAS_SYSTEMD )); then
    printf '[Unit]\nDescription=Muhasebe ERP günlük yedek\n[Service]\nType=oneshot\nExecStart=%s\n' "$(sd_quote "$PREFIX/bin/erp-backup")" \
      | as_root tee "/etc/systemd/system/$SVC_NAME-backup.service" >/dev/null
    printf '[Unit]\nDescription=Muhasebe ERP günlük yedek (%s)\n[Timer]\nOnCalendar=%s\nPersistent=true\n[Install]\nWantedBy=timers.target\n' "$at" "$(time_to_oncalendar "$at")" \
      | as_root tee "/etc/systemd/system/$SVC_NAME-backup.timer" >/dev/null
    as_root systemctl daemon-reload
    as_root systemctl enable --now "$SVC_NAME-backup.timer" >/dev/null 2>&1 || true
    as_root systemctl restart "$SVC_NAME-backup.timer" >/dev/null 2>&1 || true
    okm "Günlük yedek: systemd zamanlayıcısı $at → $dir (son $keep). Elle: sudo $PREFIX/bin/erp-backup"
  elif can_root && [[ -d /etc/cron.d ]]; then
    printf '# Muhasebe ERP günlük yedek (kurulum sihirbazı)\n%s * * * root %s >> /var/log/muhasebe-erp-backup.log 2>&1\n' "$(time_to_cron "$at")" "$(cron_quote "$PREFIX/bin/erp-backup")" \
      | as_root tee "/etc/cron.d/$SVC_NAME-backup" >/dev/null
    okm "Günlük yedek: cron $at → $dir (son $keep). Elle: sudo $PREFIX/bin/erp-backup"
  else
    warn "Otomatik yedek yok (systemd/cron yok): sudo $PREFIX/bin/erp-backup komutunu düzenli çalıştırın"
  fi
}

offer_wsl_systemd() {
  (( IS_WSL && ! HAS_SYSTEMD )) || return 0
  if confirm "WSL'de systemd açılsın mı? (uygulama Windows açıldığında kendiliğinden başlar; sonra PowerShell'de 'wsl --shutdown' gerekir)"; then
    if [[ -f /etc/wsl.conf ]] && grep -q '^\[boot\]' /etc/wsl.conf; then
      grep -q '^systemd=' /etc/wsl.conf && as_root sed -i 's/^systemd=.*/systemd=true/' /etc/wsl.conf \
        || as_root sed -i '/^\[boot\]/a systemd=true' /etc/wsl.conf
    else printf '[boot]\nsystemd=true\n' | as_root tee -a /etc/wsl.conf >/dev/null; fi
    warn "systemd açıldı. Windows'ta PowerShell: 'wsl --shutdown', sonra WSL'i açıp sihirbazı yeniden çalıştırın (hizmet kaydedilir)."
  fi
}

install_prod_native() {
  stage "5/5 Sistem kurulumu (yerel)"
  [[ -x "$ROOT/app/runtime/node" ]] || die "Kitte çalışma zamanı yok (app/runtime/node); kit bozuk olabilir"
  local ver="$KIT_VERSION" pgp; pgp="$(pg_port)"

  id -u "$SVC_USER" >/dev/null 2>&1 || as_root useradd --system --home-dir "$VARDIR" --shell /usr/sbin/nologin "$SVC_USER"
  as_root mkdir -p "$PREFIX/versions" "$ETC" "$VARDIR"
  as_root chown "$SVC_USER:$SVC_USER" "$VARDIR"; as_root chmod 750 "$VARDIR"

  # Çalışan sürüm durdurulur (aynı sürüm klasörü yeniden yazılabilir; migration eski kod çalışırken uygulanmaz)
  local prev=""; [[ -L "$PREFIX/current" ]] && prev="$(readlink "$PREFIX/current")"
  if (( HAS_SYSTEMD )); then as_root systemctl stop "$SVC_NAME" 2>/dev/null || true
  elif [[ -x "$PREFIX/bin/erpctl" ]]; then as_root "$PREFIX/bin/erpctl" stop >/dev/null 2>&1 || true; fi
  [[ "$prev" == "versions/$ver" ]] && prev=""

  if [[ "$ROOT" -ef "$PREFIX/versions/$ver" ]]; then
    okm "Sürüm $ver zaten yerinde ($PREFIX/versions/$ver)"
  else
  info "Sürüm $ver kopyalanıyor → $PREFIX/versions/$ver"
  as_root rm -rf "$PREFIX/versions/$ver.tmp"
  as_root mkdir -p "$PREFIX/versions/$ver.tmp"
  as_root cp -a "$ROOT/app" "$ROOT/kit.json" "$PREFIX/versions/$ver.tmp/"
  as_root cp -a "$ROOT/installer" "$PREFIX/versions/$ver.tmp/"
  as_root rm -rf "$PREFIX/versions/$ver"
  as_root mv "$PREFIX/versions/$ver.tmp" "$PREFIX/versions/$ver"
  as_root chown -R root:root "$PREFIX/versions/$ver"
  fi

  local owner_pw app_pw jwt fresh=0
  WIZARD_TMP="$(mktemp)"
  if as_root test -f "$ETC/erp.env" && as_root test -f "$ETC/migrate.env"; then
    okm "Mevcut ayarlar korunuyor ($ETC)"
    DEMO_PENDING="${CUR[DEMO_PENDING]:-no}"; DEMO_SEEDED="${CUR[DEMO_SEEDED]:-no}"; DEMO="${CUR[DEMO]:-no}"
  else
    fresh=1
    owner_pw="$(rand_hex 24)"; app_pw="$(rand_hex 24)"; jwt="$(rand_b64 48)"
    ROLES_CREATED=yes; DB_CREATED=yes
    if as_postgres psql -p "$pgp" -tAc "select 1 from pg_roles where rolname='erp'" 2>/dev/null | grep -q 1; then
      warn "PostgreSQL'de 'erp' rolleri zaten var: parolaları yeni üretilenlerle değiştirilecek (aynı sunucudaki eski bir kurulum etkilenir)."
      confirm "Devam edilsin mi?" || die "Kurulum durduruldu"
      ROLES_CREATED=no
    fi
    if as_postgres psql -p "$pgp" -tAc "select 1 from pg_database where datname='$DB_NAME'" 2>/dev/null | grep -q 1; then
      warn "PostgreSQL'de '$DB_NAME' veritabanı zaten var: kullanılacak, kaldırmada (--purge) SİLİNMEZ."
      DB_CREATED=no
    fi
    # Parolalar psql'e komut satırıyla değil standart girdiyle (\set) verilir: ps çıktısında görünmez
    { printf '\\set owner_pw %s\n\\set app_pw %s\n' "$owner_pw" "$app_pw"; cat "$INSTALLER/sql/bootstrap-prod.sql"; } \
      | as_postgres psql -p "$pgp" -v ON_ERROR_STOP=1 -q -v dbname="$DB_NAME" -f - >/dev/null
    okm "Veritabanı '$DB_NAME' ve roller hazır"
    umask 077
    {
      echo "# Muhasebe ERP çalışma zamanı ayarları (kurulum: $(date -Iseconds)). Gizli: yalnızca root ve $SVC_USER okur. YEDEKLEYİN."
      echo "NODE_ENV=production"
      echo "DATABASE_URL=postgres://erp_app:$app_pw@127.0.0.1:$pgp/$DB_NAME"
      echo "JWT_SECRET=$jwt"
      echo "WEB_DIST_DIR=$PREFIX/current/app/web"
      echo "CONSTRUCTION_STORAGE_DIR=$VARDIR/construction"
      echo "LICENSE_HOST_ID_FILE=/etc/machine-id"
      echo "APP_VERSION=$ver"
    } > "$WIZARD_TMP"
    build_env_changes native
    env_apply "${CHG[@]}" < "$WIZARD_TMP" | install_file "$ETC/erp.env" 640 "root:$SVC_USER"
    rm -f "$WIZARD_TMP"
    as_root tee "$ETC/migrate.env" >/dev/null <<EOF
# Şema sahibi bağlantısı: yalnızca migration ve yedek kullanır (uygulama hizmeti okumaz).
MIGRATION_DATABASE_URL=postgres://erp:$owner_pw@127.0.0.1:$pgp/$DB_NAME
EOF
    as_root chown root:root "$ETC/migrate.env"; as_root chmod 600 "$ETC/migrate.env"
    okm "Ayarlar yazıldı ($ETC/erp.env, $ETC/migrate.env)"
    DEMO_PENDING="$DEMO"; DEMO_SEEDED=no
    write_wizard_conf
  fi
  rm -f "$WIZARD_TMP"
  as_root sed -i "s/^APP_VERSION=.*/APP_VERSION=$ver/" "$ETC/erp.env"
  ensure_env_secret "$ETC/erp.env" CONSTRUCTION_STORAGE_DIR "$VARDIR/construction"
  as_root mkdir -p "$VARDIR/construction"
  as_root chown "$SVC_USER:$SVC_USER" "$VARDIR/construction"
  as_root chmod 700 "$VARDIR/construction"
  [[ -n "$RESTORE_DB" ]] && restore_db_native "$RESTORE_DB"

  # current'ı yeni sürüme çevir → migration → başlat
  as_root ln -sfn "versions/$ver" "$PREFIX/current"
  info "Veritabanı şeması kuruluyor/yükseltiliyor…"
  if ! as_root "$PREFIX/current/app/runtime/node" --env-file="$ETC/migrate.env" "$PREFIX/current/app/dist/migrate.js"; then
    [[ -n "$prev" ]] && as_root ln -sfn "$prev" "$PREFIX/current"
    die "Migration başarısız; önceki sürüm geri alındı (veritabanı değişmediyse). Ayrıntı yukarıda."
  fi

  write_erpctl
  if [[ "$BACKUP_DIR" == "$VARDIR/backups" ]]; then migrate_native_backup_dir; write_wizard_conf; fi
  write_backup_tool
  install_updater native "$ETC/erp.env"
  if (( HAS_SYSTEMD )); then
    write_unit
    as_root systemctl enable --now "$SVC_NAME" >/dev/null
    okm "systemd hizmeti etkin: $SVC_NAME (erpctl status|logs)"
  else
    as_root "$PREFIX/bin/erpctl" start >/dev/null
    okm "Uygulama erpctl ile başlatıldı (açılışta kendiliğinden başlamaz)"
    offer_wsl_systemd
  fi
  wait_ready "http://127.0.0.1:$PORT/api/health/ready" 90 || die "Uygulama hazır olmadı: erpctl logs"
  okm "Uygulama çalışıyor"
  if [[ "$ACCESS" == lan ]] && command -v ufw >/dev/null && as_root ufw status 2>/dev/null | grep -q 'Status: active'; then
    confirm "Güvenlik duvarında $PORT/tcp açılsın mı (ufw)?" && as_root ufw allow "$PORT/tcp" >/dev/null && okm "ufw: $PORT/tcp açıldı"
  fi
  if [[ "$DEMO_PENDING" == yes ]]; then
    info "Demo verisi yükleniyor…"
    if seed_demo_native >/dev/null; then SEEDED_DEMO=1; DEMO_PENDING=no; DEMO_SEEDED=yes; okm "Demo verisi yüklendi"; write_wizard_conf
    else warn "Demo verisi yüklenemedi ($PREFIX/current/app/runtime/node dist/demo.js seed; ALLOW_DEMO=true gerekir)"; fi
  elif (( fresh )); then okm "Boş uygulama: demo/örnek veri yüklenmedi"; fi
  write_setup_wrapper
  post_install_checks "http://127.0.0.1:$PORT"
  finish_prod "$PORT"
}

write_setup_wrapper() { # kurulu kopyadan yeniden yapılandırma: sudo erp-setup --reconfigure
  printf '#!/usr/bin/env bash\n# Muhasebe ERP kurulum sihirbazı (kurulu sürüm): sudo erp-setup --reconfigure | --help\nexec bash "%s/current/installer/install.sh" "$@"\n' "$PREFIX" | as_root tee /usr/local/bin/erp-setup >/dev/null
  as_root chmod 755 /usr/local/bin/erp-setup
}

post_install_checks() { # post_install_checks ADRES — lisans kapısı, (varsa) etkinleştirme, ertelenmiş e-posta denemesi
  verify_license_gate "$1"
  [[ -n "$LICENSE_CODE" ]] && activate_license "$1"
  if (( MAIL_TEST_DEFERRED )) && [[ -n "$MAIL_TEST_TO" ]]; then mail_test_container "$MAIL_TEST_TO" || warn "Test e-postası gönderilemedi (yukarıya bakın)"; fi
  return 0
}

install_backup_docker() { # Docker yolunda günlük yedek: scripts/backup.sh --compose (systemd zamanlayıcısı ya da cron)
  [[ "$PATH_CHOICE" == docker && -n "$BACKUP_DIR" ]] || return 0
  local keep="${BACKUP_KEEP:-14}" at="${BACKUP_TIME:-02:30}"
  (( 10#$keep >= 1 )) || keep=1
  # Kurulum klasörü sabittir (uzaktan güncelleme dosyaları yerinde değiştirir); yollar boşluk/özel karakter içerebilir: tırnaklanır
  local script="$ROOT/scripts/backup.sh"
  if (( HAS_SYSTEMD )) && can_root; then
    printf '[Unit]\nDescription=Muhasebe ERP günlük yedek\n[Service]\nType=oneshot\nWorkingDirectory=%s\nExecStart=/usr/bin/env bash %s --compose --dir %s --keep-count %s\n' \
      "$(sd_path "$ROOT")" "$(sd_quote "$script")" "$(sd_quote "$BACKUP_DIR")" "$keep" | as_root tee "/etc/systemd/system/$SVC_NAME-backup.service" >/dev/null
    printf '[Unit]\nDescription=Muhasebe ERP günlük yedek (%s)\n[Timer]\nOnCalendar=%s\nPersistent=true\n[Install]\nWantedBy=timers.target\n' "$at" "$(time_to_oncalendar "$at")" \
      | as_root tee "/etc/systemd/system/$SVC_NAME-backup.timer" >/dev/null
    as_root systemctl daemon-reload
    as_root systemctl enable --now "$SVC_NAME-backup.timer" >/dev/null 2>&1 || true
    as_root systemctl restart "$SVC_NAME-backup.timer" >/dev/null 2>&1 || true
    okm "Günlük yedek: systemd zamanlayıcısı $at → $BACKUP_DIR (son $keep)"
  elif can_root && [[ -d /etc/cron.d ]]; then
    printf '# Muhasebe ERP günlük yedek (kurulum sihirbazı)\n%s * * * root cd %s && /usr/bin/env bash %s --compose --dir %s --keep-count %s >> /var/log/muhasebe-erp-backup.log 2>&1\n' \
      "$(time_to_cron "$at")" "$(cron_quote "$ROOT")" "$(cron_quote "$script")" "$(cron_quote "$BACKUP_DIR")" "$keep" | as_root tee "/etc/cron.d/$SVC_NAME-backup" >/dev/null
    okm "Günlük yedek: cron $at → $BACKUP_DIR (son $keep)"
  else
    warn "Otomatik yedek kurulamadı. Elle (her gün $at): cd $(printf '%q' "$ROOT") && bash scripts/backup.sh --compose --dir $(printf '%q' "$BACKUP_DIR") --keep-count $keep"
  fi
}

# ---- Ayar/yedek birimlerinin anlık görüntüsü (yeniden yapılandırma başarısızsa geri alınır) ------------------------------
BACKUP_UNIT_FILES=()
snapshot_backup_units() {
  local f
  BACKUP_UNIT_FILES=("/etc/systemd/system/$SVC_NAME-backup.service" "/etc/systemd/system/$SVC_NAME-backup.timer" "/etc/cron.d/$SVC_NAME-backup")
  [[ "$PATH_CHOICE" == native ]] && BACKUP_UNIT_FILES+=("$PREFIX/bin/erp-backup")
  for f in "${BACKUP_UNIT_FILES[@]}"; do
    if fexists "$f"; then as_root cp -p "$f" "$f.wizard-$WIZARD_TS"; fi
  done
}
restore_backup_units() {
  local f
  for f in "${BACKUP_UNIT_FILES[@]}"; do
    if fexists "$f.wizard-$WIZARD_TS"; then as_root mv -f "$f.wizard-$WIZARD_TS" "$f"
    else as_root rm -f "$f"; fi
  done
  if (( HAS_SYSTEMD )) && can_root; then
    as_root systemctl daemon-reload >/dev/null 2>&1 || true
    if fexists "/etc/systemd/system/$SVC_NAME-backup.timer"; then as_root systemctl restart "$SVC_NAME-backup.timer" >/dev/null 2>&1 || true
    else as_root systemctl disable --now "$SVC_NAME-backup.timer" >/dev/null 2>&1 || true; fi
  fi
}
drop_backup_unit_snapshots() { local f; for f in "${BACKUP_UNIT_FILES[@]}"; do as_root rm -f "$f.wizard-$WIZARD_TS" 2>/dev/null || true; done; }

# ---- Uzaktan güncelleme: güncelleyici (her dakika; yönetici yetkisiyle) -------------------------------------------------
ensure_env_secret() { # ensure_env_secret dosya ANAHTAR değer — yoksa ekler (varsa dokunmaz)
  local f="$1" k="$2" v="$3"
  if ! as_root grep -q "^${k}=" "$f" 2>/dev/null; then printf '%s=%s\n' "$k" "$v" | as_root tee -a "$f" >/dev/null; fi
}

# Eski kurulumlar güncelleyici çalışma klasörünü hizmet kullanıcısının $VARDIR'ı altında tutuyordu (root yetkisi alınabilirdi):
# yeni yer $UPD_WORK (root 700); güncelleyici artık eski klasöre dokunmaz. Eski klasör temizlenir (rm sembolik bağ izlemez):
# yerel kurulumda tamamen; Docker kurulumunda yalnızca indirmeler ve kilit (eski güncelleyicinin açtığı kit klasörü canlı kurulum
# ya da güncelleme öncesi dökümler içerebilir: korunur). Sihirbaz o klasörün içinden çalışıyorsa dokunulmaz.
migrate_updater_workdir() { # migrate_updater_workdir native|docker
  local old="$VARDIR/updater"
  as_root mkdir -p "$UPD_WORK"; as_root chown root:root "$UPD_WORK"; as_root chmod 700 "$UPD_WORK"
  fexists "$old" || return 0
  case "$ROOT/" in "$old"/*) info "Eski güncelleyici klasörü ($old) şimdilik korunuyor: sihirbaz oradan çalışıyor; sonraki kurulum/yeniden yapılandırmada temizlenir." ; return 0 ;; esac
  if as_root test -f "$old/updater.log" && ! as_root test -L "$old" && ! as_root test -L "$old/updater.log"; then
    as_root cp "$old/updater.log" "$UPD_WORK/updater-eski.log" 2>/dev/null || true
  fi
  if [[ "$1" == native ]]; then as_root rm -rf -- "$old"
  else as_root rm -rf -- "$old/downloads" "$old/updater.lock" "$old/updater.log" "$old/updater.log.1"; fi
  info "Güncelleyici çalışma klasörü taşındı: $old → $UPD_WORK"
}

install_updater() { # install_updater mod ortam-dosyası
  local mode="$1" envf="$2" node_src="$ROOT/app/runtime/node"
  [[ -x "$node_src" && -f "$ROOT/app/dist/updater.js" ]] || { warn "Kitte güncelleyici yok; uzaktan güncelleme kapalı"; return 0; }
  ensure_env_secret "$envf" ERP_UPDATER_TOKEN "$(rand_hex 32)"
  ensure_env_secret "$envf" ERP_KIT_TARGET linux-x64
  as_root mkdir -p "$UPD_DIR" "$ETC"
  migrate_updater_workdir "$mode"
  # Çalışan güncelleyicinin dosyaları yeniden adlandırmayla değiştirilir (çalışan ikilinin üzerine yazılamaz)
  as_root cp "$node_src" "$UPD_DIR/node.new" && as_root mv -f "$UPD_DIR/node.new" "$UPD_DIR/node"
  as_root cp "$ROOT/app/dist/updater.js" "$UPD_DIR/updater.js.new" && as_root mv -f "$UPD_DIR/updater.js.new" "$UPD_DIR/updater.js"
  # JSON, kitteki Node ile üretilir (yollardaki tırnak/ters bölü/boşluk JSON'u bozmasın)
  local https_port="" https_host=""
  if [[ "$mode" == docker && "${TLS_MODE:-none}" != none && -n "$DOMAIN" ]]; then https_port="${HTTPS_PORT:-443}"; https_host="$DOMAIN"; fi
  U_MODE="$mode" U_PORT="$PORT" U_ACCESS="$ACCESS" U_DOMAIN="$DOMAIN" U_ENVF="$envf" U_WORK="$UPD_WORK" U_ROOT="$ROOT" U_DB="$DB_NAME" \
    U_PREFIX="$PREFIX" U_HTTPS_PORT="$https_port" U_HTTPS_HOST="$https_host" "$node_src" -e '
      const e = process.env;
      const c = { mode: e.U_MODE, platform: "linux-x64", appUrl: `http://127.0.0.1:${e.U_PORT}`, envFile: e.U_ENVF, workDir: e.U_WORK,
        installArgs: [`--port=${e.U_PORT}`, `--access=${e.U_ACCESS}`, ...(e.U_DOMAIN ? [`--domain=${e.U_DOMAIN}`] : [])] };
      if (e.U_MODE === "docker") Object.assign(c, { dockerDir: e.U_ROOT, dbName: e.U_DB });
      else Object.assign(c, { nativePrefix: e.U_PREFIX, backupCommand: [`${e.U_PREFIX}/bin/erp-backup`] });
      if (e.U_HTTPS_PORT) c.httpsCheck = { port: Number(e.U_HTTPS_PORT), host: e.U_HTTPS_HOST };
      process.stdout.write(JSON.stringify(c, null, 2) + "\n");' | as_root tee "$ETC/updater.json" >/dev/null
  as_root chmod 600 "$ETC/updater.json"
  printf '#!/usr/bin/env bash\n# Muhasebe ERP güncelleyicisini şimdi çalıştırır (sahibin onayladığı güncelleme varsa uygular). Günlük: %s/updater.log\nexec "%s/node" "%s/updater.js" --config="%s/updater.json"\n' \
    "$UPD_WORK" "$UPD_DIR" "$UPD_DIR" "$ETC" | as_root tee /usr/local/bin/erp-update >/dev/null
  as_root chmod 755 /usr/local/bin/erp-update
  if (( HAS_SYSTEMD )); then
    printf '[Unit]\nDescription=Muhasebe ERP uzaktan güncelleme denetimi\nAfter=network-online.target\n\n[Service]\nType=oneshot\nExecStart=%s/node %s/updater.js --config=%s/updater.json\nTimeoutStartSec=6h\n' \
      "$UPD_DIR" "$UPD_DIR" "$ETC" | as_root tee "/etc/systemd/system/$SVC_NAME-updater.service" >/dev/null
    printf '[Unit]\nDescription=Muhasebe ERP uzaktan güncelleme denetimi (dakikada bir)\n\n[Timer]\nOnBootSec=2min\nOnUnitActiveSec=60s\nAccuracySec=10s\n\n[Install]\nWantedBy=timers.target\n' \
      | as_root tee "/etc/systemd/system/$SVC_NAME-updater.timer" >/dev/null
    as_root systemctl daemon-reload
    as_root systemctl enable --now "$SVC_NAME-updater.timer" >/dev/null 2>&1 || true
    okm "Uzaktan güncelleme hazır: sahip onaylayınca uygulanır (günlük: $UPD_WORK/updater.log)"
  else
    warn "systemd yok: onaylanan uzaktan güncellemeler kendiliğinden uygulanmaz; 'sudo erp-update' ile çalıştırın (ya da cron'a dakikalık ekleyin)"
  fi
}

# Parola komut satırına (ps) yazılmadan libpq bağlantısı: root'a ait geçici .pgpass dosyası + PG* değişkenleri
# with_pg_url URL komut… — komut as_root ile, PGPASSFILE/PGHOST/PGPORT/PGUSER/PGDATABASE ortamıyla çalışır
with_pg_url() {
  local url="$1" pass rc=0 f; shift
  local re='^postgres(ql)?://([^:@/]+):([^@]*)@([^:/]+):([0-9]+)/([^?]+)'
  [[ "$url" =~ $re ]] || die "Veritabanı adresi okunamadı"
  local u h p d
  u="$(urldec "${BASH_REMATCH[2]}")"; pass="$(urldec "${BASH_REMATCH[3]}")"; h="${BASH_REMATCH[4]}"; p="${BASH_REMATCH[5]}"; d="${BASH_REMATCH[6]}"
  f="$(as_root mktemp)"
  # .pgpass alanlarında : ve \ kaçışlanır
  printf '%s:%s:%s:%s:%s\n' "$h" "$p" "$d" "$u" "$(printf '%s' "$pass" | sed 's/[\\:]/\\&/g')" | as_root tee "$f" >/dev/null
  as_root chmod 600 "$f"
  as_root env PGPASSFILE="$f" PGHOST="$h" PGPORT="$p" PGUSER="$u" PGDATABASE="$d" "$@" || rc=$?
  as_root rm -f "$f"
  return "$rc"
}

restore_db_native() { # yedekten geri yükleme (güncelleyicinin geri dönüşü): veritabanı silinip yeniden oluşturulur
  local file="$1" pgp url
  [[ -f "$file" ]] || die "Yedek dosyası yok: $file"
  pgp="$(pg_port)"
  url="$(as_root sed -n 's/^MIGRATION_DATABASE_URL=//p' "$ETC/migrate.env")"
  [[ -n "$url" ]] || die "$ETC/migrate.env okunamadı"
  info "Veritabanı yedekten geri yükleniyor: $file"
  as_postgres psql -p "$pgp" -v ON_ERROR_STOP=1 -q -c "drop database if exists $DB_NAME with (force)" -c "create database $DB_NAME owner erp" \
    -c "revoke all on database $DB_NAME from public" -c "grant connect on database $DB_NAME to erp_app" >/dev/null
  with_pg_url "$url" "/usr/lib/postgresql/$PG_MAJOR/bin/pg_restore" --exit-on-error --single-transaction --no-owner --role=erp -d "$DB_NAME" "$file" \
    || die "Geri yükleme başarısız ($file)"
  if [[ -f "$file.files.gz" ]]; then
    local files_dir
    files_dir="$(as_root sed -n 's/^CONSTRUCTION_STORAGE_DIR=//p' "$ETC/erp.env")"
    as_root "$ROOT/app/runtime/node" "$ROOT/installer/tools/construction-files.mjs" --mode=restore --root="${files_dir:-$VARDIR/construction}" --archive="$file.files.gz"
    as_root chown -R "$SVC_USER:$SVC_USER" "${files_dir:-$VARDIR/construction}"
  else warn "Eski yedekte çizim/model arşivi yok; dosya deposu ayrıca geri yüklenmeli."; fi
  okm "Veritabanı geri yüklendi"
}

restore_db_docker() {
  local file="$1" dc=(docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env) i
  [[ -f "$file" ]] || die "Yedek dosyası yok: $file"
  info "Veritabanı yedekten geri yükleniyor (Docker): $file"
  "${dc[@]}" stop app >/dev/null 2>&1 || true
  "${dc[@]}" up -d db >/dev/null
  for i in $(seq 1 60); do "${dc[@]}" exec -T db pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && break; sleep 1; done
  "${dc[@]}" exec -T db psql -U postgres -v ON_ERROR_STOP=1 -q -c "drop database if exists $DB_NAME with (force)" -c "create database $DB_NAME owner erp" \
    -c "revoke all on database $DB_NAME from public" -c "grant connect on database $DB_NAME to erp_app" >/dev/null
  "${dc[@]}" exec -T db pg_restore -U postgres --exit-on-error --single-transaction --no-owner --role=erp -d "$DB_NAME" < "$file"
  if [[ -f "$file.files.gz" ]]; then
    local files_dir files_node
    files_dir="$(sed -n 's/^CONSTRUCTION_FILES_DIR=//p' "$ROOT/deploy/.env")"; files_dir="${files_dir:-construction-data}"
    [[ "$files_dir" = /* ]] || files_dir="$ROOT/deploy/$files_dir"
    files_node="$ROOT/app/runtime/node"; [[ -x "$files_node" ]] || files_node=node
    "$files_node" "$ROOT/installer/tools/construction-files.mjs" --mode=restore --root="$files_dir" --archive="$file.files.gz"
  else warn "Eski yedekte çizim/model arşivi yok; dosya deposu ayrıca geri yüklenmeli."; fi
  okm "Veritabanı geri yüklendi"
}

# ---- Yerel yolda yedek klasörünün taşınması (eski varsayılan $VARDIR/backups → root'a ait $NATIVE_BACKUP_DIR) ---------------
migrate_native_backup_dir() {
  [[ "$PATH_CHOICE" == native && "$BACKUP_DIR" == "$VARDIR/backups" ]] || return 0
  BACKUP_DIR="$NATIVE_BACKUP_DIR"
  if (( OPT_DRYRUN )); then info "(kuru çalıştırma) yedek klasörü $VARDIR/backups → $NATIVE_BACKUP_DIR taşınır"; return 0; fi
  as_root mkdir -p "$NATIVE_BACKUP_DIR"; as_root chown root:root "$NATIVE_BACKUP_DIR"; as_root chmod 700 "$NATIVE_BACKUP_DIR"
  # Eski klasör hizmet kullanıcısınındır: sembolik bağ izlenmez, yalnızca düz dosyalar taşınır
  if as_root test -d "$VARDIR/backups" && ! as_root test -L "$VARDIR/backups"; then
    as_root find "$VARDIR/backups" -maxdepth 1 -type f -name 'erp-*.dump' -exec mv -n -t "$NATIVE_BACKUP_DIR" -- {} + 2>/dev/null || true
    as_root rmdir "$VARDIR/backups" 2>/dev/null || true
  fi
  okm "Yedek klasörü yönetici (root) klasörüne taşındı: $NATIVE_BACKUP_DIR"
}

# ---- Docker kurulumunun klasörü --------------------------------------------------------------------------------------------
# Çalışan Docker projesinin (muhasebe-erp) kurulum klasörü: compose etiketinden (…/deploy) bulunur; yoksa boş.
docker_live_root() {
  docker_ok || return 0
  local wd
  wd="$(docker ps -a --filter label=com.docker.compose.project=muhasebe-erp --filter label=com.docker.compose.service=app \
    --format '{{.Label "com.docker.compose.project.working_dir"}}' 2>/dev/null | head -n1)"
  [[ -n "$wd" ]] && printf '%s' "${wd%/deploy}"
  return 0
}

# Kurulum klasörü sabittir (uzaktan güncelleme dosyaları yerinde değiştirir). Eski bir kopyadan çalıştırmak sürüm düşürür ya da
# ayarları kaybettirir: taşınmış klasörde (.erp-tasindi) ve canlı proje başka klasördeyken sihirbaz durur. Bu klasörde ayar yoksa
# (yeni kit klasörü) canlı kurulumun ayarları (deploy/.env, Caddyfile.local, certs/, wizard.conf) buraya TAŞINIR ve eski klasöre
# yönlendirme dosyası bırakılır. Eski sürüm güncelleyicisinin açtığı kit klasöründe (ERP_UPDATER_RUN) eksik ayarlar tamamlanır.
LIVE_MOVED_FROM=""
check_install_location() {
  local guard="$ROOT/.erp-tasindi" live
  if [[ -f "$guard" ]]; then
    die "Bu klasör artık kullanılmıyor: kurulum $(head -n1 "$guard") klasörüne taşındı. Sihirbazı oradan çalıştırın: cd $(head -n1 "$guard") && ./install.sh …"
  fi
  [[ "$MODE" == prod ]] || return 0
  live="$(docker_live_root)"
  [[ -n "$live" && -d "$live" && -f "$live/deploy/.env" ]] || return 0
  [[ "$live" -ef "$ROOT" ]] && return 0
  # Yerel kurulum varsa ve Docker yolu istenmediyse Docker projesine dokunulmaz
  if [[ "$PATH_CHOICE" != docker && ! -f "$ROOT/deploy/.env" ]] && fexists "$ETC/erp.env"; then return 0; fi
  [[ "$PATH_CHOICE" == native ]] && return 0
  if [[ -f "$ROOT/deploy/.env" && -z "${ERP_UPDATER_RUN:-}" ]]; then
    die "Çalışan Docker kurulumu başka klasörde: $live. Bu klasör ($ROOT) eski bir kopya; sihirbazı canlı klasörden çalıştırın: cd $(printf '%q' "$live") && ./install.sh …"
  fi
  if (( OPT_UNINSTALL || OPT_RECONFIGURE )); then
    die "Çalışan Docker kurulumu $live klasöründe; kaldırma/yeniden yapılandırma oradan yapılır: cd $(printf '%q' "$live") && ./install.sh …"
  fi
  if (( OPT_DRYRUN )); then
    info "(kuru çalıştırma) Docker kurulumu $live klasöründen bu klasöre ($ROOT) taşınır: deploy/.env, Caddyfile.local, certs/, wizard.conf"
    return 0
  fi
  if [[ -z "${ERP_UPDATER_RUN:-}" ]]; then
    warn "Çalışan Docker kurulumu başka klasörde: $live"
    info "Bu kit klasörü ($ROOT) yeni kurulum klasörü olacak: ayarlar, parolalar ve sertifikalar buraya taşınır; eski klasöre yönlendirme notu bırakılır."
    confirm "Kurulum bu klasöre taşınsın mı?" || die "Vazgeçildi (hiçbir şey değiştirilmedi)"
  fi
  migrate_docker_state "$live"
}
migrate_docker_state() {
  local from="$1" f
  mkdir -p "$ROOT/deploy"
  for f in .env Caddyfile.local wizard.conf; do
    if [[ -f "$from/deploy/$f" && ! -f "$ROOT/deploy/$f" ]]; then cp -p "$from/deploy/$f" "$ROOT/deploy/$f"; fi
  done
  [[ -f "$ROOT/deploy/.env" ]] && chmod 600 "$ROOT/deploy/.env"
  # Özel depo yerinde kalır; çalışan konteynerle dosya kopyalama yarışına girilmez.
  local old_files
  old_files="$(sed -n 's/^CONSTRUCTION_FILES_DIR=//p' "$from/deploy/.env")"
  old_files="${old_files:-construction-data}"
  [[ "$old_files" = /* ]] || old_files="$from/deploy/$old_files"
  if [[ -d "$old_files" ]]; then
    old_files="$(cd -- "$old_files" && pwd -P)"
    set_env_line "$ROOT/deploy/.env" CONSTRUCTION_FILES_DIR "$old_files"
    warn "Kalıcı çizim/model deposu yerinde korunuyor: $old_files. Bu klasörü silmeyin; yeni kurulum ve yedekler aynı depoyu kullanır."
  fi
  if [[ -d "$from/deploy/certs" && ! -d "$ROOT/deploy/certs" ]]; then cp -a "$from/deploy/certs" "$ROOT/deploy/certs"; fi
  # Varsayılan yedek klasörü eski kurulum klasörünün içindeyse yeni klasördeki karşılığına geçilir (eski yedekler yerinde kalır)
  if [[ -f "$ROOT/deploy/wizard.conf" ]] && grep -qxF "BACKUP_DIR=$from/backups" "$ROOT/deploy/wizard.conf"; then
    sed -i "s|^BACKUP_DIR=.*|BACKUP_DIR=$ROOT/backups|" "$ROOT/deploy/wizard.conf"
    warn "Eski yedekler $from/backups klasöründe kaldı; yeni yedekler $ROOT/backups klasörüne yazılır."
  fi
  printf '%s\n# Muhasebe ERP kurulumu bu klasöre taşındı (%s). Bu klasördeki sihirbaz çalışmaz.\n' "$ROOT" "$(date -Iseconds)" > "$from/.erp-tasindi" 2>/dev/null \
    || as_root tee "$from/.erp-tasindi" >/dev/null <<< "$ROOT"
  LIVE_MOVED_FROM="$from"
  okm "Docker kurulumunun ayarları taşındı: $from → $ROOT (eski klasörde .erp-tasindi notu)"
}

finish_prod() {
  local port="$1" url
  if [[ "$TLS_MODE" != none && -n "${DOMAIN:-}" ]]; then url="${BASE_URL_VALUE:-$(derive_base_url)}"
  elif [[ "$ACCESS" == lan ]]; then url="http://$(lan_ip):$port"
  else url="http://localhost:$port"; fi
  print_summary "$url"
}

# ---- Kaldırma (yerel ya da Docker kurulumu) ------------------------------------------------------------------------------
# act "açıklama" komut… — kuru çalıştırmada yalnızca yazar
act() { local d="$1"; shift; if (( OPT_DRYRUN )); then info "(kuru) $d"; else "$@"; fi; }
quiet() { "$@" >/dev/null 2>&1; }

# Kalıcı silme onayı: --yes/yanıt dosyası bu onayı VERMEZ. Terminalde 'SIL' yazılır ya da betikte --i-understand-purge verilir.
confirm_purge() { # confirm_purge "silinecekler"
  say ""
  warn "KALICI SİLME: $1"
  (( OPT_DRYRUN )) && { info "(kuru çalıştırma: onay istenmez, hiçbir şey silinmez)"; return 0; }
  (( OPT_PURGE_ACK )) && { warn "--i-understand-purge verildi: onay sorulmadan siliniyor."; return 0; }
  local src="/dev/tty" ans=""
  [[ -n "${ERP_WIZARD_INPUT:-}" ]] && src="$ERP_WIZARD_INPUT"
  if ! { : < "$src"; } 2>/dev/null; then
    die "Kalıcı silme onayı alınamadı (terminal yok). Betikte bilerek silmek için --i-understand-purge ekleyin."
  fi
  printf "  Geri alınamaz. Onaylamak için büyük harflerle SIL yazın: " >&2
  IFS= read -r ans < "$src" || true
  ans="${ans%$'\r'}"
  [[ "$ans" == SIL || "$ans" == SİL ]] || die "Onay verilmedi; hiçbir şey silinmedi."
}

uninstall_main() {
  local native=0 docker=0 kind
  if fexists "$ETC/erp.env" || [[ -L "$PREFIX/current" ]]; then native=1; fi
  [[ -f "$ROOT/deploy/.env" ]] && docker=1
  case "$PATH_CHOICE" in native) docker=0 ;; docker) native=0 ;; esac
  if (( native && docker )); then die "Hem yerel hem Docker kurulumu bulundu: hangisinin kaldırılacağını --path=native ya da --path=docker ile belirtin"; fi
  if (( native )); then kind=native; elif (( docker )); then kind=docker; else die "Kaldırılacak kurulum bulunamadı (aranan: $ETC/erp.env, $PREFIX/current, $ROOT/deploy/.env)"; fi
  PATH_CHOICE="$kind"
  load_existing_settings "$kind"
  (( OPT_DRYRUN )) && warn "KURU ÇALIŞTIRMA: hiçbir şey kaldırılmayacak/silinmeyecek; yalnızca yapılacaklar listelenir."
  if [[ "$kind" == native ]]; then uninstall_native; else uninstall_docker; fi
}

# Sihirbazın oluşturduğu veritabanı: wizard.conf (DB_NAME/DB_CREATED), yoksa migrate.env adresindeki ad
install_db_name() {
  local n="${CUR[DB_NAME]:-}" url
  if [[ -z "$n" ]]; then
    url="$(rd "$ETC/migrate.env" | sed -n 's/^MIGRATION_DATABASE_URL=//p')"
    [[ "$url" =~ /([^/?]+)(\?.*)?$ ]] && n="${BASH_REMATCH[1]}"
  fi
  printf '%s' "${n:-$DB_NAME}"
}

uninstall_native() {
  stage "Muhasebe ERP kaldırılıyor (yerel kurulum)"
  local db bdir="${CUR[BACKUP_DIR]:-}" what
  db="$(install_db_name)"
  if (( OPT_PURGE )); then
    if [[ "${CUR[DB_CREATED]:-}" == no ]]; then what="ayarlar ($ETC), uygulama verisi ($VARDIR), varsayılan yedek klasörü ($NATIVE_BACKUP_DIR). Veritabanı '$db' kurulumdan önce vardı: SİLİNMEZ"
    else what="VERİTABANI '$db' (tüm şirket verisi), ayarlar ($ETC), uygulama verisi ($VARDIR), varsayılan yedek klasörü ($NATIVE_BACKUP_DIR)"; fi
    if [[ -n "$bdir" && "$bdir" != "$NATIVE_BACKUP_DIR" && "$bdir" != "$VARDIR/backups" ]]; then what="$what. Özel yedek klasörü ($bdir) KORUNUR"; fi
    confirm_purge "$what"
  fi
  if (( HAS_SYSTEMD )); then
    act "hizmet ve zamanlayıcılar durdurulur: $SVC_NAME, $SVC_NAME-backup.timer, $SVC_NAME-updater.timer" \
      quiet as_root systemctl disable --now "$SVC_NAME" "$SVC_NAME-backup.timer" "$SVC_NAME-updater.timer" || true
    act "systemd birimleri silinir (/etc/systemd/system/$SVC_NAME*.service|timer)" \
      as_root rm -f "/etc/systemd/system/$SVC_NAME.service" "/etc/systemd/system/$SVC_NAME-backup.service" "/etc/systemd/system/$SVC_NAME-backup.timer" \
      "/etc/systemd/system/$SVC_NAME-updater.service" "/etc/systemd/system/$SVC_NAME-updater.timer"
    act "systemctl daemon-reload" as_root systemctl daemon-reload
  elif [[ -x "$PREFIX/bin/erpctl" ]]; then act "uygulama durdurulur (erpctl stop)" quiet as_root "$PREFIX/bin/erpctl" stop || true; fi
  act "program dosyaları silinir: $PREFIX, /usr/local/bin/{erpctl,erp-update,erp-setup}, /etc/cron.d/$SVC_NAME-backup, $UPD_WORK" \
    as_root rm -rf "$PREFIX" /usr/local/bin/erpctl /usr/local/bin/erp-update /usr/local/bin/erp-setup "/etc/cron.d/$SVC_NAME-backup" "$UPD_WORK"
  (( OPT_DRYRUN )) || okm "Program dosyaları ve hizmet kaldırıldı"
  if (( OPT_PURGE )); then
    if [[ "${CUR[DB_CREATED]:-}" == no ]]; then info "Veritabanı '$db' kurulumdan önce vardı: korunuyor"
    else act "veritabanı silinir: $db" as_postgres psql -p "$(pg_port)" -q -c "drop database if exists \"$db\" with (force)"; fi
    if [[ "${CUR[ROLES_CREATED]:-}" == no ]]; then info "erp/erp_app rolleri kurulumdan önce vardı: korunuyor"
    elif (( OPT_DRYRUN )); then info "(kuru) erp/erp_app rolleri silinir (başka veritabanında kullanılıyorsa korunur)"
    # Roller aynı sunucudaki başka veritabanlarında (ör. geliştirme) kullanılıyorsa silinemez; o durumda korunur
    elif as_postgres psql -p "$(pg_port)" -q -c "drop role if exists erp_app" -c "drop role if exists erp" >/dev/null 2>&1; then okm "Roller silindi"
    else info "erp/erp_app rolleri başka veritabanlarında kullanıldığı için korundu"; fi
    act "ayarlar ve uygulama verisi silinir: $ETC $VARDIR $NATIVE_BACKUP_DIR" as_root rm -rf "$ETC" "$VARDIR" "$NATIVE_BACKUP_DIR"
    if id -u "$SVC_USER" >/dev/null 2>&1; then act "hizmet kullanıcısı silinir: $SVC_USER" as_root userdel "$SVC_USER" || true; fi
    (( OPT_DRYRUN )) || okm "Veritabanı, ayarlar ve varsayılan yedekler silindi"
  else
    info "Korunanlar: veritabanı ($db), ayarlar ($ETC), yedekler (${bdir:-$NATIVE_BACKUP_DIR}). Tamamen silmek için: --uninstall --purge"
  fi
}

uninstall_docker() {
  stage "Muhasebe ERP kaldırılıyor (Docker kurulumu: $ROOT)"
  local dc=(docker compose -f "$ROOT/deploy/docker-compose.prod.yml" --env-file "$ROOT/deploy/.env" --profile tls) bdir="${CUR[BACKUP_DIR]:-$ROOT/backups}" what
  if (( OPT_PURGE )); then
    what="Docker birimleri (VERİTABANI pgdata — tüm şirket verisi — ve Caddy sertifikaları), $ROOT/deploy içindeki ayarlar (.env, Caddyfile.local, certs/, wizard.conf)"
    if [[ "$bdir" == "$ROOT/backups" ]]; then what="$what, yedek klasörü ($bdir)"; else what="$what. Özel yedek klasörü ($bdir) KORUNUR"; fi
    confirm_purge "$what"
  fi
  if docker_ok; then
    if (( OPT_PURGE )); then act "kaplar ve birimler (veritabanı dahil) silinir: docker compose down -v" "${dc[@]}" down -v --remove-orphans
    else act "kaplar durdurulup silinir (birimler/veritabanı korunur): docker compose down" "${dc[@]}" down --remove-orphans; fi
  else warn "Docker çalışmıyor: kaplar durdurulamadı (Docker'ı başlatıp yeniden çalıştırın)"; fi
  if can_root; then
    if (( HAS_SYSTEMD )); then
      act "yedek ve güncelleyici zamanlayıcıları durdurulur" quiet as_root systemctl disable --now "$SVC_NAME-backup.timer" "$SVC_NAME-updater.timer" || true
    fi
    act "zamanlayıcı birimleri ve güncelleyici dosyaları silinir" as_root rm -rf "/etc/systemd/system/$SVC_NAME-backup.service" "/etc/systemd/system/$SVC_NAME-backup.timer" \
      "/etc/systemd/system/$SVC_NAME-updater.service" "/etc/systemd/system/$SVC_NAME-updater.timer" "/etc/cron.d/$SVC_NAME-backup" \
      /usr/local/bin/erp-update "$UPD_DIR" "$ETC/updater.json" "$UPD_WORK"
    (( HAS_SYSTEMD )) && act "systemctl daemon-reload" as_root systemctl daemon-reload
  fi
  if (( OPT_PURGE )); then
    act "ayarlar silinir: $ROOT/deploy/{.env,Caddyfile.local,certs,wizard.conf}" rm -rf "$ROOT/deploy/.env" "$ROOT/deploy/Caddyfile.local" "$ROOT/deploy/certs" "$ROOT/deploy/wizard.conf"
    [[ "$bdir" == "$ROOT/backups" ]] && act "yedekler silinir: $bdir" rm -rf "$bdir"
    (( OPT_DRYRUN )) || okm "Veritabanı birimi, ayarlar ve varsayılan yedekler silindi"
  else
    info "Korunanlar: veritabanı (Docker birimi muhasebe-erp_pgdata), ayarlar ($ROOT/deploy/.env…), yedekler ($bdir). Tamamen silmek için: --uninstall --purge"
  fi
}

# ---- Akış ---------------------------------------------------------------------------------------------------------------
validate_flags() {
  local m
  [[ -z "$PORT" ]] || { m="$(v_port "$PORT")" || die "--port: $m"; }
  [[ -z "$HTTP_PORT" ]] || { m="$(v_port "$HTTP_PORT")" || die "--http-port: $m"; }
  [[ -z "$HTTPS_PORT" ]] || { m="$(v_port "$HTTPS_PORT")" || die "--https-port: $m"; }
  case "$TLS_MODE" in ''|auto|byo|selfsigned|none) ;; *) die "--tls auto, byo, selfsigned ya da none olmalı" ;; esac
  case "$ACCESS" in ''|local|lan|domain) ;; *) die "--access local, lan ya da domain olmalı" ;; esac
  case "$PATH_CHOICE" in ''|docker|native) ;; *) die "--path docker ya da native olmalı" ;; esac
  if [[ -n "$DOMAIN" ]]; then m="$(v_host "$DOMAIN")" || die "--domain: $m"; fi
  (( OPT_PURGE && ! OPT_UNINSTALL )) && die "--purge yalnızca --uninstall ile kullanılır"
  return 0
}

# Testler bu dosyayı ERP_INSTALL_SOURCE_ONLY=1 ile kaynak alıp işlevleri tek tek sınar
[[ -n "${ERP_INSTALL_SOURCE_ONLY:-}" ]] && return 0

say "${C_B}Muhasebe ERP kurulum sihirbazı${C_0} ${C_DIM}(Linux/WSL)${C_0}"
[[ -n "$ANSWERS_FILE" ]] && load_answers "$ANSWERS_FILE"
[[ -z "$DEMO" ]] || DEMO="$(norm_yn "$DEMO")" || die "DEMO: 'evet' ya da 'hayır' yazın"
validate_flags
init_input
detect
check_install_location
if (( OPT_UNINSTALL )); then uninstall_main; exit 0; fi
if (( OPT_RECONFIGURE )); then reconfigure_main; exit 0; fi
(( OPT_DRYRUN )) && warn "KURU ÇALIŞTIRMA: sistemde hiçbir şey değiştirilmeyecek."
detect_existing
check_downgrade
compat_check
if (( OPT_CHECK )); then
  if (( FAILS )); then say ""; die "Engelleyici sorun var (✗)."; fi
  say ""; okm "Kurulum yapılabilir."; exit 0
fi
choose_path
configure
if (( OPT_DRYRUN )); then dry_run_report; exit 0; fi
prerequisites
if [[ "$MODE" == dev ]]; then install_dev
elif [[ "$PATH_CHOICE" == docker ]]; then install_prod_docker
else install_prod_native; fi
