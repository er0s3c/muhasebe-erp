# shellcheck shell=bash
# =====================================================================================================================
# Muhasebe ERP kurulum sihirbazı — yapılandırma kitaplığı (Linux/WSL). install.sh tarafından `source` edilir.
#
# İçerik: yanıt dosyası (KEY=VALUE) ayrıştırıcı, doğrulayıcılar, soru yardımcıları, ortam dosyası düzenleyici, Caddy dosyası
# üretici, SMTP adresi üretici, sertifika doğrulama. Doğrulayıcılar bir hata varsa nedenini stdout'a yazar ve 1 döner.
# Beklenen dış işlevler (install.sh sağlar): die warn info okm say, değişkenler OPT_YES ANSWERS_FILE C_DIM C_0.
# Anahtar adları install.ps1 ile aynıdır; belge: docs/OPERATIONS.md §2.
# =====================================================================================================================

# ---- Yanıt dosyası ------------------------------------------------------------------------------------------------------
ANSWER_KEYS="MODE INSTALL_PATH ACCESS DOMAIN PORT DEMO REGISTRATION LICENSE_SERVER_URL LICENSE_CODE MAIL_ENABLED SMTP_HOST SMTP_PORT \
SMTP_SECURITY SMTP_USER SMTP_PASSWORD MAIL_FROM_ADDRESS MAIL_FROM_NAME MAIL_TEST_TO APP_BASE_URL TLS_MODE ACME_EMAIL CERT_FILE KEY_FILE \
HTTP_PORT HTTPS_PORT BACKUP_DIR BACKUP_KEEP BACKUP_TIME"
SECRET_KEYS="SMTP_PASSWORD LICENSE_CODE"

answer_var() { # yanıt anahtarı → kabuk değişkeni (INSTALL_PATH, PATH ile karışmasın diye PATH_CHOICE olur)
  if [[ "$1" == INSTALL_PATH ]]; then printf 'PATH_CHOICE'; else printf '%s' "$1"; fi
}

