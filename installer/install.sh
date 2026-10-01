#!/usr/bin/env bash
# =====================================================================================================================
# Muhasebe ERP kurulum sihirbazı — Linux ve WSL (Ubuntu/Debian)
#
#   1) Uyumluluk kontrolü   2) Yol seçimi   3) Gerekli paketler   4) Sistemin kurulumu
#
# Kip:
#   dev   Depodan test/geliştirme kurulumu (Node 22 + PostgreSQL 16 ya da Docker'da veritabanı, demo verisi)
#   prod  Müşteri kurulumu (kaynaksız sürüm kiti; kit.json varsa varsayılan)
# Yol:
#   docker  PostgreSQL + uygulama Docker Compose ile
#   native  PostgreSQL 16 yerel kurulur; uygulama systemd hizmeti (systemd yoksa erpctl) olarak çalışır
#
# Kullanım:  ./install.sh [--check] [--mode=dev|prod] [--path=docker|native] [--access=local|lan|domain]
#                         [--domain=erp.ornek.com] [--port=3000] [--yes] [--no-demo] [--start] [--uninstall [--purge]]
#                         [--restore-db=yedek.dump]   (güncelleyicinin geri dönüşü: kurmadan önce veritabanını yedekten yükler)
# Ayrıntı:   docs/OPERATIONS.md §2 (Kurulum sihirbazı)
# =====================================================================================================================
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

# ---- Seçenekler -----------------------------------------------------------------------------------------------------
OPT_CHECK=0 OPT_YES=0 OPT_DEMO=1 OPT_START=0 OPT_UNINSTALL=0 OPT_PURGE=0
MODE="" PATH_CHOICE="" ACCESS="" DOMAIN="" PORT=3000 RESTORE_DB=""
UPD_DIR=$PREFIX/updater

usage() { sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

for arg in "$@"; do
  case "$arg" in
    --check) OPT_CHECK=1 ;;
    --yes|-y) OPT_YES=1 ;;
    --no-demo) OPT_DEMO=0 ;;
    --start) OPT_START=1 ;;
    --uninstall) OPT_UNINSTALL=1 ;;
    --purge) OPT_PURGE=1 ;;
    --mode=*) MODE="${arg#*=}" ;;
    --path=*) PATH_CHOICE="${arg#*=}" ;;
    --access=*) ACCESS="${arg#*=}" ;;
    --domain=*) DOMAIN="${arg#*=}" ;;
    --port=*) PORT="${arg#*=}" ;;
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

