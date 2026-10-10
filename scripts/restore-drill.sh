#!/usr/bin/env bash
# Geri yükleme tatbikatı: "yedeğimiz gerçekten geri yüklenebiliyor mu?" sorusunu kanıtlar.
#
#   scripts/restore-drill.sh
#
# Akış (hepsi geçici veritabanlarında; mevcut verinize dokunmaz):
#   1. Taze kaynak veritabanı → migration'lar → demo verisi (uygulama gibi erp_app rolüyle)
#   2. scripts/backup.sh ile yedek
#   3. Taze hedef veritabanı → scripts/restore.sh ile geri yükleme
#   4. Kaynak ve hedef KARŞILAŞTIRILIR: tablo satır sayıları, veri parmak izi (defter ve stok hareketleri),
#      yapı parmak izi (tetikleyiciler, RLS politikaları/bayrakları, fonksiyonlar, erp_app yetkileri)
#   5. Davranış denetimi (erp_app ile): bağlam yokken hiçbir şirket verisi görünmez, doğru bağlamla görünür;
#      değiştirilemezlik tetikleyicileri (defter ERP01, denetim kaydı ERP07) geri yüklenen veritabanında çalışır
#   6. Negatif kontrol: hedefte bir satır silinince ve RLS kapatılınca karşılaştırmanın KIRILDIĞI kanıtlanır
#      (tatbikatın kendisi sağlam değilse exit 2)
#
# Gerekenler: MIGRATION_DATABASE_URL (sahip rol; CREATEDB yetkili — geliştirme rolü öyledir), DATABASE_URL (erp_app),
# JWT_SECRET (yoksa .env okunur), pg_dump/pg_restore/psql (PostgreSQL ≥ sunucu sürümü), npm bağımlılıkları.
# Üretim sunucusunda değil, hazırlık makinesinde/CI'da çalıştırın; DRILL_ADMIN_URL ile CREATE DATABASE yapabilen
# başka bir rol verilebilir.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -z "${MIGRATION_DATABASE_URL:-}" ] || [ -z "${DATABASE_URL:-}" ] || [ -z "${JWT_SECRET:-}" ]; then
  if [ -f .env ]; then set -a; . ./.env; set +a; fi
fi
: "${MIGRATION_DATABASE_URL:?MIGRATION_DATABASE_URL gerekli}"
: "${DATABASE_URL:?DATABASE_URL gerekli}"
: "${JWT_SECRET:?JWT_SECRET gerekli}"
for tool in pg_dump pg_restore psql; do command -v "$tool" > /dev/null || { echo "$tool bulunamadı" >&2; exit 1; }; done

ID="$$"
SRC="erp_drill_src_$ID"
DST="erp_drill_dst_$ID"
OWNER_BASE="${MIGRATION_DATABASE_URL%/*}"
APP_BASE="${DATABASE_URL%/*}"
ADMIN_URL="${DRILL_ADMIN_URL:-$OWNER_BASE/postgres}"
WORK="$(mktemp -d)"

