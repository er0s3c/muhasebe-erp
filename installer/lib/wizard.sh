# shellcheck shell=bash
# shellcheck disable=SC2034
# =====================================================================================================================
# Muhasebe ERP kurulum sihirbazı — yapılandırma aşaması (Linux/WSL). install.sh tarafından `source` edilir.
# Sorular (demo/boş, port, alan adı ve HTTPS, e-posta, lisans, yedek), ayar dosyalarının yazımı, yeniden yapılandırma,
# kuru çalıştırma, özet ekranı. Yanıt anahtarları install.ps1 ile aynıdır (docs/OPERATIONS.md §2).
# =====================================================================================================================

declare -gA CUR=()          # mevcut kurulumun ayarları (yeniden yapılandırmada soruların varsayılanı)
EXISTING=0 EXISTING_PATH="" CHG=() LIC_STATE="" LIC_ENFORCED="" SELF_SIGNED_INTERNAL=0 MAIL_TEST_DEFERRED=0 SEEDED_DEMO=0 LICENSE_ACTIVATED=""
SMTP_URL_VALUE="" MAIL_FROM_VALUE="" BASE_URL_VALUE=""
WIZARD_TS="$(date +%Y%m%d-%H%M%S)"

can_root() { [[ $EUID -eq 0 || -n "${SUDO:-}" ]]; }
fexists() { [[ -e "$1" ]] || { can_root && as_root test -e "$1" 2>/dev/null; }; }
rd() { if [[ -r "$1" ]]; then cat "$1"; elif can_root; then as_root cat "$1" 2>/dev/null || true; fi; }
env_file() { if [[ "$PATH_CHOICE" == native ]]; then printf '%s/erp.env' "$ETC"; else printf '%s/deploy/.env' "$ROOT"; fi; }
conf_file() { if [[ "$PATH_CHOICE" == native ]]; then printf '%s/wizard.conf' "$ETC"; else printf '%s/deploy/wizard.conf' "$ROOT"; fi; }
sh_w() { if [[ "$PATH_CHOICE" == native ]]; then as_root "$@"; else "$@"; fi; } # yazma yetkisi: yerelde root, Docker yolunda kullanıcı

# install_file HEDEF MOD [SAHİP:GRUP] — stdin içeriği geçici dosyaya yazar, sonra yerine taşır (yarım dosya kalmaz)
install_file() {
  local dst="$1" mode="$2" own="${3:-}" tmp
  tmp="$(mktemp)"; cat > "$tmp"
  if [[ -n "$own" ]]; then sh_w install -m "$mode" -o "${own%%:*}" -g "${own##*:}" "$tmp" "$dst.new"
  else sh_w install -m "$mode" "$tmp" "$dst.new"; fi
  sh_w mv -f "$dst.new" "$dst"
  rm -f "$tmp"
}
# backup_config DOSYA… — zaman damgalı yedek (chmod 600). Yedek dosya adları yazdırılır. Her dosyanın en yeni BAK_KEEP yedeği kalır
# (yedekler parola içerir; sınırsız birikmesin).
BAK_KEEP=5
backup_config() {
  local f old
  for f in "$@"; do
    fexists "$f" || continue
    sh_w cp -p "$f" "$f.bak-$WIZARD_TS"; sh_w chmod 600 "$f.bak-$WIZARD_TS"
    info "Eski ayar yedeklendi: $f.bak-$WIZARD_TS"
    while IFS= read -r old; do [[ -n "$old" ]] && sh_w rm -f -- "$old"; done < <(sh_w find "$(dirname "$f")" -maxdepth 1 -name "$(basename "$f").bak-*" -print 2>/dev/null | prune_bak_list "$f" "$BAK_KEEP")
  done
}

urldec() { printf '%b' "${1//%/\\x}"; }

# ---- Mevcut kurulum --------------------------------------------------------------------------------------------------
detect_existing() {
  EXISTING=0
  [[ "$MODE" == prod ]] || return 0
  local p="$PATH_CHOICE" envf
  if [[ -z "$p" ]]; then
    if fexists "$ETC/erp.env"; then p=native; elif [[ -f "$ROOT/deploy/.env" ]]; then p=docker; fi
  fi
  [[ -n "$p" ]] || return 0
  if [[ "$p" == native ]]; then envf="$ETC/erp.env"; else envf="$ROOT/deploy/.env"; fi
  fexists "$envf" || return 0
  EXISTING=1; EXISTING_PATH="$p"
  load_existing_settings "$p"
}