ask() { # ask "Soru" varsayılan seçenek1 seçenek2 ... → seçilen değer (stdout)
  local q="$1" def="$2"; shift 2
  if (( OPT_YES )) || [[ ! -r /dev/tty ]]; then printf '%s' "$def"; return; fi
  local ans
  printf '%s [%s] (%s): ' "$q" "$def" "$(IFS=/; echo "$*")" > /dev/tty
  read -r ans < /dev/tty || true
  ans="${ans:-$def}"
  for o in "$@"; do [[ "$o" == "$ans" ]] && { printf '%s' "$ans"; return; }; done
  printf '%s' "$def"
}
confirm() { # confirm "Soru" → 0 evet
  if (( OPT_YES )) || [[ ! -r /dev/tty ]]; then return 0; fi
  local ans; printf '%s [E/h]: ' "$1" > /dev/tty; read -r ans < /dev/tty || true
  [[ -z "$ans" || "$ans" =~ ^[EeYy] ]]
}

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
KIT=0 KIT_VERSION="" KIT_TARGET="" REPO=0
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
  stage "1/4 Sistem uyumluluk kontrolü"
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
  else port_busy "$PORT" && busy+=("$PORT"); fi
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
  stage "2/4 Kurulum yolu"
  local rec
  if [[ "$MODE" == prod ]]; then
    if (( DOCKER_READY )); then rec=docker; else rec=native; fi
    (( KIT == 0 )) && rec=docker
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

  if [[ "$MODE" == prod && -z "$ACCESS" ]]; then
    info "Erişim: local = yalnızca bu bilgisayar, lan = yerel ağdaki bilgisayarlar (http), domain = alan adı + otomatik HTTPS (yalnız Docker)"
    ACCESS="$(ask "Uygulamaya nereden erişilecek?" local local lan domain)"
  fi
  [[ "$MODE" == dev ]] && ACCESS=local
  [[ "$ACCESS" == local || "$ACCESS" == lan || "$ACCESS" == domain ]] || die "--access local, lan ya da domain olmalı"
  if [[ "$ACCESS" == domain ]]; then
    [[ "$PATH_CHOICE" == docker ]] || die "Alan adı + HTTPS şimdilik Docker yolunda (Caddy) desteklenir; yerel yolda lan seçip önüne bir ters vekil koyun."
    if [[ -z "$DOMAIN" ]]; then
      (( OPT_YES )) && die "--access=domain için --domain=alan.adi verin"
      printf 'Alan adı (ör. erp.firmaniz.com): ' > /dev/tty; read -r DOMAIN < /dev/tty
    fi
    [[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || die "Geçersiz alan adı: $DOMAIN"
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
  stage "3/4 Gerekli paketler"
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
  stage "4/4 Geliştirme ortamı kurulumu"
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
    for i in $(seq 1 60); do as_user docker compose exec -T db pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
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
  if (( OPT_DEMO )); then as_user npm run --silent db:seed && okm "Demo verisi yüklendi (giriş: demo@ornek.local / Demo-Sifre-123)"; fi

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
  stage "4/4 Sistem kurulumu (Docker)"
  cd "$ROOT"
  local envf=deploy/.env image build_flag=()
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

  if [[ ! -f "$envf" ]]; then
    umask 077
    {
      echo "# Kurulum sihirbazının ürettiği ayarlar ($(date -Iseconds)). Parolalar yalnızca burada durur: dosyayı YEDEKLEYİN."
      echo "POSTGRES_PASSWORD=$(rand_hex 24)"
      echo "ERP_OWNER_PASSWORD=$(rand_hex 24)"
      echo "ERP_APP_PASSWORD=$(rand_hex 24)"
      echo "JWT_SECRET=$(rand_b64 48)"
      echo "ERP_IMAGE=$image"
      echo "APP_VERSION=${KIT_VERSION:-dev}"
      echo "APP_PORT=$PORT"
      case "$ACCESS" in
        local) echo "APP_BIND=127.0.0.1"; echo "COOKIE_SECURE=false"; echo "TRUST_PROXY=false" ;;
        lan) echo "APP_BIND=0.0.0.0"; echo "COOKIE_SECURE=false"; echo "TRUST_PROXY=false" ;;
        domain) echo "APP_BIND=127.0.0.1"; echo "ERP_DOMAIN=$DOMAIN"; echo "APP_BASE_URL=https://$DOMAIN" ;;
      esac
    } > "$envf"
    chmod 600 "$envf"
    okm "deploy/.env oluşturuldu (rastgele parolalar; chmod 600)"
  else
    set_env_line "$envf" ERP_IMAGE "$image"
    [[ -n "$KIT_VERSION" ]] && set_env_line "$envf" APP_VERSION "$KIT_VERSION"
    okm "deploy/.env mevcut: parolalar korundu, imaj $image olarak güncellendi"
  fi

  (( KIT )) && install_updater docker "$ROOT/$envf"
  [[ -n "$RESTORE_DB" ]] && restore_db_docker "$RESTORE_DB"
  local profile=()
  grep -q '^ERP_DOMAIN=.\+' "$envf" && profile=(--profile tls)
  info "Hizmetler başlatılıyor (docker compose up -d)…"
  docker compose -f deploy/docker-compose.prod.yml --env-file "$envf" "${profile[@]}" up -d "${build_flag[@]}"
  local port; port="$(sed -n 's/^APP_PORT=//p' "$envf")"; port="${port:-3000}"
  wait_ready "http://127.0.0.1:$port/api/health/ready" 180 || die "Uygulama hazır olmadı: docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env logs app"
  okm "Uygulama çalışıyor"
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
  as_root mkdir -p "$VARDIR/backups"
  as_root chmod 700 "$VARDIR/backups"
  as_root tee "$PREFIX/bin/erp-backup" >/dev/null <<BK
