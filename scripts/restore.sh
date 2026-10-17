#!/usr/bin/env bash
# ============================================================================
# Restore database Vertonik Smart Farm — SATU perintah, tanpa langkah manual.
#
#   scripts/restore.sh /path/ke/dump.sql
#   DATABASE_URL=postgres://user:pass@host/db_lain scripts/restore.sh dump.sql
#
# Urutan dijalankan:
#   1. psql -f <dump>            — skema + data
#   2. database/migrations/*.sql — migrasi berversi (mis. FK panens → RESTRICT)
#   3. scripts/fix-sequences.sql — WAJIB terakhir: sequence disamakan max(id)
#                                  (kalau dilompati → semua INSERT balas 500)
#   4. verifikasi ringkas
#
# Kenapa script ini ada: sebelumnya restore dilakukan manual (psql -f dump) dan
# perbaikan sequence harus diingat terpisah — sering terlupa → bug INSERT 500.
# ============================================================================
set -euo pipefail

DUMP="${1:-}"
if [ -z "$DUMP" ]; then
  echo "Pakai: scripts/restore.sh /path/ke/dump.sql" >&2
  exit 1
fi
if [ ! -f "$DUMP" ]; then
  echo "File dump tidak ditemukan: $DUMP" >&2
  exit 1
fi

cd "$(dirname "$0")/.."                       # root backend-nodejs
# DATABASE_URL dari env dulu (untuk restore ke DB lain), fallback ke .env
if [ -z "${DATABASE_URL:-}" ]; then
  DATABASE_URL="$(grep '^DATABASE_URL=' .env | cut -d= -f2-)"
fi
export DATABASE_URL

echo "== [1/4] restore dump: $DUMP"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$DUMP"

echo "== [2/4] migrasi berversi (database/migrations/*.sql)"
shopt -s nullglob
MIGRATIONS=(database/migrations/*.sql)
if [ ${#MIGRATIONS[@]} -eq 0 ]; then
  echo "   (tidak ada migrasi)"
else
  for m in "${MIGRATIONS[@]}"; do
    echo "   - $m"
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$m"
  done
fi
shopt -u nullglob

echo "== [3/4] fix-sequences (WAJIB — selalu terakhir)"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/fix-sequences.sql

echo "== [4/4] verifikasi"
psql "$DATABASE_URL" -tAc \
  "SELECT 'akun='||(SELECT count(*) FROM users)
       || '  meja='||(SELECT count(*) FROM mejas)
       || '  panen='||(SELECT count(*) FROM panens)
       || '  ambang='||(SELECT count(*) FROM sensor_thresholds)"
psql "$DATABASE_URL" -tAc \
  "SELECT 'FK panens→pendewasaans: '||pg_get_constraintdef(oid)
   FROM pg_constraint WHERE conname='panens_id_pendewasaan_foreign'"

echo
echo "Restore selesai. Uji cepat: jalankan backend lalu POST satu baris"
echo "  curl -s -X POST http://127.0.0.1:8000/meja -H 'Authorization: Bearer ***' \\"
echo "       -H 'Content-Type: application/json' -d '{\"meja\":\"UJI\",\"jumlah_lubang\":4}'"