load_existing_settings() { # mevcut ayarları CUR'a okur; yeniden yapılandırma değilse boş bayrakları da doldurur
  local p="$1" conf envtxt line k v from
  CUR=()
  if [[ "$p" == native ]]; then conf="$ETC/wizard.conf"; envtxt="$(rd "$ETC/erp.env")"; else conf="$ROOT/deploy/wizard.conf"; envtxt="$(rd "$ROOT/deploy/.env")"; fi
  while IFS= read -r line; do
    [[ "$line" =~ ^([A-Z_]+)=(.*)$ ]] && CUR["${BASH_REMATCH[1]}"]="${BASH_REMATCH[2]}"
  done < <(rd "$conf")
  # Eski kurulumlar (ayar dosyası yok): ortam dosyasından çıkarım
  if [[ -z "${CUR[ACCESS]:-}" ]]; then
    if [[ "$p" == docker ]]; then
      v="$(env_value ERP_DOMAIN <<< "$envtxt")"
      if [[ -n "$v" ]]; then CUR[ACCESS]=domain; CUR[DOMAIN]="$v"; CUR[TLS_MODE]=auto
      elif [[ "$(env_value APP_BIND <<< "$envtxt")" == 0.0.0.0 ]]; then CUR[ACCESS]=lan
      else CUR[ACCESS]=local; fi
      CUR[PORT]="$(env_value APP_PORT <<< "$envtxt")"
    else
      if [[ "$(env_value HOST <<< "$envtxt")" == 0.0.0.0 ]]; then CUR[ACCESS]=lan; else CUR[ACCESS]=local; fi
      CUR[PORT]="$(env_value PORT <<< "$envtxt")"
    fi
    CUR[TLS_MODE]="${CUR[TLS_MODE]:-none}"
  fi
  CUR[PORT]="${CUR[PORT]:-3000}"
  v="$(env_value SMTP_URL <<< "$envtxt")"
  if [[ -n "$v" && "$v" =~ ^(smtps?)://(([^:/@]*):([^@]*)@)?([^:/?]+):([0-9]+)(\?(.*))?$ ]]; then
    CUR[MAIL_ENABLED]=yes; CUR[SMTP_HOST]="${BASH_REMATCH[5]}"; CUR[SMTP_PORT]="${BASH_REMATCH[6]}"
    CUR[SMTP_USER]="$(urldec "${BASH_REMATCH[3]}")"; CUR[SMTP_PASSWORD]="$(urldec "${BASH_REMATCH[4]}")"
    if [[ "${BASH_REMATCH[1]}" == smtps ]]; then CUR[SMTP_SECURITY]=ssl
    elif [[ "${BASH_REMATCH[8]}" == *ignoreTLS* ]]; then CUR[SMTP_SECURITY]=none; else CUR[SMTP_SECURITY]=starttls; fi
    v="$(env_value MAIL_FROM <<< "$envtxt")"
    if [[ "$v" =~ ^(.*)\<([^\>]+)\>$ ]]; then CUR[MAIL_FROM_NAME]="${BASH_REMATCH[1]% }"; CUR[MAIL_FROM_ADDRESS]="${BASH_REMATCH[2]}"; else CUR[MAIL_FROM_ADDRESS]="$v"; fi
  else CUR[MAIL_ENABLED]=no; fi
  CUR[LICENSE_SERVER_URL]="$(env_value LICENSE_SERVER_URL <<< "$envtxt")"
  CUR[APP_BASE_URL]="$(env_value APP_BASE_URL <<< "$envtxt")"
  v="$(env_value REGISTRATION_ENABLED <<< "$envtxt")"; [[ "$v" == false ]] && CUR[REGISTRATION]=no || CUR[REGISTRATION]=yes
  CUR[APP_VERSION]="$(env_value APP_VERSION <<< "$envtxt")"
  DB_CREATED="${CUR[DB_CREATED]:-}"; ROLES_CREATED="${CUR[ROLES_CREATED]:-}"
  if (( ! OPT_RECONFIGURE )); then
    for k in ACCESS DOMAIN PORT TLS_MODE HTTP_PORT HTTPS_PORT; do
      from="${CUR[$k]:-}"
      [[ -z "${!k:-}" && -n "$from" ]] && printf -v "$k" '%s' "$from"
    done
  fi
  return 0
}

# ---- Yardımcılar: ağ ve araçlar --------------------------------------------------------------------------------------
lan_ip() { hostname -I 2>/dev/null | awk '{print $1}'; }
dns_ipv4() { getent ahostsv4 "$1" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' | sed 's/ $//'; }
public_ip() { curl -fsS --max-time 6 https://api.ipify.org 2>/dev/null | grep -E '^[0-9.]+$' || true; }

tool_node() { # araçları çalıştıracak Node: kit içindeki gömülü çalışma zamanı, yoksa sistemdeki Node ≥ 20
  local n
  if [[ -x "$ROOT/app/runtime/node" ]] && "$ROOT/app/runtime/node" -v >/dev/null 2>&1; then printf '%s' "$ROOT/app/runtime/node"; return 0; fi
  if command -v node >/dev/null 2>&1; then n="$(node_version)"; if [[ -n "$n" ]] && ver_ge "$n" 20.0.0; then printf 'node'; return 0; fi; fi
  return 1
}
tool_modules_dir() { if [[ -d "$ROOT/app/node_modules/nodemailer" ]]; then printf '%s/app' "$ROOT"; else printf '%s' "$ROOT"; fi; }
run_tool() { local n; n="$(tool_node)" || return 127; ERP_NODE_MODULES_DIR="$(tool_modules_dir)" "$n" "$INSTALLER/tools/erp-tool.mjs" "$@"; }

derive_base_url() { # e-posta bağlantılarının kökü
  if [[ "$TLS_MODE" != none && -n "$DOMAIN" ]]; then
    if [[ "${HTTPS_PORT:-443}" == 443 ]]; then printf 'https://%s' "$DOMAIN"; else printf 'https://%s:%s' "$DOMAIN" "$HTTPS_PORT"; fi
  elif [[ "$ACCESS" == lan ]]; then printf 'http://%s:%s' "$(lan_ip)" "$PORT"
  else printf 'http://localhost:%s' "$PORT"; fi
}

# ---- Ortam değişikliklerinin üretimi ---------------------------------------------------------------------------------------
build_env_changes() { # build_env_changes docker|native → CHG dizisi (KEY=VAL ya da -KEY)
  local target="$1" reg=true
  CHG=()
  [[ "$REGISTRATION" == no ]] && reg=false
  if [[ "$target" == docker ]]; then
    CHG+=("APP_PORT=$PORT")
    if [[ "$TLS_MODE" == none ]]; then
      if [[ "$ACCESS" == lan ]]; then CHG+=(APP_BIND=0.0.0.0); else CHG+=(APP_BIND=127.0.0.1); fi
      CHG+=(COOKIE_SECURE=false TRUST_PROXY=false -ERP_DOMAIN -ERP_CADDYFILE -ERP_CERT_DIR -HTTP_PORT -HTTPS_PORT)
    else
      CHG+=(APP_BIND=127.0.0.1 -COOKIE_SECURE -TRUST_PROXY "ERP_DOMAIN=$DOMAIN" "ERP_CADDYFILE=./Caddyfile.local" "HTTP_PORT=$HTTP_PORT" "HTTPS_PORT=$HTTPS_PORT")
      if [[ "$TLS_MODE" == auto ]]; then CHG+=(-ERP_CERT_DIR); else CHG+=("ERP_CERT_DIR=./certs"); fi
    fi
  else
    if [[ "$ACCESS" == lan ]]; then CHG+=(HOST=0.0.0.0); else CHG+=(HOST=127.0.0.1); fi
    CHG+=("PORT=$PORT" COOKIE_SECURE=false TRUST_PROXY=false)
  fi
  if [[ "$MAIL_ENABLED" == yes ]]; then
    CHG+=("SMTP_URL=$SMTP_URL_VALUE" "MAIL_FROM=$MAIL_FROM_VALUE" "APP_BASE_URL=$BASE_URL_VALUE")
  else
    CHG+=(-SMTP_URL -MAIL_FROM)
    if [[ "$TLS_MODE" != none ]]; then CHG+=("APP_BASE_URL=$BASE_URL_VALUE"); else CHG+=(-APP_BASE_URL); fi
  fi
  if [[ -n "$LICENSE_SERVER_URL" ]]; then CHG+=("LICENSE_SERVER_URL=$LICENSE_SERVER_URL"); else CHG+=(-LICENSE_SERVER_URL); fi
  CHG+=("REGISTRATION_ENABLED=$reg")
  # Üretimde geliştirme anahtarları asla bulunmaz (uygulama zaten reddeder)
  CHG+=(-LICENSE_ENFORCEMENT_DEV -LICENSE_DEV_KEYRING -MAIL_TRANSPORT)
}

# ---- Sorular -----------------------------------------------------------------------------------------------------------------
configure_demo() {
  section "Demo verisi"
  local def=no
  [[ "$MODE" == dev ]] && def=yes
  ask_yn DEMO "Demo verisi (örnek şirket/cari/proje) yüklensin mi?" "Hayır = tamamen boş uygulama (örnek şirket, kullanıcı ya da veri yok; ilk hesabı siz açarsınız). Evet = deneme için örnek veriler." "${CUR[DEMO]:-$def}"
  if [[ "$DEMO" == yes && "$MODE" == prod ]]; then warn "Demo hesabının parolası herkesçe bilinir (demo@ornek.local); gerçek veri girmeden önce boş kuruluma geçin."; fi
}

ask_free_port() { # ask_free_port DEĞİŞKEN "Soru" "açıklama" varsayılan [izinli-mevcut-port]
  local var="$1" q="$2" help="$3" def="$4" allow="${5:-}" preset=0
  [[ -n "${!var:-}" ]] && preset=1
  while :; do
    ask_val "$var" "$q" "$help" "$def" v_port
    if [[ "${!var}" == "$allow" ]] || ! port_busy "${!var}"; then return 0; fi
    if interactive && (( ! preset )); then warn "Port ${!var} başka bir uygulama tarafından kullanılıyor; başka bir port seçin."; printf -v "$var" ''; continue; fi
    die "$q: port ${!var} kullanımda (başka bir uygulama?). Farklı bir port seçin ya da o uygulamayı durdurun."
  done
}

ask_access() {
  [[ "$MODE" == dev ]] && { ACCESS=local; return 0; }
  help_line "local = yalnızca bu bilgisayar, lan = yerel ağdaki bilgisayarlar, domain = alan adı üzerinden internet"
  ask_choice ACCESS "Uygulamaya nereden erişilecek?" "" "${CUR[ACCESS]:-local}" local lan domain
  if [[ "$ACCESS" == domain && "$PATH_CHOICE" != docker ]]; then die "Alan adı + HTTPS şimdilik Docker yolunda (Caddy) desteklenir; yerel yolda --access=lan seçip önüne bir ters vekil koyun."; fi
}

tls_precheck_acme() { # Let's Encrypt ön kontrolleri (yalnızca uyarır)
  local ip pub bad=0
  ip="$(dns_ipv4 "$DOMAIN")"
  if [[ -z "$ip" ]]; then warn "$DOMAIN için DNS kaydı bulunamadı: alan adını bu sunucunun IP adresine yönlendirin (A kaydı), yoksa sertifika alınamaz."; bad=1
  else
    pub="$(public_ip)"
    if [[ -z "$pub" ]]; then info "DNS: $DOMAIN → $ip (bu makinenin genel IP adresi öğrenilemedi; elle doğrulayın)"
    elif [[ " $ip " != *" $pub "* ]]; then warn "DNS $DOMAIN için $ip gösteriyor, ancak bu makinenin genel IP adresi $pub: kayıt başka bir sunucuya yönleniyor olabilir."; bad=1
    else okm "DNS: $DOMAIN → $pub (bu makine)"; fi
  fi
  local p
  for p in 80 443; do
    if port_busy "$p" && [[ "${CUR[TLS_MODE]:-none}" == none ]]; then warn "Port $p bu makinede başka bir uygulama tarafından kullanılıyor; Caddy 80 ve 443'e ihtiyaç duyar."; bad=1; fi
  done
  info "Güvenlik duvarı/yönlendirici: dışarıdan 80 ve 443 portları bu makineye açık olmalı (Let's Encrypt doğrulaması için)."
  if (( bad )) && interactive; then confirm "Yine de devam edilsin mi?" || die "Vazgeçildi"; fi
  return 0
}

validate_cert_files() { # 0 = geçerli; sonuç satırlarını yazdırır
  local out rc=0
  if command -v openssl >/dev/null 2>&1; then out="$(cert_check_openssl "$CERT_FILE" "$KEY_FILE" "$DOMAIN")" || rc=$?
  elif tool_node >/dev/null; then out="$(run_tool cert-check --cert "$CERT_FILE" --key "$KEY_FILE" --domain "$DOMAIN")" || rc=$?
  else warn "Sertifika doğrulanamadı (openssl ve Node yok); dosyalar olduğu gibi kullanılacak."; return 0; fi
  local l
  while IFS= read -r l; do
    case "$l" in HATA*) printf '  %s✗ %s%s\n' "${C_FAIL:-}" "${l#HATA }" "${C_0:-}" >&2 ;; UYARI*) warn "${l#UYARI }" ;; BİLGİ*) info "${l#BİLGİ }" ;; esac
  done <<< "$out"
  return "$rc"
}

configure_tls() {
  local def_tls=none
  if [[ "$ACCESS" == local ]]; then
    [[ -n "$TLS_MODE" && "$TLS_MODE" != none ]] && die "--tls=$TLS_MODE için --access=lan ya da domain gerekir (local erişimde HTTPS yok)"
    TLS_MODE=none; return 0
  fi
  section "Alan adı ve HTTPS (sertifika)"
  [[ "$ACCESS" == domain ]] && def_tls=auto
  [[ -n "${CUR[TLS_MODE]:-}" && "${CUR[ACCESS]:-}" == "$ACCESS" ]] && def_tls="${CUR[TLS_MODE]}"
  help_line "auto = Let's Encrypt (alan adı + açık 80/443), byo = kendi sertifikanız, selfsigned = kendi imzalı (yerel ağ), none = HTTPS yok (düz http)"
  ask_choice TLS_MODE "Güvenli bağlantı (HTTPS) nasıl sağlansın?" "" "$def_tls" auto byo selfsigned none
  if [[ "$TLS_MODE" == none ]]; then
    [[ "$ACCESS" == domain ]] && die "Alan adı erişiminde HTTPS gerekir (--tls=auto|byo|selfsigned). HTTPS istemiyorsanız --access=lan seçin."
    return 0
  fi
  [[ "$PATH_CHOICE" == docker ]] || die "HTTPS (alan adı/sertifika) şimdilik Docker yolunda (Caddy) desteklenir. Yerel yolda --tls=none seçip kendi ters vekilinizi (nginx/Caddy) kullanın."
  local host_def="${CUR[DOMAIN]:-}" chk=v_host
  [[ "$TLS_MODE" == auto ]] && chk=v_fqdn
  [[ -z "$host_def" && "$ACCESS" == lan ]] && host_def="$(lan_ip)"
  ask_val DOMAIN "Alan adı ya da adres" "Kullanıcıların tarayıcıya yazacağı ad (örn. erp.firmaniz.com; yerel ağda 192.168.1.20 ya da bilgisayar adı)." "$host_def" "$chk"
  case "$TLS_MODE" in
    auto)
      ask_val ACME_EMAIL "Sertifika bildirimleri için e-posta" "Let's Encrypt süre bitimi uyarılarını bu adrese gönderir (boş bırakılabilir)." "${CUR[ACME_EMAIL]:-}" v_email_opt
      [[ -n "$HTTP_PORT$HTTPS_PORT" && ( "${HTTP_PORT:-80}" != 80 || "${HTTPS_PORT:-443}" != 443 ) ]] && die "Let's Encrypt (auto) için HTTP 80 ve HTTPS 443 portları gerekir"
      HTTP_PORT=80; HTTPS_PORT=443
      tls_precheck_acme ;;
    byo)
      while :; do
        ask_val CERT_FILE "Sertifika dosyası (.crt/.pem, tam zincir)" "Sağlayıcıdan aldığınız 'fullchain' dosyasının tam yolu (sunucu sertifikası + ara sertifikalar)." "" v_file_exists
        ask_val KEY_FILE "Özel anahtar dosyası (.key)" "Sertifikanın özel anahtarı (parolasız PEM). İçeriği asla ekrana yazılmaz." "" v_file_exists
        if validate_cert_files; then okm "Sertifika ve anahtar doğrulandı"; break; fi
        if interactive; then CERT_FILE=""; KEY_FILE=""; warn "Dosyaları düzeltip yeniden girin."; else die "Sertifika doğrulaması başarısız (yukarıya bakın)"; fi
      done ;;
    selfsigned)
      info "Kendi imzalı sertifika üretilecek; kullanıcı bilgisayarlarına güvenilir kök olarak eklenmelidir (kurulum sonunda adımlar yazılır)." ;;
  esac
  if [[ "$TLS_MODE" != auto ]]; then
    ask_free_port HTTP_PORT "HTTP portu (HTTPS'e yönlendirir)" "" 80 "${CUR[HTTP_PORT]:-}"
    ask_free_port HTTPS_PORT "HTTPS portu" "Tarayıcıların bağlanacağı güvenli port (standart: 443)." 443 "${CUR[HTTPS_PORT]:-}"
  fi
  return 0
}