#!/usr/bin/env bash
# Muhasebe ERP yedeği (pg_dump, sıkıştırılmış özel biçim). Son 14 yedek tutulur. Geri yükleme: docs/OPERATIONS.md §6
set -euo pipefail
set -a; . $ETC/migrate.env; set +a
out=$VARDIR/backups/erp-\$(date +%Y%m%d-%H%M%S).dump
/usr/lib/postgresql/$PG_MAJOR/bin/pg_dump -Fc -d "\$MIGRATION_DATABASE_URL" -f "\$out"
chmod 600 "\$out"
ls -1t $VARDIR/backups/erp-*.dump 2>/dev/null | tail -n +15 | xargs -r rm -f
echo "Yedek: \$out"
BK
  as_root chmod 700 "$PREFIX/bin/erp-backup"
  if (( HAS_SYSTEMD )); then
    as_root tee "/etc/systemd/system/$SVC_NAME-backup.service" >/dev/null <<EOF
[Unit]
Description=Muhasebe ERP günlük yedek
[Service]
Type=oneshot
ExecStart=$PREFIX/bin/erp-backup
EOF
    as_root tee "/etc/systemd/system/$SVC_NAME-backup.timer" >/dev/null <<EOF
[Unit]
Description=Muhasebe ERP günlük yedek (02:30)
[Timer]
OnCalendar=*-*-* 02:30:00
Persistent=true
[Install]
WantedBy=timers.target
EOF
    as_root systemctl daemon-reload
    as_root systemctl enable --now "$SVC_NAME-backup.timer" >/dev/null 2>&1 || true
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
  stage "4/4 Sistem kurulumu (yerel)"
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
  if as_root test -f "$ETC/erp.env" && as_root test -f "$ETC/migrate.env"; then
    okm "Mevcut ayarlar korunuyor ($ETC)"
  else
    fresh=1
    owner_pw="$(rand_hex 24)"; app_pw="$(rand_hex 24)"; jwt="$(rand_b64 48)"
    if as_postgres psql -p "$pgp" -tAc "select 1 from pg_roles where rolname='erp'" 2>/dev/null | grep -q 1; then
      warn "PostgreSQL'de 'erp' rolleri zaten var: parolaları yeni üretilenlerle değiştirilecek (aynı sunucudaki eski bir kurulum etkilenir)."
      confirm "Devam edilsin mi?" || die "Kurulum durduruldu"
    fi
    as_postgres psql -p "$pgp" -v ON_ERROR_STOP=1 -q -v owner_pw="$owner_pw" -v app_pw="$app_pw" -v dbname="$DB_NAME" \
      -f - < "$INSTALLER/sql/bootstrap-prod.sql" >/dev/null
    okm "Veritabanı '$DB_NAME' ve roller hazır"
    local host=127.0.0.1 secure=false
    [[ "$ACCESS" == lan ]] && host=0.0.0.0
    umask 077
    as_root tee "$ETC/erp.env" >/dev/null <<EOF
# Muhasebe ERP çalışma zamanı ayarları (kurulum: $(date -Iseconds)). Gizli: yalnızca root ve $SVC_USER okur. YEDEKLEYİN.
NODE_ENV=production
HOST=$host
PORT=$PORT
DATABASE_URL=postgres://erp_app:$app_pw@127.0.0.1:$pgp/$DB_NAME
JWT_SECRET=$jwt
WEB_DIST_DIR=$PREFIX/current/app/web
LICENSE_HOST_ID_FILE=/etc/machine-id
TRUST_PROXY=false
COOKIE_SECURE=$secure
REGISTRATION_ENABLED=true
APP_VERSION=$ver
EOF
    as_root tee "$ETC/migrate.env" >/dev/null <<EOF