# load_answers DOSYA — KEY=VALUE satırlarını okur. Hiçbir şey çalıştırılmaz/genişletilmez (eval yok). Komut satırı bayrakları dosyadan önceliklidir.
load_answers() {
  local f="$1" line key val n=0 var perm secret=0 k
  local -A from_file=()
  [[ -f "$f" ]] || die "Yanıt dosyası bulunamadı: $f"
  while IFS= read -r line || [[ -n "$line" ]]; do
    n=$((n + 1))
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    [[ -z "$line" || "${line:0:1}" == "#" ]] && continue
    [[ "$line" == *=* ]] || die "Yanıt dosyası $n. satır: 'ANAHTAR=değer' biçimi bekleniyor"
    key="${line%%=*}"; val="${line#*=}"
    key="${key%"${key##*[![:space:]]}"}"
    val="${val#"${val%%[![:space:]]*}"}"; val="${val%"${val##*[![:space:]]}"}"
    if [[ "$val" =~ ^\"([^\"]*)\"([[:space:]]+#.*)?$ || "$val" =~ ^\'([^\']*)\'([[:space:]]+#.*)?$ ]]; then val="${BASH_REMATCH[1]}"
    else val="${val%%[[:space:]]#*}"; val="${val%"${val##*[![:space:]]}"}"; fi
    case " $ANSWER_KEYS " in *" $key "*) ;; *) die "Yanıt dosyası $n. satır: bilinmeyen anahtar '$key' (geçerli anahtarlar: docs/OPERATIONS.md §2)" ;; esac
    var="$(answer_var "$key")"
    [[ -z "$val" ]] && continue
    if [[ -n "${!var:-}" && -z "${from_file[$var]:-}" ]]; then continue; fi
    printf -v "$var" '%s' "$val"
    from_file[$var]=1
  done < "$f"
  for k in $SECRET_KEYS; do [[ -n "${!k:-}" ]] && secret=1; done
  if (( secret )); then warn "Yanıt dosyasında parola/kod var: kurulum bitince dosyayı SİLİN (sihirbaz onu hiçbir yere kopyalamaz)."; fi
  perm="$(stat -c %a "$f" 2>/dev/null || true)"
  if [[ -n "$perm" && "$perm" =~ [0-7][0-7][1-7]$ || "$perm" =~ [0-7][1-7][0-7]$ ]]; then warn "Yanıt dosyası başkaları tarafından okunabilir ($perm); 'chmod 600 $f' önerilir."; fi
  return 0
}

# ---- Doğrulayıcılar (hata nedeni stdout, durum 1) ---------------------------------------------------------------------------
v_ok() { return 0; }
v_port() {
  [[ "$1" =~ ^[0-9]{1,5}$ ]] && (( 10#$1 >= 1 && 10#$1 <= 65535 )) && return 0
  printf 'port 1-65535 arasında bir sayı olmalı'; return 1
}
v_email() {
  [[ "$1" =~ ^[^[:space:]@\"\<\>,\;\']+@[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$ ]] && return 0
  printf "geçerli bir e-posta adresi yazın (örn. ad@firma.com)"; return 1
}
v_email_opt() { [[ -z "$1" ]] && return 0; v_email "$1"; }
v_fqdn() {
  (( ${#1} <= 253 )) && [[ "$1" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$ ]] && return 0
  printf 'geçerli bir alan adı yazın (örn. erp.firmaniz.com)'; return 1
}
v_ipv4() {
  local IFS=. o; local -a p
  [[ "$1" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || return 1
  read -ra p <<< "$1"
  for o in "${p[@]}"; do (( 10#$o <= 255 )) || return 1; done
  return 0
}
v_host() { # alan adı, IPv4 ya da tek etiketli ağ adı (LAN)
  v_fqdn "$1" >/dev/null && return 0
  v_ipv4 "$1" && return 0
  [[ "$1" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$ ]] && return 0
  printf 'alan adı, bilgisayar adı ya da IP adresi yazın (örn. erp.firmaniz.com ya da 192.168.1.20)'; return 1
}
v_time() {
  [[ "$1" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] && return 0
  printf 'saati SS:DD biçiminde yazın (örn. 02:30)'; return 1
}
v_keep() {
  [[ "$1" =~ ^[0-9]{1,3}$ ]] && (( 10#$1 >= 1 )) && return 0
  printf 'saklanacak yedek sayısı 1 ile 999 arasında olmalı'; return 1
}
v_abs_path() {
  [[ "$1" =~ ^/[^[:cntrl:]\"\']*$ ]] && return 0
  printf 'tam yol yazın (/ ile başlamalı; tırnak ve denetim karakteri içermemeli)'; return 1
}
v_license_url() {
  [[ -z "$1" ]] && return 0
  if [[ "$1" =~ ^https://[^/[:space:]]+(/[^[:space:]]*)?$ ]]; then return 0; fi
  if [[ "$1" == http://* ]]; then printf 'üretimde lisans sunucusu adresi https:// ile başlamalı'; else printf 'adres https://lisans.firma.com biçiminde olmalı'; fi
  return 1
}
v_license_code() {
  [[ -z "$1" ]] && return 0
  [[ "$1" =~ ^[A-Za-z0-9]{5}(-[A-Za-z0-9]{5}){4}$ ]] && return 0
  printf 'kod XXXXX-XXXXX-XXXXX-XXXXX-XXXXX biçiminde olmalı (25 karakter, 5 grup)'; return 1
}
v_security() {
  case "$1" in ssl|starttls|none) return 0 ;; esac
  printf 'ssl (465), starttls (587) ya da none seçin'; return 1
}
v_display_name() {
  [[ "$1" =~ ^[^\"\$\`\\\<\>[:cntrl:]]{0,80}$ ]] && return 0
  printf 'ad en çok 80 karakter olmalı; tırnak, $, ters bölü, < > içeremez'; return 1
}
v_smtp_user() { [[ "$1" =~ ^[^[:cntrl:]]{0,200}$ ]] && return 0; printf 'geçersiz karakter'; return 1; }
v_smtp_pass() { [[ "$1" =~ ^[^[:cntrl:]]{0,200}$ ]] && return 0; printf 'geçersiz karakter'; return 1; }
v_base_url() {
  [[ "$1" =~ ^https?://[^/[:space:]]+$ ]] && return 0
  printf 'adres http:// ya da https:// ile başlamalı, sonunda / olmamalı (örn. https://erp.firmaniz.com)'; return 1
}
v_dir_opt() { [[ -z "$1" ]] && return 0; v_abs_path "$1"; }
v_file_exists() {
  [[ -n "$1" && -f "$1" && -r "$1" ]] && return 0
  printf 'dosya bulunamadı ya da okunamıyor'; return 1
}

norm_yn() { # evet/hayır eşanlamlıları → yes|no (boş: hata)
  case "${1,,}" in e|evet|y|yes|true|1|on) printf yes ;; h|hayır|hayir|n|no|false|0|off) printf no ;; *) return 1 ;; esac
}

# ---- Soru yardımcıları ------------------------------------------------------------------------------------------------------
INTERACTIVE=0 INPUT_EOF=0
init_input() { # etkileşim kipini bir kez, ana kabukta belirler (ask() alt kabukta çalışır)
  INTERACTIVE=0
  (( OPT_YES )) && return 0
  [[ -n "${ANSWERS_FILE:-}" ]] && return 0
  if [[ -n "${ERP_WIZARD_INPUT:-}" ]]; then # sınama: girdiyi dosyadan okur
    if [[ -r "$ERP_WIZARD_INPUT" ]]; then exec 8< "$ERP_WIZARD_INPUT"; INTERACTIVE=1; fi
    return 0
  fi
  if { : < /dev/tty; } 2>/dev/null; then exec 8< /dev/tty; INTERACTIVE=1; fi
  return 0
}
interactive() { (( INTERACTIVE )) && (( ! INPUT_EOF )); }

prompt_line() { # prompt_line "metin" [gizli] → REPLY_VAL
  REPLY_VAL=""
  printf '%s' "$1" >&2
  if [[ -n "${2:-}" && -z "${ERP_WIZARD_INPUT:-}" ]]; then
    IFS= read -rs -u 8 REPLY_VAL || { INPUT_EOF=1; REPLY_VAL=""; }
    printf '\n' >&2
  else
    IFS= read -r -u 8 REPLY_VAL || { INPUT_EOF=1; REPLY_VAL=""; }
  fi
  REPLY_VAL="${REPLY_VAL%$'\r'}"
}

help_line() { [[ -n "$1" ]] && printf '  %s%s%s\n' "${C_DIM:-}" "$1" "${C_0:-}" >&2; return 0; }

# ask_val DEĞİŞKEN "Soru" "tek satır açıklama" "varsayılan" doğrulayıcı [gizli]
# Değişken önceden doluysa (bayrak/yanıt dosyası) sorulmaz, yalnızca doğrulanır. Etkileşimsiz kipte varsayılan alınır.
ask_val() {
  local var="$1" q="$2" help="$3" def="$4" check="$5" secret="${6:-}" cur msg shown
  cur="${!var:-}"
  if [[ -n "$cur" ]]; then
    msg="$($check "$cur")" || die "$q geçersiz: $msg"
    return 0
  fi
  if ! interactive; then
    cur="$def"
    msg="$($check "$cur")" || die "$q için değer gerekli ($msg); yanıt dosyasına ya da bayrağa ekleyin"
    printf -v "$var" '%s' "$cur"; return 0
  fi
  help_line "$help"
  while :; do
    shown=""; [[ -n "$def" && -z "$secret" ]] && shown=" [$def]"
    prompt_line "$q$shown: " "$secret"
    cur="${REPLY_VAL:-$def}"
    if msg="$($check "$cur")"; then printf -v "$var" '%s' "$cur"; return 0; fi
    printf '  %s✗ %s%s\n' "${C_FAIL:-}" "$msg" "${C_0:-}" >&2
    if (( INPUT_EOF )); then die "$q: geçerli değer girilmedi"; fi
  done
}

# ask_yn DEĞİŞKEN "Soru" "açıklama" yes|no  → değişken yes|no olur. İstem: [h/E] (varsayılan evet) ya da [e/H]
ask_yn() {
  local var="$1" q="$2" help="$3" def="$4" cur n suffix
  cur="${!var:-}"
  if [[ -n "$cur" ]]; then n="$(norm_yn "$cur")" || die "$q: 'evet' ya da 'hayır' yazın ($cur)"; printf -v "$var" '%s' "$n"; return 0; fi
  if ! interactive; then printf -v "$var" '%s' "$def"; return 0; fi
  help_line "$help"
  [[ "$def" == yes ]] && suffix="[h/E]" || suffix="[e/H]"
  while :; do
    prompt_line "$q $suffix: "
    if [[ -z "$REPLY_VAL" ]]; then printf -v "$var" '%s' "$def"; return 0; fi
    if n="$(norm_yn "$REPLY_VAL")"; then printf -v "$var" '%s' "$n"; return 0; fi
    printf '  %s✗ e (evet) ya da h (hayır) yazın%s\n' "${C_FAIL:-}" "${C_0:-}" >&2
    if (( INPUT_EOF )); then die "$q: yanıt alınamadı"; fi
  done
}

# ask_choice DEĞİŞKEN "Soru" "açıklama" varsayılan seçenek...
ask_choice() {
  local var="$1" q="$2" help="$3" def="$4" o cur ans; shift 4
  cur="${!var:-}"
  if [[ -n "$cur" ]]; then
    for o in "$@"; do [[ "$o" == "$cur" ]] && return 0; done
    die "$q: '$cur' geçersiz (seçenekler: $(IFS=/; echo "$*"))"
  fi
  if ! interactive; then printf -v "$var" '%s' "$def"; return 0; fi
  help_line "$help"
  while :; do
    prompt_line "$q [$def] ($(IFS=/; echo "$*")): "
    ans="${REPLY_VAL:-$def}"
    for o in "$@"; do [[ "$o" == "$ans" ]] && { printf -v "$var" '%s' "$ans"; return 0; }; done
    printf '  %s✗ şunlardan birini yazın: %s%s\n' "${C_FAIL:-}" "$(IFS=/; echo "$*")" "${C_0:-}" >&2
    if (( INPUT_EOF )); then die "$q: yanıt alınamadı"; fi
  done
}

# ---- Ortam dosyası düzenleme ------------------------------------------------------------------------------------------------
# env_apply ANAHTAR=değer ... -ANAHTAR ...   stdin: eski içerik, stdout: yeni içerik. Aynı anahtarın tekrarları tek satıra iner.
env_apply() {
  local -A setv=() unsetv=() seen=()
  local -a order=() lines=()
  local a line k
  for a in "$@"; do
    if [[ "$a" == -* ]]; then unsetv["${a#-}"]=1
    else k="${a%%=*}"; setv[$k]="${a#*=}"; order+=("$k"); fi
  done
  while IFS= read -r line || [[ -n "$line" ]]; do lines+=("$line"); done
  for line in "${lines[@]}"; do
    if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)= ]]; then
      k="${BASH_REMATCH[1]}"
      if [[ -n "${unsetv[$k]:-}" ]]; then continue; fi
      if [[ -n "${setv[$k]+x}" ]]; then
        [[ -n "${seen[$k]:-}" ]] && continue
        printf '%s=%s\n' "$k" "${setv[$k]}"; seen[$k]=1; continue
      fi
    fi
    printf '%s\n' "$line"
  done
  for k in "${order[@]}"; do
    [[ -n "${seen[$k]:-}" || -n "${unsetv[$k]:-}" ]] && continue
    printf '%s=%s\n' "$k" "${setv[$k]}"; seen[$k]=1
  done
}

env_value() { # env_value ANAHTAR  (stdin: dosya içeriği) — son tanım, çevreleyen tırnaklar atılır
  local line v="" k="$1"
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" == "$k="* ]] && v="${line#*=}"
  done
  if [[ "$v" =~ ^\"(.*)\"$ || "$v" =~ ^\'(.*)\'$ ]]; then v="${BASH_REMATCH[1]}"; fi
  printf '%s' "$v"
}

mask_env() { # stdin → stdout: gizli değerleri maskeler
  sed -E -e 's#^((POSTGRES|ERP_OWNER|ERP_APP)_PASSWORD|JWT_SECRET|ERP_UPDATER_TOKEN|[A-Z_]*(PASSWORD|SECRET|TOKEN))=.*#\1=********#' \
    -e 's#^(SMTP_URL=[a-z]+://[^:/@]*:)[^@]*@#\1********@#' -e 's#^(MIGRATION_DATABASE_URL|DATABASE_URL)=(postgres://[^:]*:)[^@]*@#\1=\2********@#'
}

urlenc() { # yüzde kodlama: yalnızca A-Za-z0-9-_.~ olduğu gibi kalır (Node/PowerShell yardımcılarıyla aynı)
  local s="$1" out="" c i
  local LC_ALL=C
  for (( i = 0; i < ${#s}; i++ )); do
    c="${s:i:1}"
    case "$c" in [A-Za-z0-9._~-]) out+="$c" ;; *) out+="$(printf '%%%02X' "'$c")" ;; esac
  done
  printf '%s' "$out"
}

# smtp_url SUNUCU PORT ssl|starttls|none [KULLANICI [PAROLA]] → SMTP_URL
smtp_url() {
  local host="$1" port="$2" sec="$3" user="${4:-}" pass="${5:-}" scheme=smtp auth="" q=""
  case "$sec" in ssl) scheme=smtps ;; starttls) q="?requireTLS=true" ;; none) q="?ignoreTLS=true" ;; *) return 1 ;; esac
  [[ -n "$user" ]] && auth="$(urlenc "$user"):$(urlenc "$pass")@"
  printf '%s://%s%s:%s%s' "$scheme" "$auth" "$host" "$port" "$q"
}

mail_from_value() { # MAIL_FROM: ad varsa "Ad <adres>" (çift tırnaklı), yoksa yalnızca adres
  if [[ -n "${2:-}" ]]; then printf '"%s <%s>"' "$2" "$1"; else printf '%s' "$1"; fi
}

# ---- Caddy -----------------------------------------------------------------------------------------------------------------
# render_caddyfile TLS_MODE ACME_EMAIL HTTPS_PORT DOSYALI(yes|no)   → Caddyfile içeriği (alan adı ERP_DOMAIN ortamından gelir)
render_caddyfile() {
  local mode="$1" email="$2" hport="$3" files="$4"
  printf '# Kurulum sihirbazı tarafından üretildi (%s). Elle değiştirmeyin: ./install.sh --reconfigure ile yeniden üretilir.\n' "$(date -Iseconds)"
  if { [[ "$mode" == auto && -n "$email" ]] || [[ "$hport" != 443 ]]; }; then
    printf '{\n'
    [[ "$mode" == auto && -n "$email" ]] && printf '\temail %s\n' "$email"
    [[ "$hport" != 443 ]] && printf '\tauto_https disable_redirects\n'
    printf '}\n'
  fi
  printf '{$ERP_DOMAIN} {\n'
  case "$mode" in
    byo) printf '\ttls /etc/caddy/certs/fullchain.pem /etc/caddy/certs/privkey.pem\n' ;;
    selfsigned) if [[ "$files" == yes ]]; then printf '\ttls /etc/caddy/certs/fullchain.pem /etc/caddy/certs/privkey.pem\n'; else printf '\ttls internal\n'; fi ;;
  esac
  printf '\tencode zstd gzip\n\treverse_proxy app:3000\n}\n'
}

# ---- Sertifika doğrulama (openssl) --------------------------------------------------------------------------------------------
# cert_check_openssl SERTİFİKA ANAHTAR [ALAN] → "HATA …"/"UYARI …"/"BİLGİ …" satırları; durum 0 = hata yok
cert_check_openssl() {
  local cert="$1" key="$2" domain="${3:-}" errs=0 n i pub1 pub2 tmp subj end
  command -v openssl >/dev/null || { echo "HATA openssl bulunamadı"; return 1; }
  [[ -r "$cert" ]] || { echo "HATA Sertifika dosyası okunamıyor: $cert"; return 1; }
  [[ -r "$key" ]] || { echo "HATA Anahtar dosyası okunamıyor"; return 1; }
  if ! openssl x509 -in "$cert" -noout >/dev/null 2>&1; then
    echo "HATA Sertifika okunamadı: dosya PEM (Base64, BEGIN CERTIFICATE) biçiminde olmalı; .pfx/.p12 ise önce PEM'e çevirin"; return 1
  fi
  if grep -q 'PRIVATE KEY' "$cert"; then echo "HATA Sertifika dosyasının içinde özel anahtar var: yalnızca sertifika (ve zincir) dosyasını verin"; errs=1; fi
  if grep -qE 'ENCRYPTED PRIVATE KEY|ENCRYPTED' "$key"; then echo "HATA Özel anahtar parola ile korunuyor; sunucu otomatik açamaz (parolasız anahtar gerekir)"; return 1; fi
  subj="$(openssl x509 -in "$cert" -noout -subject 2>/dev/null | sed 's/^subject= *//')"
  end="$(openssl x509 -in "$cert" -noout -enddate 2>/dev/null | sed 's/^notAfter=//')"
  echo "BİLGİ Sertifika: $subj; geçerlilik sonu $end"
  pub1="$(openssl x509 -in "$cert" -noout -pubkey 2>/dev/null | openssl sha256 2>/dev/null)"
  pub2="$(openssl pkey -in "$key" -pubout 2>/dev/null | openssl sha256 2>/dev/null)"
  if [[ -z "$pub2" ]]; then echo "HATA Özel anahtar okunamadı (PEM biçiminde, parolasız olmalı)"; errs=1
  elif [[ "$pub1" != "$pub2" ]]; then echo "HATA Özel anahtar bu sertifikaya ait değil (ortak anahtarlar uyuşmuyor)"; errs=1; fi
  if ! openssl x509 -in "$cert" -noout -checkend 0 >/dev/null 2>&1; then echo "HATA Sertifikanın süresi dolmuş ($end)"; errs=1
  elif ! openssl x509 -in "$cert" -noout -checkend $((14 * 86400)) >/dev/null 2>&1; then echo "UYARI Sertifikanın bitişine 14 günden az kaldı ($end)"; fi
  if [[ -n "$domain" ]]; then
    if v_ipv4 "$domain"; then
      openssl x509 -in "$cert" -noout -checkip "$domain" 2>/dev/null | grep -q 'does match' || { echo "HATA Sertifika $domain IP adresini kapsamıyor"; errs=1; }
    else
      openssl x509 -in "$cert" -noout -checkhost "$domain" 2>/dev/null | grep -q 'does match' || { echo "HATA Sertifika \"$domain\" adını kapsamıyor"; errs=1; }
    fi
  fi
  # Zincir sırası: yaprak ilk; her sertifikayı bir sonraki imzalamalı
  tmp="$(mktemp -d)"
  awk -v d="$tmp" '/-----BEGIN CERTIFICATE-----/{n++; f=sprintf("%s/c%03d.pem", d, n)} n{print > f}' "$cert"
  n="$(find "$tmp" -name 'c*.pem' | wc -l)"
  for (( i = 1; i < n; i++ )); do
    if ! openssl verify -no_check_time -partial_chain -trusted "$(printf '%s/c%03d.pem' "$tmp" $((i + 1)))" "$(printf '%s/c%03d.pem' "$tmp" "$i")" >/dev/null 2>&1; then
      echo "HATA Zincir sırası yanlış: $i. sertifikayı $((i + 1)). sertifika imzalamıyor (dosya \"yaprak, ara, kök\" sırasında olmalı)"; errs=1; break
    fi
  done
  if (( n == 1 )); then
    if openssl verify -no_check_time -partial_chain -trusted "$cert" "$cert" >/dev/null 2>&1 && [[ "$(openssl x509 -in "$cert" -noout -subject_hash)" == "$(openssl x509 -in "$cert" -noout -issuer_hash)" ]]; then
      echo "UYARI Kendi imzalı sertifika: tarayıcılar uyarı gösterir; istemci bilgisayarlara güvenilir kök olarak eklenmelidir"
    else echo "UYARI Dosyada yalnızca sunucu sertifikası var, ara sertifika yok: bazı istemciler güvenmeyebilir (sağlayıcının fullchain dosyasını kullanın)"; fi
  fi
  rm -rf "$tmp"
  return $errs
}

# ---- Yedek ve zaman yardımcıları ---------------------------------------------------------------------------------------------
time_to_oncalendar() { printf '*-*-* %s:00' "$1"; }
time_to_cron() { printf '%d %d' "$((10#${1#*:}))" "$((10#${1%:*}))"; }