mail_test_container() { # Docker yolu, kurulumdan sonra: uygulama kabında dener (host'ta Node yoksa)
  local dc=(docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env)
  [[ "$TLS_MODE" != none ]] && dc+=(--profile tls)
  ( cd "$ROOT" && "${dc[@]}" run --rm --no-deps -T -v "$INSTALLER/tools:/erp-tools:ro" -e ERP_NODE_MODULES_DIR=/app app node /erp-tools/erp-tool.mjs smtp-test --to "$1" )
}

mail_test_now() { # 0 gönderildi, 1 başarısız, 2 çalıştırılamadı
  local out rc=0
  if (( OPT_DRYRUN )); then info "(kuru çalıştırma: test e-postası gönderilmez)"; return 0; fi
  if ! tool_node >/dev/null; then return 2; fi
  info "Test e-postası gönderiliyor: $MAIL_TEST_TO …"
  out="$(SMTP_URL="$SMTP_URL_VALUE" MAIL_FROM="$MAIL_FROM_VALUE" run_tool smtp-test --to "$MAIL_TEST_TO" 2>&1)" || rc=$?
  if (( rc == 0 )); then okm "$out"; else printf '  %s✗ %s%s\n' "${C_FAIL:-}" "$out" "${C_0:-}" >&2; fi
  return "$rc"
}