# Şema sahibi bağlantısı: yalnızca migration ve yedek kullanır (uygulama hizmeti okumaz).
MIGRATION_DATABASE_URL=postgres://erp:$owner_pw@127.0.0.1:$pgp/$DB_NAME
EOF
    as_root chown "root:$SVC_USER" "$ETC/erp.env"; as_root chmod 640 "$ETC/erp.env"
    as_root chown root:root "$ETC/migrate.env"; as_root chmod 600 "$ETC/migrate.env"
    okm "Ayarlar yazıldı ($ETC/erp.env, $ETC/migrate.env)"
  fi
  as_root sed -i "s/^APP_VERSION=.*/APP_VERSION=$ver/" "$ETC/erp.env"
  [[ -n "$RESTORE_DB" ]] && restore_db_native "$RESTORE_DB"

  # current'ı yeni sürüme çevir → migration → başlat
  as_root ln -sfn "versions/$ver" "$PREFIX/current"
  info "Veritabanı şeması kuruluyor/yükseltiliyor…"
  if ! as_root "$PREFIX/current/app/runtime/node" --env-file="$ETC/migrate.env" "$PREFIX/current/app/dist/migrate.js"; then
    [[ -n "$prev" ]] && as_root ln -sfn "$prev" "$PREFIX/current"
    die "Migration başarısız; önceki sürüm geri alındı (veritabanı değişmediyse). Ayrıntı yukarıda."
  fi

  write_erpctl
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
  if (( fresh )); then
    if (( HAS_SYSTEMD )); then info "Günlük yedek: systemd zamanlayıcısı 02:30 ($VARDIR/backups, son 14). Elle: sudo $PREFIX/bin/erp-backup"
    else warn "Otomatik yedek yok (systemd kapalı): sudo $PREFIX/bin/erp-backup komutunu düzenli çalıştırın (cron)"; fi
  fi
  finish_prod "$PORT"
}

# ---- Uzaktan güncelleme: güncelleyici (her dakika; yönetici yetkisiyle) -------------------------------------------------
ensure_env_secret() { # ensure_env_secret dosya ANAHTAR değer — yoksa ekler (varsa dokunmaz)
  local f="$1" k="$2" v="$3"
  if ! as_root grep -q "^${k}=" "$f" 2>/dev/null; then printf '%s=%s\n' "$k" "$v" | as_root tee -a "$f" >/dev/null; fi
}

