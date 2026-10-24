#!/usr/bin/env bash
# Veritabanı yedeği alır (pg_dump özel biçim) ve sonucu backup_runs tablosuna kaydeder.
# Kullanım: DATABASE_URL=... BACKUP_DIR=/guvenli/yedek scripts/backup.sh
# Yedek dosyaları şifreli depolamaya taşınmalıdır (BACKUP_STORAGE_REFERENCE). Bu betik dosyayı yerelde bırakır.
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL gerekli}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
FILE="$BACKUP_DIR/su-$(date -u +%Y%m%dT%H%M%SZ).dump"
API_DIR="$(cd "$(dirname "$0")/../apps/api" && pwd)"
# Sonuç kaydı: derlenmiş sürüm varsa onu, yoksa kaynak sürümü kullanır (ortam değişkenleri veya kökteki .env gerekir)
record_run() {
  if [[ -f "$API_DIR/dist/src/cli/record-backup.js" ]]; then (cd "$API_DIR" && npm run -s record-backup:prod -- "$@")
  else (cd "$API_DIR" && npm run -s record-backup -- "$@"); fi
}

if pg_dump --format=custom --no-owner --file="$FILE" "$DATABASE_URL"; then
  chmod 600 "$FILE"
  SUM=$(sha256sum "$FILE" | cut -d' ' -f1)
  record_run BACKUP SUCCEEDED "${BACKUP_STORAGE_REFERENCE:-$FILE}" "sha256=$SUM"
  echo "Yedek alındı: $FILE"
else
  record_run BACKUP FAILED "" "pg_dump başarısız" || true
  echo "Yedekleme BAŞARISIZ" >&2
  exit 1
fi