configure_mail() {
  section "E-posta (SMTP)"
  ask_yn MAIL_ENABLED "E-posta gönderimi kurulsun mu? (parola sıfırlama, e-posta doğrulama)" "Hayır = e-posta olmadan devam; 'Şifremi unuttum' ve doğrulama kapalı kalır, parolayı yönetici sıfırlar (OPERATIONS §4). Sonra --reconfigure ile eklenebilir." "${CUR[MAIL_ENABLED]:-no}"
  [[ "$MAIL_ENABLED" == yes ]] || return 0
  local def_port choice
  while :; do
    ask_val SMTP_HOST "SMTP sunucusu" "Posta sağlayıcınızın giden sunucu adı (örn. smtp.office365.com, smtp.gmail.com)." "${CUR[SMTP_HOST]:-}" v_host
    ask_choice SMTP_SECURITY "Güvenlik türü" "ssl = SSL/TLS (genelde port 465), starttls = STARTTLS (genelde 587), none = şifresiz (önerilmez)" "${CUR[SMTP_SECURITY]:-starttls}" ssl starttls none
    case "$SMTP_SECURITY" in ssl) def_port=465 ;; starttls) def_port=587 ;; *) def_port=25 ;; esac
    [[ "${CUR[SMTP_SECURITY]:-}" == "$SMTP_SECURITY" && -n "${CUR[SMTP_PORT]:-}" ]] && def_port="${CUR[SMTP_PORT]}"
    ask_val SMTP_PORT "SMTP portu" "" "$def_port" v_port
    [[ "$SMTP_SECURITY" == none ]] && warn "Şifresiz bağlantı: kullanıcı adı ve parola ağda açık gider. Yalnızca güvenilir iç ağdaki bir röle için kullanın."
    ask_val SMTP_USER "Kullanıcı adı" "Genellikle e-posta adresiniz. Kimlik doğrulama gerekmeyen bir röle ise boş bırakın." "${CUR[SMTP_USER]:-}" v_smtp_user
    if [[ -n "$SMTP_USER" ]]; then
      ask_val SMTP_PASSWORD "Parola" "Yazarken görünmez. ${CUR[SMTP_PASSWORD]:+Enter = mevcut parolayı koru. }Gmail/Office365 için 'uygulama parolası' gerekebilir." "${CUR[SMTP_PASSWORD]:-}" v_smtp_pass secret
      [[ -n "$SMTP_PASSWORD" ]] || die "Kullanıcı adı verildiğinde parola gerekli"
    else SMTP_PASSWORD=""; fi
    local from_def="${CUR[MAIL_FROM_ADDRESS]:-}"
    [[ -z "$from_def" ]] && v_email "$SMTP_USER" >/dev/null && from_def="$SMTP_USER"
    ask_val MAIL_FROM_ADDRESS "Gönderen e-posta adresi" "Alıcının göreceği 'kimden' adresi (genellikle posta hesabınızın adresi)." "$from_def" v_email
    ask_val MAIL_FROM_NAME "Gönderen adı" "Alıcının göreceği ad (örn. firma adınız)." "${CUR[MAIL_FROM_NAME]:-Muhasebe ERP}" v_display_name
    BASE_URL_VALUE="$(derive_base_url)"
    [[ -n "${CUR[APP_BASE_URL]:-}" && "${CUR[ACCESS]:-}" == "$ACCESS" ]] && BASE_URL_VALUE="${CUR[APP_BASE_URL]}"
    ask_val APP_BASE_URL "Uygulamanın adresi (e-postalardaki bağlantılar için)" "Kullanıcılar uygulamayı hangi adresle açıyorsa o (örn. https://erp.firmaniz.com)." "$BASE_URL_VALUE" v_base_url
    BASE_URL_VALUE="${APP_BASE_URL%/}"
    [[ "$BASE_URL_VALUE" == http://localhost* ]] && warn "Adres 'localhost': e-postadaki bağlantılar yalnızca bu bilgisayarda açılır."
    SMTP_URL_VALUE="$(smtp_url "$SMTP_HOST" "$SMTP_PORT" "$SMTP_SECURITY" "$SMTP_USER" "$SMTP_PASSWORD")"
    MAIL_FROM_VALUE="$(mail_from_value "$MAIL_FROM_ADDRESS" "$MAIL_FROM_NAME")"
    ask_val MAIL_TEST_TO "Test e-postası hangi adrese gönderilsin? (boş = test etme)" "Ayarların çalıştığını görmek için bir adrese deneme iletisi gönderilir." "" v_email_opt
    [[ -n "$MAIL_TEST_TO" ]] || { warn "Test e-postası gönderilmedi: ayarlar denenmeden kaydedilecek."; return 0; }
    local rc=0
    mail_test_now || rc=$?
    case "$rc" in
      0) return 0 ;;
      2) warn "Bu makinede Node.js bulunamadı; test e-postası kurulumdan sonra uygulama kabında denenecek."; MAIL_TEST_DEFERRED=1
         [[ "$PATH_CHOICE" == docker ]] || { warn "Test atlandı."; MAIL_TEST_DEFERRED=0; }
         return 0 ;;
    esac
    if ! interactive; then die "Test e-postası gönderilemedi (yukarıdaki nedene bakın). Ayarları düzeltin ya da MAIL_TEST_TO satırını kaldırın."; fi
    prompt_line "  t) tekrar dene   d) ayarları düzenle   a) e-postasız devam   y) yine de bu ayarlarla devam   [d]: "
    choice="${REPLY_VAL:-d}"
    case "$choice" in
      t|T) while :; do
             mail_test_now && return 0
             prompt_line "  Tekrar denensin mi? (t = evet, başka tuş = menüye dön): "; [[ "$REPLY_VAL" == [tT] ]] || break
           done
           SMTP_HOST=""; SMTP_SECURITY=""; SMTP_PORT=""; SMTP_USER=""; SMTP_PASSWORD=""; MAIL_FROM_ADDRESS=""; MAIL_FROM_NAME=""; APP_BASE_URL=""; MAIL_TEST_TO="" ;;
      a|A) MAIL_ENABLED=no; warn "E-posta olmadan devam ediliyor (sonra --reconfigure ile eklenebilir)."; return 0 ;;
      y|Y) warn "E-posta ayarları denenmeden kaydediliyor."; return 0 ;;
      *) SMTP_HOST=""; SMTP_SECURITY=""; SMTP_PORT=""; SMTP_USER=""; SMTP_PASSWORD=""; MAIL_FROM_ADDRESS=""; MAIL_FROM_NAME=""; APP_BASE_URL=""; MAIL_TEST_TO="" ;;
    esac
  done
}