install_updater() { # install_updater mod ortam-dosyası
  local mode="$1" envf="$2" node_src="$ROOT/app/runtime/node"
  [[ -x "$node_src" && -f "$ROOT/app/dist/updater.js" ]] || { warn "Kitte güncelleyici yok; uzaktan güncelleme kapalı"; return 0; }
  ensure_env_secret "$envf" ERP_UPDATER_TOKEN "$(rand_hex 32)"
  ensure_env_secret "$envf" ERP_KIT_TARGET linux-x64
  as_root mkdir -p "$UPD_DIR" "$ETC" "$VARDIR/updater"
  as_root chmod 700 "$VARDIR/updater"
  # Çalışan güncelleyicinin dosyaları yeniden adlandırmayla değiştirilir (çalışan ikilinin üzerine yazılamaz)
  as_root cp "$node_src" "$UPD_DIR/node.new" && as_root mv -f "$UPD_DIR/node.new" "$UPD_DIR/node"
  as_root cp "$ROOT/app/dist/updater.js" "$UPD_DIR/updater.js.new" && as_root mv -f "$UPD_DIR/updater.js.new" "$UPD_DIR/updater.js"
  local args="\"--port=$PORT\", \"--access=$ACCESS\""
  [[ -n "$DOMAIN" ]] && args="$args, \"--domain=$DOMAIN\""
  local extra
  if [[ "$mode" == docker ]]; then extra="\"dockerDir\": \"$ROOT\", \"dbName\": \"$DB_NAME\""
  else extra="\"nativePrefix\": \"$PREFIX\", \"backupCommand\": [\"$PREFIX/bin/erp-backup\"]"; fi
  printf '{\n  "mode": "%s",\n  "platform": "linux-x64",\n  "appUrl": "http://127.0.0.1:%s",\n  "envFile": "%s",\n  "workDir": "%s",\n  "installArgs": [%s],\n  %s\n}\n' \
    "$mode" "$PORT" "$envf" "$VARDIR/updater" "$args" "$extra" | as_root tee "$ETC/updater.json" >/dev/null
  as_root chmod 600 "$ETC/updater.json"
  printf '#!/usr/bin/env bash\n# Muhasebe ERP güncelleyicisini şimdi çalıştırır (sahibin onayladığı güncelleme varsa uygular). Günlük: %s/updater/updater.log\nexec "%s/node" "%s/updater.js" --config="%s/updater.json"\n' \
    "$VARDIR" "$UPD_DIR" "$UPD_DIR" "$ETC" | as_root tee /usr/local/bin/erp-update >/dev/null
  as_root chmod 755 /usr/local/bin/erp-update
  if (( HAS_SYSTEMD )); then
    printf '[Unit]\nDescription=Muhasebe ERP uzaktan güncelleme denetimi\nAfter=network-online.target\n\n[Service]\nType=oneshot\nExecStart=%s/node %s/updater.js --config=%s/updater.json\nTimeoutStartSec=2h\n' \
      "$UPD_DIR" "$UPD_DIR" "$ETC" | as_root tee "/etc/systemd/system/$SVC_NAME-updater.service" >/dev/null
    printf '[Unit]\nDescription=Muhasebe ERP uzaktan güncelleme denetimi (dakikada bir)\n\n[Timer]\nOnBootSec=2min\nOnUnitActiveSec=60s\nAccuracySec=10s\n\n[Install]\nWantedBy=timers.target\n' \
      | as_root tee "/etc/systemd/system/$SVC_NAME-updater.timer" >/dev/null
    as_root systemctl daemon-reload
    as_root systemctl enable --now "$SVC_NAME-updater.timer" >/dev/null 2>&1 || true
    okm "Uzaktan güncelleme hazır: sahip onaylayınca uygulanır (günlük: $VARDIR/updater/updater.log)"
  else
    warn "systemd yok: onaylanan uzaktan güncellemeler kendiliğinden uygulanmaz; 'sudo erp-update' ile çalıştırın (ya da cron'a dakikalık ekleyin)"
  fi
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
  as_root "/usr/lib/postgresql/$PG_MAJOR/bin/pg_restore" --exit-on-error --single-transaction --no-owner --role=erp -d "$url" "$file"
  okm "Veritabanı geri yüklendi"
}

restore_db_docker() {
  local file="$1" dc=(docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env) i
  [[ -f "$file" ]] || die "Yedek dosyası yok: $file"
  info "Veritabanı yedekten geri yükleniyor (Docker): $file"
  "${dc[@]}" stop app >/dev/null 2>&1 || true
  "${dc[@]}" up -d db >/dev/null
  for i in $(seq 1 60); do "${dc[@]}" exec -T db pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
  "${dc[@]}" exec -T db psql -U postgres -v ON_ERROR_STOP=1 -q -c "drop database if exists $DB_NAME with (force)" -c "create database $DB_NAME owner erp" \
    -c "revoke all on database $DB_NAME from public" -c "grant connect on database $DB_NAME to erp_app" >/dev/null
  "${dc[@]}" exec -T db pg_restore -U postgres --exit-on-error --single-transaction --no-owner --role=erp -d "$DB_NAME" < "$file"
  okm "Veritabanı geri yüklendi"
}

