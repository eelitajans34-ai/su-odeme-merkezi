#!/usr/bin/env bash
# Bir yedeği AYRI bir test veritabanına geri yükler ve temel kontrolleri yapar.
# Kullanım: DATABASE_URL=<kayıt yazılacak ana DB> RESTORE_TEST_URL=postgres://.../su_restore_test scripts/restore-test.sh <yedek.dump>
# Uyarı: RESTORE_TEST_URL'deki veritabanının içeriği silinir. Adı "_restore_test" ile bitmelidir.
set -euo pipefail
FILE="${1:?Yedek dosyası gerekli}"
: "${RESTORE_TEST_URL:?RESTORE_TEST_URL gerekli}"
: "${DATABASE_URL:?DATABASE_URL gerekli}"
DBNAME="${RESTORE_TEST_URL##*/}"; DBNAME="${DBNAME%%\?*}"
if [[ "$DBNAME" != *_restore_test ]]; then
  echo "Güvenlik: hedef veritabanı adı _restore_test ile bitmelidir (verilen: $DBNAME)" >&2
  exit 2
fi
API_DIR="$(cd "$(dirname "$0")/../apps/api" && pwd)"
# Sonuç kaydı: derlenmiş sürüm varsa onu, yoksa kaynak sürümü kullanır (ortam değişkenleri veya kökteki .env gerekir)
record_run() {
  if [[ -f "$API_DIR/dist/src/cli/record-backup.js" ]]; then (cd "$API_DIR" && npm run -s record-backup:prod -- "$@")
  else (cd "$API_DIR" && npm run -s record-backup -- "$@"); fi
}
record() { record_run RESTORE_TEST "$1" "$FILE" "$2"; }

if ! pg_restore --clean --if-exists --no-owner --dbname="$RESTORE_TEST_URL" "$FILE"; then
  record FAILED "pg_restore başarısız"; exit 1
fi
TABLES=$(psql "$RESTORE_TEST_URL" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
LAST=$(psql "$RESTORE_TEST_URL" -tAc "SELECT max(version) FROM schema_migrations")
AUDIT=$(psql "$RESTORE_TEST_URL" -tAc "SELECT count(*) FROM audit_logs")
if [[ "$TABLES" -lt 30 || -z "$LAST" ]]; then
  record FAILED "tablo=$TABLES son_migrasyon=$LAST"; exit 1
fi
record SUCCEEDED "tablo=$TABLES son_migrasyon=$LAST denetim_kaydi=$AUDIT"
echo "Geri yükleme testi başarılı: tablo=$TABLES, son migrasyon=$LAST, denetim kaydı=$AUDIT"