configure_license() {
  section "Lisans"
  if [[ "$MODE" == dev ]]; then
    info "Geliştirme kurulumunda lisans denetimi kapalıdır (yalnızca NODE_ENV≠production). Müşteri/üretim kurulumunda denetim derlemeye gömülüdür ve kapatılamaz."
    return 0
  fi
  info "Uygulama lisans etkinleştirilmeden çalışmaz: yalnızca etkinleştirme ekranı açılır. Etkinleştirme için satıcıdan aldığınız kod gerekir."
  if [[ -n "$KIT_LICENSE_URL" ]]; then info "Bu kitte lisans sunucusu adresi gömülü: $KIT_LICENSE_URL (boş bırakırsanız bu kullanılır)."
  elif (( KIT )); then warn "Bu kitte lisans sunucusu adresi YOK: adres girmezseniz yalnızca çevrimdışı etkinleştirme yapılabilir (OPERATIONS §4). Satıcıdan adresi isteyin."; fi
  ask_val LICENSE_SERVER_URL "Lisans sunucusu adresi (boş = kitteki varsayılan)" "Boş bırakın: satıcının uygulamaya gömdüğü adres kullanılır. Yalnızca satıcı farklı bir adres verdiyse yazın (https://…)." "${CUR[LICENSE_SERVER_URL]:-}" v_license_url
  if [[ -n "$LICENSE_SERVER_URL" ]]; then
    if (( OPT_DRYRUN )); then info "(kuru çalıştırma: lisans sunucusuna bağlanılmaz)"
    elif [[ "$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "${LICENSE_SERVER_URL%/}/healthz" 2>/dev/null || true)" == 200 ]]; then okm "Lisans sunucusuna erişildi: $LICENSE_SERVER_URL"
    else warn "Lisans sunucusuna (HTTPS) ulaşılamadı: $LICENSE_SERVER_URL. Bu sunucudan lisans sunucusuna 443 çıkışı açık olmalı; yoksa etkinleştirme yapılamaz (çevrimdışı etkinleştirme mümkündür: OPERATIONS §4)."; fi
  elif [[ -n "$KIT_LICENSE_URL" || $KIT -eq 0 ]]; then info "Varsayılan lisans sunucusu kullanılacak; erişimi etkinleştirme sırasında sınanır."
  else warn "Lisans sunucusu yok: çevrimiçi etkinleştirme yapılamaz (yalnızca çevrimdışı etkinleştirme)."; fi
  ask_val LICENSE_CODE "Lisans etkinleştirme kodu (boş = tarayıcıda girerim)" "Satıcıdan aldığınız 25 karakterlik kod (XXXXX-XXXXX-XXXXX-XXXXX-XXXXX). Yazarken görünmez. Kurulum bitince burada etkinleştirilir." "" v_license_code secret
}

configure_backup() {
  section "Yedekleme"
  local def_dir="$NATIVE_BACKUP_DIR"
  [[ "$PATH_CHOICE" == docker ]] && def_dir="$ROOT/backups"
  ask_val BACKUP_DIR "Yedek klasörü" "Günlük veritabanı yedeklerinin yazılacağı klasör (yalnızca yönetici okur). Ofis dışına kopyalama (rsync/UNC) elle kurulur: OPERATIONS §6." "${CUR[BACKUP_DIR]:-$def_dir}" v_abs_path
  ask_val BACKUP_KEEP "Kaç yedek saklansın?" "En yeni bu kadar yedek tutulur, eskiler silinir." "${CUR[BACKUP_KEEP]:-14}" v_keep
  ask_val BACKUP_TIME "Günlük yedek saati (SS:DD)" "Her gün bu saatte otomatik yedek alınır." "${CUR[BACKUP_TIME]:-02:30}" v_time
}

configure_registration() {
  section "Kayıt (ilk hesap)"
  ask_yn REGISTRATION "Yeni kullanıcı/şirket kaydı açık olsun mu?" "Evet (ilk kurulumda gerekli): ilk sahip hesabını tarayıcıda 'Kayıt ol' ile açarsınız. İlk hesaptan sonra ./install.sh --reconfigure ile kapatın." "${CUR[REGISTRATION]:-yes}"
}

print_settings() { # özet (parolasız)
  local l
  say "  Kip / yol:        $MODE / ${PATH_CHOICE:--}"
  if [[ "$MODE" == prod ]]; then
    say "  Erişim:           $ACCESS${DOMAIN:+ ($DOMAIN)}  — HTTPS: ${TLS_MODE:-none}   uygulama portu: $PORT${HTTPS_PORT:+  http/https: $HTTP_PORT/$HTTPS_PORT}"
  fi
  [[ "$DEMO" == yes ]] && l="DEMO verisi yüklenecek" || l="BOŞ uygulama (demo/örnek veri yok)"
  say "  Veri:             $l"
  if [[ "$MODE" == prod ]]; then
    if [[ "$MAIL_ENABLED" == yes ]]; then say "  E-posta:          açık — $SMTP_HOST:$SMTP_PORT ($SMTP_SECURITY), gönderen $MAIL_FROM_VALUE"; else say "  E-posta:          kapalı (parola sıfırlama/doğrulama yok)"; fi
    local lsu="${LICENSE_SERVER_URL:-}"
    if [[ -z "$lsu" ]]; then if [[ -n "$KIT_LICENSE_URL" ]]; then lsu="kitteki varsayılan ($KIT_LICENSE_URL)"; elif (( KIT )); then lsu="YOK (kitte de yok: yalnızca çevrimdışı etkinleştirme)"; else lsu="derlemedeki varsayılan"; fi; fi
    say "  Lisans sunucusu:  $lsu   kod: $([[ -n "$LICENSE_CODE" ]] && echo 'girildi (kurulumda etkinleştirilecek)' || echo 'girilmedi (tarayıcıda girilecek)')"
    say "  Yedek:            her gün $BACKUP_TIME → $BACKUP_DIR (son $BACKUP_KEEP)"
    say "  Yeni kayıt:       $([[ "$REGISTRATION" == yes ]] && echo açık || echo kapalı)"
  fi
}

