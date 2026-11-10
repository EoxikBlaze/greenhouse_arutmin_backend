#!/usr/bin/env bash
# ============================================================================
# Regresi backend yang BISA DIULANG — DB uji baru untuk SETIAP berkas tes.
#
#   bash scripts/regresi.sh                 # semua tes, kode di working tree
#   bash scripts/regresi.sh --head          # kode HEAD (git archive), tanpa perubahan lokal
#   bash scripts/regresi.sh test/integration/dosing-persetujuan.test.js   # berkas tertentu
#   PARALEL=4 bash scripts/regresi.sh       # 4 berkas sekaligus (default 1)
#
# Cara kerja:
#   1. Template garap_uji_tpl dibuat SEKALI dari dump yang di-commit (HEAD:database/vertonik.sql),
#      lalu migrasi (scripts/migrate.js), migrasi data siklus, dan perbaikan sequence.
#   2. Tiap berkas tes mendapat DB sendiri: CREATE DATABASE garap_uji_r<N> TEMPLATE garap_uji_tpl.
#      Tidak ada sisa data dari berkas lain (penyebab "users_email_unique" & parameter berubah).
#   3. Env tetap: JWT_SECRET acak, MQTT mati, penjadwal mati, rate limit mati.
#      ADMIN_PASSWORD dsb. dibaca tes dari .env (tidak pernah dicetak).
#   4. Ringkasan per berkas + total; exit 1 bila ada yang gagal. Log lengkap di $OUT_DIR.
#
# Keamanan: hanya membuat/menghapus database bernama garap_uji_* di 127.0.0.1. DB lain tidak disentuh.
# Butuh: psql/pg_dump lokal dengan hak CREATE DATABASE (user OS), dan .env backend.
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PGH="${PGHOST_REGRESI:-127.0.0.1}"
TPL="garap_uji_tpl"
PARALEL="${PARALEL:-1}"
OUT_DIR="${OUT_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/regresi-garap.XXXXXX")}"
mkdir -p "$OUT_DIR"

[ "$PGH" = "127.0.0.1" ] || [ "$PGH" = "localhost" ] || { echo "❌ hanya untuk PostgreSQL lokal"; exit 2; }
[ -f .env ] || { echo "❌ .env tidak ada di $ROOT (tes butuh ADMIN_PASSWORD)"; exit 2; }

# ── kode yang diuji ──────────────────────────────────────────────────────────
KODE="$ROOT"
BERKAS=()
for a in "$@"; do
  case "$a" in
    --head)
      KODE="$OUT_DIR/kode-head"; mkdir -p "$KODE"
      git archive HEAD | tar -x -C "$KODE"
      ln -s "$ROOT/node_modules" "$KODE/node_modules"
      grep -E '^(ADMIN|PETANI|DEMO)_PASSWORD=' .env > "$KODE/.env"; chmod 600 "$KODE/.env"
      ;;
    *) BERKAS+=("$a") ;;
  esac
