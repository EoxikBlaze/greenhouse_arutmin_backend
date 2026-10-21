#!/usr/bin/env bash
# ============================================================================
# backup-pi.sh — backup & restore database vertonik (sekali jalan, aman)
#
#   ./scripts/backup-pi.sh                     # backup ke database/backup/
#   ./scripts/backup-pi.sh --dir /tmp/bk       # backup ke folder lain (uji)
#   ./scripts/backup-pi.sh --check FILE        # verifikasi file dump valid
#   ./scripts/backup-pi.sh --restore FILE -y   # restore (konfirmasi otomatis)
#
#   Opsi:
#     --dir DIR     folder tujuan backup (default: <backend>/database/backup)
#     --out FILE    path file dump EKSPLISIT (untuk menimpa file tertentu)
#     --url URL     DATABASE_URL (default: env DATABASE_URL, lalu file .env)
#     --env FILE    file .env yang dibaca (default: <backend>/.env)
#     --keep N      jumlah file backup terbaru yang disimpan (default: 7)
#     --check FILE  hanya memeriksa validitas file dump, lalu keluar
#     --restore FILE  restore dump ke database (tanya dulu; -y = non-interaktif)
#     -y, --yes     lewati konfirmasi (untuk cron / non-interaktif)
#
# Kredensial TIDAK pernah ditulis di skrip ini: seluruhnya dari DATABASE_URL
# (env / argumen / file .env). Password tidak pernah dicetak ke layar.
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEEP=7
DIR="$ROOT/database/backup"
OUT=""
ENV_FILE="$ROOT/.env"
URL_ARG="${DATABASE_URL:-}"
MODE="backup"
TARGET=""
YES=0

mask() { sed -E 's#://([^:/]+):[^@]+@#://\1:***@#'; }

usage() { sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)     DIR="${2:?--dir butuh nilai}"; shift 2 ;;
    --out)     OUT="${2:?--out butuh nilai}"; shift 2 ;;
    --url)     URL_ARG="${2:?--url butuh nilai}"; shift 2 ;;
    --env)     ENV_FILE="${2:?--env butuh nilai}"; shift 2 ;;
    --keep)    KEEP="${2:?--keep butuh nilai}"; shift 2 ;;
    --check)   MODE="check"; TARGET="${2:?--check butuh file}"; shift 2 ;;
    --restore) MODE="restore"; TARGET="${2:?--restore butuh file}"; shift 2 ;;
    -y|--yes)  YES=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "Opsi tak dikenal: $1 (lihat --help)" >&2; exit 2 ;;
  esac
done