# Kurulu sistemde yanıt dosyası ya da mevcut ayardan FARKLI bir ayar bayrağı sessizce yok sayılmaz: sihirbaz durur ve
# --reconfigure'u önerir (kuru çalıştırma da aynı kararı verir). Güncelleyicinin kendi çalıştırmasında (ERP_UPDATER_RUN=1)
# bayraklar kurulumdaki değerlerdir; uyuşmazlık yalnızca uyarılır, mevcut ayarlar korunur.
refuse_settings_on_existing() {
  local k cur diffs=()
  for k in "${!FLAG_VAL[@]}"; do
    cur="${CUR[$k]:-}"
    case "$k" in PORT) cur="${cur:-3000}" ;; TLS_MODE) cur="${cur:-none}" ;; DEMO) cur="${cur:-no}" ;; esac
    [[ "${FLAG_VAL[$k]}" == "$cur" ]] || diffs+=("$k: kurulu=${cur:-boş}, verilen=${FLAG_VAL[$k]}")
  done
  if [[ -n "${ERP_UPDATER_RUN:-}" ]]; then
    (( ${#diffs[@]} )) && warn "Güncelleyici bayrakları mevcut ayarlardan farklı; mevcut ayarlar korunuyor (${diffs[*]})"
    return 0
  fi
  if [[ -n "$ANSWERS_FILE" ]]; then
    die "Kurulu sistem bulundu ($EXISTING_PATH): yanıt dosyası yalnızca YENİ kurulumda okunur, burada yok sayılmaz. Ayarları değiştirmek için: ./install.sh --reconfigure --answers=$ANSWERS_FILE  (önce --dry-run ile bakabilirsiniz)"
  fi
  if (( ${#diffs[@]} )); then
    die "Kurulu sistemin ayarlarından farklı bayrak verildi: ${diffs[*]}. Yükseltme/onarım mevcut ayarlarla yapılır; değiştirmek için: ./install.sh --reconfigure (ilgili bayraklarla)"
  fi
  return 0
}

# Kurulu sürümden ESKİ kit kurulmaz (veritabanı yeni şemaya taşınmış olabilir). İstisna: --restore-db (güncelleyicinin geri dönüşü:
# eski sürümün yedeği de geri yüklenir) ya da bilinçli --allow-downgrade.
check_downgrade() {
  (( EXISTING && KIT )) || return 0
  local cur="${CUR[APP_VERSION]:-}"
  is_semver "$cur" && is_semver "$KIT_VERSION" || return 0
  [[ "$(ver_cmp "$KIT_VERSION" "$cur")" == -1 ]] || return 0
  if [[ -n "$RESTORE_DB" ]]; then warn "Sürüm $cur → $KIT_VERSION geri dönülüyor (yedekten geri yüklemeyle)"; return 0; fi
  if (( OPT_ALLOW_DOWNGRADE )); then warn "Sürüm DÜŞÜRÜLÜYOR: $cur → $KIT_VERSION (--allow-downgrade). Veritabanı şeması yeni sürümde kalır."; return 0; fi
  die "Kurulu sürüm $cur, bu kit $KIT_VERSION (daha eski). Sürüm düşürme yapılmaz: yeni sürümün kitini kullanın. (Eski bir kit klasöründen mi çalıştırıyorsunuz? Docker kurulumunun klasörü: docker compose ls)"
}

# Tüm soruları sorar (yeni kurulum). Mevcut kurulumda atlanır (yeniden yapılandırma ayrı akıştır).
configure() {
  stage "3/5 Yapılandırma"
  if (( EXISTING )); then
    refuse_settings_on_existing
    info "Mevcut kurulum bulundu: ayarlar korunuyor (değiştirmek için: ./install.sh --reconfigure)."
    PORT="${PORT:-${CUR[PORT]:-3000}}"; TLS_MODE="${TLS_MODE:-${CUR[TLS_MODE]:-none}}"; DEMO="${CUR[DEMO]:-no}"
    BACKUP_DIR="${CUR[BACKUP_DIR]:-}"; BACKUP_KEEP="${CUR[BACKUP_KEEP]:-14}"; BACKUP_TIME="${CUR[BACKUP_TIME]:-02:30}"
    [[ -z "$BACKUP_DIR" ]] && { if [[ "$PATH_CHOICE" == native ]]; then BACKUP_DIR="$VARDIR/backups"; else BACKUP_DIR="$ROOT/backups"; fi; }
    [[ "$PATH_CHOICE" == native && "$BACKUP_DIR" == "$VARDIR/backups" ]] && info "Yedek klasörü root'a ait konuma taşınacak: $VARDIR/backups → $NATIVE_BACKUP_DIR"
    LICENSE_SERVER_URL="${CUR[LICENSE_SERVER_URL]:-}"; MAIL_ENABLED="${CUR[MAIL_ENABLED]:-no}"
    REGISTRATION="${CUR[REGISTRATION]:-yes}"
    return 0
  fi
  if (( ! INTERACTIVE )); then info "Etkileşimsiz kip: sorulmayan değerler için varsayılanlar kullanılıyor."
  else info "Her soruda Enter varsayılanı kabul eder. Hiçbir şey henüz yazılmadı; en sonda özet gösterilir."; fi
  configure_demo
  if [[ "$MODE" == dev ]]; then
    configure_license
    PORT="${PORT:-3000}"; TLS_MODE=none; MAIL_ENABLED=no; REGISTRATION=yes; BACKUP_DIR=""; BACKUP_KEEP=""; BACKUP_TIME=""
    return 0
  fi
  section "Port"
  ask_free_port PORT "Uygulama portu" "Uygulamanın dinleyeceği port. Başka bir program 3000'i kullanıyorsa farklı bir port seçin. (Veritabanı portu dışarıya açılmaz; yerel yolda mevcut PostgreSQL kümesi kullanılır.)" 3000
  configure_tls
  configure_mail
  configure_license
  configure_backup
  configure_registration
  [[ -z "$MAIL_FROM_VALUE" && "$MAIL_ENABLED" == yes ]] && MAIL_FROM_VALUE="$(mail_from_value "$MAIL_FROM_ADDRESS" "$MAIL_FROM_NAME")"
  BASE_URL_VALUE="${BASE_URL_VALUE:-$(derive_base_url)}"
  section "Özet"
  print_settings >&2
  confirm "Bu ayarlarla devam edilsin mi?" || die "Vazgeçildi (hiçbir şey yazılmadı)"
}

# ---- Dosyaların yazımı -------------------------------------------------------------------------------------------------
gen_selfsigned() { # gen_selfsigned KLASÖR ALAN
  local dir="$1" host="$2" san
  v_ipv4 "$host" && san="IP:$host" || san="DNS:$host"
  openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 825 -keyout "$dir/privkey.pem.new" -out "$dir/fullchain.pem.new" \
    -subj "/CN=$host/O=Muhasebe ERP" -addext "subjectAltName=$san,DNS:localhost" >/dev/null 2>&1 || return 1
  chmod 600 "$dir/privkey.pem.new"; chmod 644 "$dir/fullchain.pem.new"
  mv -f "$dir/privkey.pem.new" "$dir/privkey.pem"; mv -f "$dir/fullchain.pem.new" "$dir/fullchain.pem"
}

apply_tls_files() { # Docker yolunda Caddyfile.local ve sertifika dosyaları
  [[ "$PATH_CHOICE" == docker && "$TLS_MODE" != none ]] || return 0
  local cdir="$ROOT/deploy/certs" files=no
  SELF_SIGNED_INTERNAL=0
  case "$TLS_MODE" in
    byo)
      mkdir -p "$cdir"; chmod 700 "$cdir"
      cp "$CERT_FILE" "$cdir/fullchain.pem.new"; cp "$KEY_FILE" "$cdir/privkey.pem.new"
      chmod 644 "$cdir/fullchain.pem.new"; chmod 600 "$cdir/privkey.pem.new"
      mv -f "$cdir/fullchain.pem.new" "$cdir/fullchain.pem"; mv -f "$cdir/privkey.pem.new" "$cdir/privkey.pem"
      files=yes; okm "Sertifika kopyalandı: deploy/certs (yalnızca yönetici erişir)" ;;
    selfsigned)
      if command -v openssl >/dev/null 2>&1; then
        mkdir -p "$cdir"; chmod 700 "$cdir"
        if [[ "${CUR[TLS_MODE]:-}" == selfsigned && -f "$cdir/fullchain.pem" ]] && cert_check_openssl "$cdir/fullchain.pem" "$cdir/privkey.pem" "$DOMAIN" >/dev/null 2>&1; then
          info "Mevcut kendi imzalı sertifika korunuyor"
        else
          gen_selfsigned "$cdir" "$DOMAIN" || die "Kendi imzalı sertifika üretilemedi (openssl)"
          okm "Kendi imzalı sertifika üretildi (825 gün): deploy/certs/fullchain.pem"
        fi
        files=yes
      else
        SELF_SIGNED_INTERNAL=1
        warn "openssl yok: Caddy'nin kendi yerel sertifika otoritesi kullanılacak (kök sertifika Caddy veri biriminden alınır)."
      fi ;;
  esac
  render_caddyfile "$TLS_MODE" "$ACME_EMAIL" "$HTTPS_PORT" "$files" | install_file "$ROOT/deploy/Caddyfile.local" 644
  okm "Caddy yapılandırması yazıldı: deploy/Caddyfile.local"
}

write_wizard_conf() {
  local k
  {
    echo "# Kurulum sihirbazının durumu (gizli bilgi içermez; parolalar yalnızca ortam dosyasındadır). Elle değiştirmeyin: --reconfigure kullanın."
    echo "WIZARD_SAVED=$(date -Iseconds)"
    echo "INSTALL_PATH=$PATH_CHOICE"
    for k in ACCESS DOMAIN PORT TLS_MODE ACME_EMAIL HTTP_PORT HTTPS_PORT MAIL_ENABLED SMTP_HOST SMTP_PORT SMTP_SECURITY SMTP_USER MAIL_FROM_ADDRESS MAIL_FROM_NAME \
      BACKUP_DIR BACKUP_KEEP BACKUP_TIME REGISTRATION LICENSE_SERVER_URL APP_BASE_URL DEMO DEMO_PENDING DEMO_SEEDED DB_NAME DB_CREATED ROLES_CREATED; do
      printf '%s=%s\n' "$k" "${!k:-}"
    done
  } | install_file "$(conf_file)" 600 "$([[ "$PATH_CHOICE" == native ]] && echo root:root)"
}

# ---- Lisans: durum, kapı doğrulaması, etkinleştirme ------------------------------------------------------------------------
read_license_state() { # read_license_state ADRES → LIC_ENFORCED, LIC_STATE
  local cfg
  cfg="$(curl -fsS --max-time 8 "$1/api/public-config" 2>/dev/null || true)"
  LIC_ENFORCED="$(printf '%s' "$cfg" | sed -n 's/.*"license":{[^}]*"enforced":\(true\|false\).*/\1/p')"
  LIC_STATE="$(printf '%s' "$cfg" | sed -n 's/.*"license":{[^}]*"state":"\([a-z_]*\)".*/\1/p')"
}

verify_license_gate() { # kurulumdan sonra: lisanssız uygulamanın iş uçlarını kapattığını doğrular
  local base="$1" code
  read_license_state "$base"
  if [[ "$LIC_ENFORCED" != true ]]; then
    warn "DİKKAT: lisans denetimi AÇIK görünmüyor ($base/api/public-config). Üretim kurulumunda denetim her zaman açık olmalı; kiti/imajı satıcıdan yeniden alın."
    return 0
  fi
  if [[ "$LIC_STATE" == unlicensed ]]; then
    code="$(curl -sS --max-time 8 -o /dev/null -w '%{http_code}' "$base/api/accounts" 2>/dev/null || true)"
    if [[ "$code" == 402 ]]; then okm "Lisans kapısı doğrulandı: lisans etkinleştirilmedikçe uygulama iş uçlarını açmıyor (HTTP 402)"
    else warn "Lisanssız kurulumda iş ucu 402 yerine $code döndü; lisans kapısı beklenen gibi çalışmıyor."; fi
  fi
}

activate_license() { # kurulumdan sonra, kod girildiyse etkinleştirir (kod asla yazdırılmaz)
  local base="$1" tmp http msg
  [[ -n "$LICENSE_CODE" ]] || return 0
  if [[ "$LIC_STATE" != unlicensed ]]; then info "Lisans zaten etkin ya da kısıtlı ($LIC_STATE); kod kullanılmadı."; return 0; fi
  info "Lisans etkinleştiriliyor…"
  tmp="$(mktemp)"
  http="$(printf '{"code":"%s"}' "$LICENSE_CODE" | curl -sS --max-time 60 -o "$tmp" -w '%{http_code}' -H 'content-type: application/json' --data-binary @- "$base/api/license/activate" 2>/dev/null || true)"
  if [[ "$http" == 200 ]]; then LICENSE_ACTIVATED=yes; okm "Lisans etkinleştirildi"
  else
    msg="$(sed -n 's/.*"message":"\([^"]*\)".*/\1/p' "$tmp" | head -n1)"
    warn "Lisans etkinleştirilemedi (HTTP ${http:-?}): ${msg:-bilinmeyen hata}. Tarayıcıda açılışta çıkan 'Lisans etkinleştirme' sayfasından tekrar deneyebilirsiniz."
  fi
  rm -f "$tmp"
  read_license_state "$base"
}

lic_text() {
  case "${LIC_STATE:-}" in
    active) echo "etkin" ;;
    grace) echo "etkin (tolerans süresinde: lisans sunucusuna ulaşılamıyor)" ;;
    restricted) echo "kısıtlı (salt-okunur): lisansı yenileyin/yeniden etkinleştirin" ;;
    unlicensed) echo "ETKİNLEŞTİRİLMEDİ — uygulama lisans kodu girilmeden çalışmaz (açılışta 'Lisans etkinleştirme' ekranı)" ;;
    *) echo "bilinmiyor" ;;
  esac
}