finish_prod() {
  local port="$1" url
  case "$ACCESS" in
    domain) url="https://$DOMAIN" ;;
    lan) url="http://$(hostname -I 2>/dev/null | awk '{print $1}'):$port" ;;
    *) url="http://localhost:$port" ;;
  esac
  stage "Hazır"
  say "  Adres:  $url"
  say "  1) Tarayıcıda açın → 'Lisans etkinleştirme' ekranına satıcıdan aldığınız kodu girin."
  say "  2) Sonra ilk sahip hesabını oluşturun; ardından kaydı kapatın (REGISTRATION_ENABLED=false)."
  say "  Ayar dosyalarını (parolalar) güvenli bir yere yedekleyin. Ayrıntı: docs/OPERATIONS.md"
}

# ---- Kaldırma (yerel kurulum) -----------------------------------------------------------------------------------------
uninstall_native() {
  stage "Muhasebe ERP kaldırılıyor (yerel kurulum)"
  if (( HAS_SYSTEMD )); then
    as_root systemctl disable --now "$SVC_NAME" "$SVC_NAME-backup.timer" "$SVC_NAME-updater.timer" >/dev/null 2>&1 || true
    as_root rm -f "/etc/systemd/system/$SVC_NAME.service" "/etc/systemd/system/$SVC_NAME-backup.service" "/etc/systemd/system/$SVC_NAME-backup.timer" \
      "/etc/systemd/system/$SVC_NAME-updater.service" "/etc/systemd/system/$SVC_NAME-updater.timer"
    as_root systemctl daemon-reload
  elif [[ -x "$PREFIX/bin/erpctl" ]]; then as_root "$PREFIX/bin/erpctl" stop >/dev/null 2>&1 || true; fi
  as_root rm -rf "$PREFIX" /usr/local/bin/erpctl /usr/local/bin/erp-update
  okm "Program dosyaları ve hizmet kaldırıldı"
  if (( OPT_PURGE )); then
    confirm "VERİTABANI '$DB_NAME', ayarlar ve yedekler KALICI olarak silinsin mi?" || die "Vazgeçildi"
    as_postgres psql -p "$(pg_port)" -q -c "drop database if exists $DB_NAME" >/dev/null
    # Roller aynı sunucudaki başka veritabanlarında (ör. geliştirme) kullanılıyorsa silinemez; o durumda korunur
    if as_postgres psql -p "$(pg_port)" -q -c "drop role if exists erp_app" -c "drop role if exists erp" >/dev/null 2>&1; then okm "Roller silindi"
    else info "erp/erp_app rolleri başka veritabanlarında kullanıldığı için korundu"; fi
    as_root rm -rf "$ETC" "$VARDIR"
    id -u "$SVC_USER" >/dev/null 2>&1 && as_root userdel "$SVC_USER" || true
    okm "Veritabanı, ayarlar ve yedekler silindi"
  else
    info "Veritabanı ($DB_NAME), ayarlar ($ETC) ve yedekler ($VARDIR/backups) korundu; tamamen silmek için --uninstall --purge"
  fi
}

# ---- Akış ---------------------------------------------------------------------------------------------------------------
say "${C_B}Muhasebe ERP kurulum sihirbazı${C_0} ${C_DIM}(Linux/WSL)${C_0}"
detect
if (( OPT_UNINSTALL )); then uninstall_native; exit 0; fi
compat_check
if (( OPT_CHECK )); then
  if (( FAILS )); then say ""; die "Engelleyici sorun var (✗)."; fi
  say ""; okm "Kurulum yapılabilir."; exit 0
fi
choose_path
prerequisites
if [[ "$MODE" == dev ]]; then install_dev
elif [[ "$PATH_CHOICE" == docker ]]; then install_prod_docker
else install_prod_native; fi