cleanup() {
  psql "$ADMIN_URL" -Atq -c "DROP DATABASE IF EXISTS \"$SRC\" WITH (FORCE)" -c "DROP DATABASE IF EXISTS \"$DST\" WITH (FORCE)" > /dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

step() { printf '\n== %s\n' "$*"; }
fail() { printf 'BAŞARISIZ: %s\n' "$*" >&2; exit 1; }
owner_url() { printf '%s/%s' "$OWNER_BASE" "$1"; }
app_url() { printf '%s/%s' "$APP_BASE" "$1"; }

createdb() {
  psql "$ADMIN_URL" -Atq -v ON_ERROR_STOP=1 \
    -c "CREATE DATABASE \"$1\" OWNER erp" \
    -c "REVOKE ALL ON DATABASE \"$1\" FROM PUBLIC" \
    -c "GRANT CONNECT ON DATABASE \"$1\" TO erp_app"
}

# Karşılaştırılacak parmak izi (sahip rolüyle; RLS sahibi etkilemez)
cat > "$WORK/fingerprint.sql" <<'SQL'
\pset tuples_only on
\pset format unaligned
select 'COUNT ' || table_schema || '.' || table_name || '=' ||
       (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text
  from information_schema.tables
 where table_schema in ('public', 'drizzle') and table_type = 'BASE TABLE'
 order by 1;
select 'DATA journal_lines=' || coalesce(md5(string_agg(id::text || ':' || debit_base::text || ':' || credit_base::text, ',' order by id)), 'boş') from journal_lines;
select 'DATA stock_movements=' || coalesce(md5(string_agg(id::text || ':' || qty::text || ':' || value::text, ',' order by id)), 'boş') from stock_movements;
select 'DATA migrations=' || coalesce(md5(string_agg(hash, ',' order by id)), 'boş') from drizzle.__drizzle_migrations;
select 'STRUCT triggers=' || count(*) || ':' || coalesce(md5(string_agg(c.relname || '.' || t.tgname, ',' order by c.relname, t.tgname)), 'boş')
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
 where not t.tgisinternal and n.nspname = 'public';
select 'STRUCT policies=' || count(*) || ':' || coalesce(md5(string_agg(tablename || ':' || policyname || ':' || coalesce(qual, '') || ':' || coalesce(with_check, ''), ',' order by tablename, policyname)), 'boş')
  from pg_policies where schemaname = 'public';
select 'STRUCT rls=' || count(*) filter (where relrowsecurity) || '/' || count(*) || ':' || md5(string_agg(relname || relrowsecurity::text || relforcerowsecurity::text, ',' order by relname))
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind = 'r' and n.nspname = 'public';
select 'STRUCT functions=' || count(*) || ':' || coalesce(md5(string_agg(proname || ':' || prosecdef::text || ':' || md5(prosrc), ',' order by proname)), 'boş')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public';
select 'STRUCT erp_app_grants=' || count(*) || ':' || coalesce(md5(string_agg(table_name || '.' || privilege_type, ',' order by table_name, privilege_type)), 'boş')
  from information_schema.role_table_grants where grantee = 'erp_app' and table_schema = 'public';
select 'STRUCT constraints=' || count(*) from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname = 'public';
select 'STRUCT indexes=' || count(*) from pg_indexes where schemaname = 'public';
SQL

fingerprint() { psql "$(owner_url "$1")" -q -v ON_ERROR_STOP=1 -f "$WORK/fingerprint.sql"; }

# Davranış denetimi (erp_app = uygulamanın çalışma zamanı rolü; RLS'e tabidir)
behavior() {
  local db="$1" org="$2" company="$3" user="$4"
  psql "$(app_url "$db")" -q -At -v ON_ERROR_STOP=1 -v org="$org" -v company="$company" -v user="$user" <<'SQL'
select 'BAĞLAMSIZ companies=' || count(*) from companies;
select 'BAĞLAMSIZ journal_lines=' || count(*) from journal_lines;
begin;
select set_config('app.org_id', :'org', true) as _ \gset
select 'ORG companies=' || count(*) from companies;
select set_config('app.company_id', :'company', true) as _ \gset
-- Şube kapsamı (0116) şirket üyesi bir kullanıcı ister; sahip bütün şubeleri görür
select set_config('app.user_id', :'user', true) as _ \gset
select 'ŞİRKET journal_lines=' || count(*) from journal_lines;
select 'ŞİRKET parties=' || count(*) from parties;
select set_config('app.company_id', '00000000-0000-7000-8000-000000000000', true) as _ \gset
select 'BAŞKA ŞİRKET journal_lines=' || count(*) from journal_lines;
rollback;
SQL
}

# Değiştirilemezlik tetikleyicileri (sahip rolüyle denenir: sahibi bile aşamaz)
immutability() {
  psql "$(owner_url "$1")" -q -At -v ON_ERROR_STOP=1 2>&1 <<'SQL'
do $$ begin
  begin
    delete from journal_entries where id = (select id from journal_entries where status = 'posted' limit 1);
    raise exception 'DEFTER_SILINEBİLDİ';
  exception when others then
    if sqlstate = 'ERP01' then raise notice 'DEFTER_KORUMASI_OK'; else raise; end if;
  end;
end $$;
do $$ begin
  begin
    update audit_log set action = action where id = (select min(id) from audit_log);
    raise exception 'DENETİM_DEĞİŞTİRİLEBİLDİ';
  exception when others then
    if sqlstate = 'ERP07' then raise notice 'DENETİM_KORUMASI_OK'; else raise; end if;
  end;
end $$;
SQL
}

step "1/6 Kaynak veritabanı: migration + demo verisi ($SRC)"
createdb "$SRC"
MIGRATION_DATABASE_URL="$(owner_url "$SRC")" DATABASE_URL="$(app_url "$SRC")" npm run --silent db:migrate -w @erp/api
MIGRATION_DATABASE_URL="$(owner_url "$SRC")" DATABASE_URL="$(app_url "$SRC")" npm run --silent db:seed -w @erp/api | sed 's/^/   /'

step "2/6 Yedek (scripts/backup.sh)"
MIGRATION_DATABASE_URL="$(owner_url "$SRC")" scripts/backup.sh --dir "$WORK/backups"
DUMP="$(ls "$WORK"/backups/erp-*.dump)"

step "3/6 Geri yükleme (scripts/restore.sh) → $DST"
createdb "$DST"
RESTORE_DATABASE_URL="$(owner_url "$DST")" scripts/restore.sh "$DUMP"

step "4/6 Karşılaştırma: satır sayıları, veri ve yapı parmak izleri"
fingerprint "$SRC" > "$WORK/fp.src"
fingerprint "$DST" > "$WORK/fp.dst"
[ "$(wc -l < "$WORK/fp.src")" -gt 40 ] || fail "parmak izi beklenenden kısa (tablolar eksik?)"
if ! diff "$WORK/fp.src" "$WORK/fp.dst"; then fail "kaynak ile geri yüklenen veritabanı farklı"; fi
echo "   $(grep -c '^COUNT ' "$WORK/fp.src") tablo, $(grep -c '^STRUCT ' "$WORK/fp.src") yapı ölçütü ve $(grep -c '^DATA ' "$WORK/fp.src") veri parmak izi birebir aynı"
grep -E '^COUNT public\.(journal_lines|parties|invoices|stock_movements|audit_log)=' "$WORK/fp.dst" | sed 's/^COUNT /   /'

step "5/6 Davranış denetimi (erp_app ile RLS, sahip rolüyle değiştirilemezlik)"
# Demo birden fazla şirket yükler (ör. üretim şirketi); defter satırı olan şirket ve onun kuruluşu seçilir
COMPANY="$(psql "$(owner_url "$SRC")" -Atq -c "select company_id from journal_lines group by company_id order by count(*) desc limit 1")"
ORG="$(psql "$(owner_url "$SRC")" -Atq -c "select organization_id from companies where id = '$COMPANY'")"
OWNER="$(psql "$(owner_url "$SRC")" -Atq -c "select user_id from memberships where company_id = '$COMPANY' and role = 'owner' limit 1")"
[ -n "$ORG" ] && [ -n "$COMPANY" ] && [ -n "$OWNER" ] || fail "demo şirketi veya sahibi bulunamadı"
behavior "$SRC" "$ORG" "$COMPANY" "$OWNER" > "$WORK/bh.src"
behavior "$DST" "$ORG" "$COMPANY" "$OWNER" > "$WORK/bh.dst"
diff "$WORK/bh.src" "$WORK/bh.dst" || fail "RLS davranışı kaynak ile farklı"
grep -q '^BAĞLAMSIZ companies=0$' "$WORK/bh.dst" || fail "bağlam yokken şirket verisi görünüyor (RLS çalışmıyor)"
grep -q '^BAĞLAMSIZ journal_lines=0$' "$WORK/bh.dst" || fail "bağlam yokken defter satırları görünüyor (RLS çalışmıyor)"
grep -q '^ORG companies=[1-9]' "$WORK/bh.dst" || fail "doğru bağlamla şirket görünmüyor"
grep -q '^ŞİRKET journal_lines=[1-9]' "$WORK/bh.dst" || fail "doğru bağlamla defter satırları görünmüyor"
grep -q '^BAŞKA ŞİRKET journal_lines=0$' "$WORK/bh.dst" || fail "başka şirketin bağlamında defter satırları görünüyor"
sed 's/^/   /' "$WORK/bh.dst"
IMM="$(immutability "$DST")"
printf '%s' "$IMM" | grep -q DEFTER_KORUMASI_OK || fail "geri yüklenen veritabanında defter koruması çalışmıyor: $IMM"
printf '%s' "$IMM" | grep -q DENETİM_KORUMASI_OK || fail "geri yüklenen veritabanında denetim kaydı koruması çalışmıyor: $IMM"
echo "   defter (ERP01) ve denetim kaydı (ERP07) tetikleyicileri geri yüklenen veritabanında çalışıyor"

step "6/6 Negatif kontrol: tatbikat gerçekten başarısız olabiliyor mu?"
psql "$(owner_url "$DST")" -Atq -v ON_ERROR_STOP=1 -c "delete from custom_codes where id = (select id from custom_codes order by id limit 1)" > /dev/null
fingerprint "$DST" > "$WORK/fp.sabotaj"
if diff -q "$WORK/fp.src" "$WORK/fp.sabotaj" > /dev/null; then echo "TATBİKAT SAĞLAM DEĞİL: silinen satır karşılaştırmada yakalanmadı" >&2; exit 2; fi
echo "   silinen bir özel kod satırı karşılaştırmada yakalandı"
psql "$(owner_url "$DST")" -Atq -v ON_ERROR_STOP=1 -c "alter table companies disable row level security" > /dev/null
behavior "$DST" "$ORG" "$COMPANY" > "$WORK/bh.sabotaj"
if diff -q "$WORK/bh.src" "$WORK/bh.sabotaj" > /dev/null; then echo "TATBİKAT SAĞLAM DEĞİL: kapatılan RLS davranış denetiminde yakalanmadı" >&2; exit 2; fi
echo "   kapatılan RLS davranış denetiminde yakalandı"

printf '\nTatbikat başarılı: yedek alındı, taze bir veritabanına geri yüklendi; veri, yapı, RLS ve değiştirilemezlik korumaları aynı.\n'