# --- cari binary pg_dump (Mac homebrew maupun Pi) ---------------------------
find_bin() {
  local c
  for c in "${PGDUMP:-}" "$(command -v pg_dump 2>/dev/null || true)" \
           /opt/homebrew/opt/postgresql@17/bin/pg_dump /usr/bin/pg_dump; do
    [ -n "$c" ] && [ -x "$c" ] && { echo "$c"; return 0; }
  done
  for c in /usr/lib/postgresql/*/bin/pg_dump; do
    [ -x "$c" ] && { echo "$c"; return 0; }
  done
  return 1
}

resolve_url() {
  if [ -n "$URL_ARG" ]; then echo "$URL_ARG"; return 0; fi
  if [ -f "$ENV_FILE" ]; then
    local v; v="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -n1 | cut -d= -f2-)"
    [ -n "$v" ] && { echo "$v"; return 0; }
  fi
  return 1
}

# --- validasi file dump (dipakai --check, backup, restore) ------------------
check_dump() {
  local f="$1" headc
  if [ ! -f "$f" ]; then echo "  ❌ tidak ada: $f"; return 1; fi
  if [ ! -s "$f" ]; then echo "  ❌ file kosong: $f"; return 1; fi
  headc="$(head -n 25 "$f" || true)"
  case "$headc" in
    *"PostgreSQL database dump"*) : ;;
    *) echo "  ❌ bukan dump pg_dump (header tak dikenal): $f"; return 1 ;;
  esac
  grep -qE '^(SET |CREATE TABLE|CREATE SCHEMA)' "$f" \
    || { echo "  ❌ tak ada pernyataan SQL di header: $f"; return 1; }
  echo "  ✅ header SQL valid: $f ($(wc -c < "$f" | tr -d ' ') byte)"
  return 0
}

rotate() { # rotate <glob> <keep> — simpan N file terbaru (nama ber-timestamp urut naik)
  local pattern="$1" keep="$2" f i n
  local daftar=()
  for f in $pattern; do              # glob dipecah shell -> path penuh, terurut naik
    if [ -f "$f" ]; then daftar+=("$f"); fi
  done
  n=${#daftar[@]}
  if [ "$n" -le "$keep" ]; then
    echo "  ($n file — semua disimpan, keep=$keep)"
    return 0
  fi
  for ((i = 0; i < n - keep; i++)); do
    rm -f "${daftar[i]}"
    echo "  🗑 rotasi (dihapus): $(basename "${daftar[i]}")"
  done
  echo "  sisa $keep file terbaru"
}

# ---------------------------------------------------------------- CHECK ----
if [ "$MODE" = "check" ]; then
  check_dump "$TARGET"
  exit $?
fi

URL="$(resolve_url)" || { echo "DATABASE_URL tidak ditemukan (env / $ENV_FILE)" >&2; exit 1; }

# -------------------------------------------------------------- RESTORE ----
if [ "$MODE" = "restore" ]; then
  echo "▸ Restore: $TARGET"
  echo "  ⚠️  Target: $(echo "$URL" | mask)"
  echo "  ⚠️  SEMUA data pada schema public akan DIHAPUS lalu diganti dump ini."
  check_dump "$TARGET" || { echo "File dump tidak valid — batal." >&2; exit 1; }
  if [ "$YES" -ne 1 ]; then
    printf "  Ketik 'ya' untuk melanjutkan: "
    read -r jawab
    [ "$jawab" = "ya" ] || { echo "Dibatalkan."; exit 1; }
  fi
  echo "▸ [1/4] kosongkan schema public..."
  psql "$URL" -v ON_ERROR_STOP=1 -q \
    -c 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'
  echo "▸ [2/4] impor dump..."
  psql "$URL" -v ON_ERROR_STOP=1 -q -f "$TARGET" >/dev/null   # ringkas; error tetap di stderr
  echo "▸ [3/4] fix-sequences (bila ada)..."
  if [ -f "$ROOT/scripts/fix-sequences.sql" ]; then
    psql "$URL" -v ON_ERROR_STOP=1 -q -f "$ROOT/scripts/fix-sequences.sql" >/dev/null
  else
    echo "  (tidak ada scripts/fix-sequences.sql — dilewati)"
  fi
  echo "▸ [4/4] verifikasi..."
  psql "$URL" -tAc \
    "SELECT '  tabel='||(SELECT count(*) FROM information_schema.tables WHERE table_schema='public')\
        || '  pengguna='||(SELECT count(*) FROM users)" || true
  echo "✅ Restore selesai: $TARGET"
  exit 0
fi

# --------------------------------------------------------------- BACKUP ----
PGDUMP_BIN="$(find_bin)" || { echo "pg_dump tidak ditemukan (install postgresql)" >&2; exit 1; }
TS="$(date +%Y%m%d-%H%M)"
if [ -n "$OUT" ]; then
  DUMP_FILE="$OUT"
  DIR="$(dirname "$OUT")"
else
  DUMP_FILE="$DIR/vertonik-$TS.sql"
fi
mkdir -p "$DIR"

echo "▸ [1/3] pg_dump → $DUMP_FILE"
TMP="$DUMP_FILE.tmp.$$"
# shellcheck disable=SC2086
"$PGDUMP_BIN" --no-owner --no-privileges "$URL" > "$TMP"
mv "$TMP" "$DUMP_FILE"
echo "  target: $(echo "$URL" | mask)"
check_dump "$DUMP_FILE"

echo "▸ [2/3] backup file .env (chmod 600)"
if [ -f "$ENV_FILE" ]; then
  cp "$ENV_FILE" "$DIR/env-$TS.bak"
  chmod 600 "$DIR/env-$TS.bak"
  echo "  $DIR/env-$TS.bak"
else
  echo "  (tidak ada $ENV_FILE — dilewati)"
fi

echo "▸ [3/3] rotasi: simpan $KEEP terakhir"
rotate "$DIR/vertonik-*.sql" "$KEEP"
rotate "$DIR/env-*.bak" "$KEEP"

echo "✅ Backup selesai: $DUMP_FILE"
echo "   Cek: $0 --check '$DUMP_FILE'"