seed_demo_native() { as_root env ALLOW_DEMO=true "$PREFIX/current/app/runtime/node" "--env-file=$ETC/erp.env" "$PREFIX/current/app/dist/demo.js" seed; }
seed_demo_docker() { ( cd "$ROOT" && docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env exec -T -e ALLOW_DEMO=true app node dist/demo.js seed ); }

# ---- Özet ekranı -------------------------------------------------------------------------------------------------------------
print_summary() { # print_summary ADRES
  local url="$1" envf; envf="$(env_file)"
  stage "Hazır"
  say "  Adres:            $url"
  say "  Kurulum:          prod / $PATH_CHOICE — erişim: $ACCESS, HTTPS: ${TLS_MODE:-none}"
  if [[ "$DEMO" == yes && ( $SEEDED_DEMO -eq 1 || "${CUR[DEMO_SEEDED]:-}" == yes ) ]]; then
    say "  Veri:             DEMO verisi yüklü — giriş: demo@ornek.local / Demo-Sifre-123 (yalnızca deneme; gerçek veri girmeyin)"
  else say "  Veri:             boş uygulama (demo/örnek veri yok)"; fi
  say "  Lisans:           $(lic_text)"
  if [[ "$MAIL_ENABLED" == yes ]]; then say "  E-posta:          açık ($SMTP_HOST:$SMTP_PORT, $SMTP_SECURITY)"; else say "  E-posta:          kapalı (parola sıfırlama: yönetici komutuyla, OPERATIONS §4)"; fi
  say "  Yedek:            her gün ${BACKUP_TIME:-02:30} → ${BACKUP_DIR:-?} (son ${BACKUP_KEEP:-14})"
  say "  Ayar dosyaları:   $envf (gizli; yedekleyin)  ·  $(conf_file)"
  if [[ "$PATH_CHOICE" == native ]]; then say "  Günlükler:        erpctl logs  ($VARDIR/logs)  ·  Yeniden yapılandırma: sudo erp-setup --reconfigure"
  else say "  Günlükler:        docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env logs app  ·  Yeniden yapılandırma: ./install.sh --reconfigure"; fi
  say ""
  say "  İlk giriş:"
  if [[ "$LIC_STATE" == unlicensed ]]; then say "   1) Tarayıcıda adresi açın → 'Lisans etkinleştirme' ekranına satıcıdan aldığınız kodu girin."; fi
  if [[ "$DEMO" == yes ]]; then say "   • Demo hesabıyla girin (yukarıda)."
  else say "   • 'Kayıt ol' ile ilk kuruluş, şirket ve sahip hesabını oluşturun (e-posta + güçlü parola)."; fi
  if [[ "$REGISTRATION" == yes ]]; then say "   • İlk sahip hesabı açılınca kaydı kapatın: ./install.sh --reconfigure (\"Yeni kayıt açık olsun mu?\" → h)."; fi
  if [[ "$TLS_MODE" == selfsigned ]]; then
    say ""
    say "  Kendi imzalı sertifika — istemcilerde güvenilir yapmak için:"
    if (( SELF_SIGNED_INTERNAL )); then say "   Kök sertifikayı alın: docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env --profile tls cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt"
    else say "   Dosya: $ROOT/deploy/certs/fullchain.pem (yalnızca bu dosyayı dağıtın; .key dosyasını ASLA paylaşmayın)"; fi
    say "   Linux: sudo cp dosya.crt /usr/local/share/ca-certificates/muhasebe-erp.crt && sudo update-ca-certificates"
    say "   Windows (yönetici): certutil -addstore -f Root dosya.crt     ·    Tarayıcı: sertifikayı 'Güvenilen Kök Sertifika Yetkilileri'ne ekleyin"
  fi
  say ""
  say "  Not: Bu yazılımın ürettiği fatura, irsaliye, bordro ve defter çıktıları resmî belge yerine geçmez; yasal oran/değerler doğrulanmamıştır"
  say "  (mali müşavirle teyit edin: docs/LEGAL-NOTES.md). E-posta SPF/DKIM/DMARC kayıtları alan adınızda sizin işinizdir."
  if [[ -n "$ANSWERS_FILE" ]] && grep -qE '^(SMTP_PASSWORD|LICENSE_CODE)=.+' "$ANSWERS_FILE" 2>/dev/null; then
    say ""; warn "Yanıt dosyasında parola/kod var: $ANSWERS_FILE dosyasını şimdi silin."
  fi
}