done
cd "$KODE"
[ ${#BERKAS[@]} -gt 0 ] || while IFS= read -r f; do BERKAS+=("$f"); done < <(find test -name '*.test.js' | sort)

# ── koneksi: user aplikasi dari DATABASE_URL di .env (sandi tidak dicetak) ───
URL_ASLI="$(grep -E '^DATABASE_URL=' "$ROOT/.env" | cut -d= -f2-)"
APP_USER="$(node -e 'const u=new URL(process.argv[1]);console.log(decodeURIComponent(u.username))' "$URL_ASLI")"
urlDb() { node -e 'const u=new URL(process.argv[1]);u.hostname=process.argv[3];u.pathname="/"+process.argv[2];console.log(u.toString())' "$URL_ASLI" "$1" "$PGH"; }
psqlAdmin() { PGOPTIONS="-c client_min_messages=warning" psql -X -q -v ON_ERROR_STOP=1 -h "$PGH" -d postgres "$@"; }

hapusDb() { psqlAdmin -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$1' AND pid<>pg_backend_pid()" >/dev/null; psqlAdmin -c "DROP DATABASE IF EXISTS $1" >/dev/null; }

# ── 1. template ──────────────────────────────────────────────────────────────
echo "▸ Template $TPL (dump HEAD:database/vertonik.sql + migrasi) ..."
hapusDb "$TPL"
psqlAdmin -c "CREATE DATABASE $TPL OWNER \"$APP_USER\"" >/dev/null
TPL_URL="$(urlDb "$TPL")"
# baris pg_dump 17.6+ yang tidak dikenal psql lama dibuang (sama dengan pasang-server.sh)
git -C "$ROOT" show HEAD:database/vertonik.sql \
  | sed -e '/^\\restrict /d' -e '/^\\unrestrict /d' -e '/^SET transaction_timeout/d' \
  | psql -X -q -v ON_ERROR_STOP=1 "$TPL_URL" >"$OUT_DIR/template-restore.log" 2>&1 \
  || { echo "❌ restore dump gagal — lihat $OUT_DIR/template-restore.log"; exit 1; }
DATABASE_URL="$TPL_URL" node scripts/migrate.js >"$OUT_DIR/template-migrate.log" 2>&1 \
  || { echo "❌ migrasi gagal — lihat $OUT_DIR/template-migrate.log"; exit 1; }
if [ -f scripts/migrasi-siklus.js ]; then
  DATABASE_URL="$TPL_URL" node scripts/migrasi-siklus.js --jalan >"$OUT_DIR/template-siklus.log" 2>&1 \
    || { echo "❌ migrasi data siklus gagal — lihat $OUT_DIR/template-siklus.log"; exit 1; }
fi
psql -X -q -v ON_ERROR_STOP=1 "$TPL_URL" -f "$ROOT/scripts/fix-sequences.sql" >"$OUT_DIR/template-sequence.log" 2>&1
# CI: dump membawa sandi contoh; samakan sandi admin template dengan ADMIN_PASSWORD di .env (CI_ATUR_SANDI=1).
if [ "${CI_ATUR_SANDI:-0}" = "1" ]; then
  ADMIN_PW="$(grep -E '^ADMIN_PASSWORD=' "$ROOT/.env" | cut -d= -f2-)"
  # hanya template uji terisolasi: hash langsung (cost 4) agar sandi .env pendek tetap bisa dipakai tes
  DATABASE_URL="$TPL_URL" KATA_SANDI="$ADMIN_PW" node -e "
    const b=require('bcryptjs');const {q,pool}=require('./src/db');
    (async()=>{const r=await q('UPDATE users SET password=\$1 WHERE username=\$2 RETURNING id',[await b.hash(process.env.KATA_SANDI,4),'garap']);
    if(!r.length)throw new Error('akun garap tidak ada');})().catch(e=>{console.error('GAGAL:',e.message);process.exitCode=1}).finally(()=>pool.end())" >"$OUT_DIR/template-sandi.log" 2>&1 \
    || { echo "❌ atur sandi admin gagal — lihat $OUT_DIR/template-sandi.log"; exit 1; }
fi
echo "  migrasi terterap: $(psql -X -At "$TPL_URL" -c 'SELECT count(*) FROM schema_migrations' 2>/dev/null || echo '?')"

# ── 2. satu DB per berkas ────────────────────────────────────────────────────
jalankan() { # $1 = indeks, $2 = berkas
  local db="garap_uji_r$1" log
  log="$OUT_DIR/$(echo "$2" | tr '/' '_').log"
  hapusDb "$db"
  psqlAdmin -c "CREATE DATABASE $db TEMPLATE $TPL OWNER \"$APP_USER\"" >/dev/null
  local hasil
  hasil=$(DATABASE_URL="$(urlDb "$db")" JWT_SECRET="$(openssl rand -hex 32)" MQTT_URL="" \
    SIKLUS_PENJADWAL=0 RATE_LIMIT_OFF=1 timeout 600 node --test "$2" >"$log" 2>&1; echo $?)
  local lulus gagal lewat
  lulus=$(grep -E '^# pass ' "$log" | awk '{print $3}' | tail -1)
  gagal=$(grep -E '^# fail ' "$log" | awk '{print $3}' | tail -1)
  lewat=$(grep -E '^# skipped ' "$log" | awk '{print $3}' | tail -1)
  printf '%s\t%s\t%s\t%s\t%s\n' "${lulus:-0}" "${gagal:-?}" "${lewat:-0}" "$hasil" "$2" >>"$OUT_DIR/ringkas.tsv"
  hapusDb "$db"
}
export -f jalankan hapusDb psqlAdmin urlDb
export PGH TPL APP_USER URL_ASLI OUT_DIR

: >"$OUT_DIR/ringkas.tsv"
echo "▸ ${#BERKAS[@]} berkas tes, paralel $PARALEL, log: $OUT_DIR"
i=0
for f in "${BERKAS[@]}"; do
  i=$((i + 1))
  jalankan "$i" "$f" &
  while [ "$(jobs -rp | wc -l)" -ge "$PARALEL" ]; do sleep 0.3; done
done
wait
hapusDb "$TPL"

# ── 3. ringkasan ─────────────────────────────────────────────────────────────
sort -k5 "$OUT_DIR/ringkas.tsv" -o "$OUT_DIR/ringkas.tsv"
awk -F'\t' '$2!="0" || $4!="0" {printf "  ✗ %-55s lulus %s, gagal %s (exit %s)\n", $5, $1, $2, $4}' "$OUT_DIR/ringkas.tsv"
# Cetak potongan tes gagal agar CI tidak buta (log lengkap hanya ada di runner).
awk -F'\t' '$2!="0" || $4!="0" {print $5}' "$OUT_DIR/ringkas.tsv" | while read -r f; do
  echo "── gagal: $f"; grep -E -A14 '^\s*not ok|^# Subtest.*\n' "$OUT_DIR/$(echo "$f" | tr '/' '_').log" | head -60
done
awk -F'\t' '{p+=$1; f+=($2=="?"?1:$2); s+=$3; if ($2!="0"||$4!="0") b++} END {
  printf "\nTOTAL: %d lulus, %d gagal, %d dilewati, %d berkas bermasalah dari %d\n", p, f, s, b, NR; exit (b>0)}' "$OUT_DIR/ringkas.tsv"