# ---- Kuru çalıştırma -----------------------------------------------------------------------------------------------------
dry_run_report() {
  stage "Kuru çalıştırma — sistemde hiçbir şey değiştirilmedi"
  say "  Planlanan yapılandırma:"
  print_settings
  say ""
  if [[ "$MODE" == prod ]]; then
    local target="$PATH_CHOICE"
    build_env_changes "$target"
    say "  $(env_file) — yazılacak/güncellenecek ayarlar (gizli değerler maskeli; rastgele parolalar kurulumda üretilir):"
    printf '%s\n' "${CHG[@]}" | sed -E 's/^-(.*)$/(silinir) \1/' | mask_env | sed 's/^/    /'
    if [[ "$TLS_MODE" != none && "$target" == docker ]]; then
      say "  deploy/Caddyfile.local:"
      render_caddyfile "$TLS_MODE" "$ACME_EMAIL" "$HTTPS_PORT" "$([[ "$TLS_MODE" == byo ]] && echo yes || echo no)" | sed 's/^/    /'
      [[ "$TLS_MODE" == byo ]] && say "  deploy/certs/fullchain.pem (644) ve privkey.pem (600) kopyalanır (anahtar içeriği gösterilmez)"
      [[ "$TLS_MODE" == selfsigned ]] && say "  deploy/certs/ altında kendi imzalı sertifika üretilir (openssl)"
    fi
    say "  Yedek: her gün $BACKUP_TIME, $BACKUP_DIR, son $BACKUP_KEEP"
    say "  Durum dosyası: $(conf_file) (gizli bilgi içermez)"
  else
    say "  Geliştirme: .env, npm bağımlılıkları, migration$([[ "$DEMO" == yes ]] && echo ', demo verisi')"
  fi
}

# ---- Yeniden yapılandırma ------------------------------------------------------------------------------------------------
restart_and_verify() { # 0 başarılı
  local port="$1" dc
  if [[ "$PATH_CHOICE" == native ]]; then
    if (( HAS_SYSTEMD )); then as_root systemctl restart "$SVC_NAME" || true; else as_root "$PREFIX/bin/erpctl" restart >/dev/null || true; fi
  else
    dc=(docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env)
    if [[ "${CUR[TLS_MODE]:-none}" != none && "$TLS_MODE" == none ]]; then ( cd "$ROOT" && "${dc[@]}" --profile tls rm -sf caddy >/dev/null 2>&1 || true ); fi
    local prof=(); [[ "$TLS_MODE" != none ]] && prof=(--profile tls)
    ( cd "$ROOT" && "${dc[@]}" "${prof[@]}" up -d >/dev/null )
  fi
  wait_ready "http://127.0.0.1:$port/api/health/ready" 120
}

reconfigure_main() {
  [[ "$MODE" == prod ]] || die "--reconfigure yalnızca müşteri (prod) kurulumları içindir"
  detect_existing
  (( EXISTING )) || die "Kurulu bir sistem bulunamadı (önce ./install.sh ile kurun). Aranan: $ETC/erp.env ve $ROOT/deploy/.env"
  PATH_CHOICE="$EXISTING_PATH"
  stage "Yeniden yapılandırma ($PATH_CHOICE)"
  info "Yalnızca ayarlar sorulur (e-posta, HTTPS/sertifika, yedek, lisans adresi, kayıt). Uygulama sürümü, veritabanı ve veriler değişmez."
  can_root || die "Yeniden yapılandırma yönetici yetkisi ister (sudo bulunamadı)"
  PORT="${PORT:-${CUR[PORT]:-3000}}"
  DEMO="no"
  ask_access
  configure_tls
  configure_mail
  configure_license
  configure_backup
  configure_registration
  [[ -z "$MAIL_FROM_VALUE" && "$MAIL_ENABLED" == yes ]] && MAIL_FROM_VALUE="$(mail_from_value "$MAIL_FROM_ADDRESS" "$MAIL_FROM_NAME")"
  BASE_URL_VALUE="${BASE_URL_VALUE:-$(derive_base_url)}"
  section "Özet"
  print_settings >&2
  if (( OPT_DRYRUN )); then dry_run_report; exit 0; fi
  confirm "Bu ayarlar uygulansın mı? (eski ayarlar yedeklenir, uygulama yeniden başlatılır)" || die "Vazgeçildi (hiçbir şey değiştirilmedi)"

  local envf conf own="" mode=600 cad=""
  envf="$(env_file)"; conf="$(conf_file)"
  [[ "$PATH_CHOICE" == native ]] && { own="root:$SVC_USER"; mode=640; } || cad="$ROOT/deploy/Caddyfile.local"
  backup_config "$envf" "$conf" ${cad:+"$cad"}
  snapshot_backup_units
  build_env_changes "$PATH_CHOICE"
  rd "$envf" | env_apply "${CHG[@]}" | install_file "$envf" "$mode" "$own"
  okm "Ayar dosyası güncellendi: $envf"
  apply_tls_files
  [[ "$PATH_CHOICE" == native ]] && migrate_native_backup_dir
  write_wizard_conf
  if [[ "$PATH_CHOICE" == native ]]; then write_backup_tool; else install_backup_docker; fi
  if ! restart_and_verify "$PORT"; then
    warn "Uygulama yeni ayarlarla hazır olmadı; eski ayarlar ve yedek zamanlaması geri yükleniyor…"
    local f
    for f in "$envf" "$conf" ${cad:+"$cad"}; do fexists "$f.bak-$WIZARD_TS" && sh_w cp -p "$f.bak-$WIZARD_TS" "$f"; done
    restore_backup_units
    CUR[TLS_MODE]="$TLS_MODE"; restart_and_verify "${CUR[PORT]:-$PORT}" || true
    die "Yeniden yapılandırma başarısız; önceki ayarlar geri yazıldı (yedek: $envf.bak-$WIZARD_TS). Günlüğe bakın: $([[ "$PATH_CHOICE" == native ]] && echo 'erpctl logs' || echo 'docker compose … logs app')"
  fi
  drop_backup_unit_snapshots
  okm "Uygulama yeni ayarlarla çalışıyor"
  local base="http://127.0.0.1:$PORT"
  verify_license_gate "$base"; activate_license "$base"
  if [[ "$MAIL_ENABLED" == yes && "$(curl -fsS --max-time 8 "$base/api/public-config" 2>/dev/null | sed -n 's/.*"mailEnabled":\(true\|false\).*/\1/p')" == true ]]; then okm "E-posta etkin (public-config: mailEnabled)"; fi
  if (( MAIL_TEST_DEFERRED )) && [[ -n "$MAIL_TEST_TO" ]]; then mail_test_container "$MAIL_TEST_TO" || warn "Test e-postası gönderilemedi (yukarıya bakın)."; fi
  [[ -f "$ROOT/kit.json" || -L "$PREFIX/current" ]] && update_updater_config
  local url
  case "$TLS_MODE" in none) url="$([[ $ACCESS == lan ]] && echo "http://$(lan_ip):$PORT" || echo "http://localhost:$PORT")" ;; *) url="$BASE_URL_VALUE"; [[ -z "$url" ]] && url="https://$DOMAIN" ;; esac
  print_summary "$url"
}

update_updater_config() { # güncelleyicinin yeniden kurulum bayrakları yeni erişim ayarlarıyla uyumlu kalsın
  if (( KIT )); then install_updater "$PATH_CHOICE" "$(env_file)" >/dev/null 2>&1 || true; fi
}
