#!/usr/bin/env bash
# generate-apikey.sh — rotasi (ganti) kunci API ESP32: ESP32_API_KEY di .env
#
# Sekali jalan. TIDAK PERNAH mencetak nilai kunci ke layar/log — hanya panjang.
#
# Pemakaian:
#   scripts/generate-apikey.sh              # ROTASI kunci (tanya dulu, butuh --yes bila non-interaktif)
#   scripts/generate-apikey.sh --check      # verifikasi kunci aktif vs server (tanpa mengubah apa pun)
#   scripts/generate-apikey.sh --env PATH    # pakai file .env lain
#   scripts/generate-apikey.sh --base URL    # base URL backend utk --check (default http://127.0.0.1:8000)
#   scripts/generate-apikey.sh --help
#
# SESUDAH rotasi (wajib, urut):
#   1. restart backend:  sudo systemctl restart vertonik-api   (di Pi; server membaca .env saat start)
#   2. ganti API_KEY di firmware SEMUA ESP32 (lihat docs/ESP32_API.md §3.1)
#   3. jalankan:          scripts/generate-apikey.sh --check   (harus 200)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"
BASE_URL="http://127.0.0.1:8000"
MODE="rotate"          # rotate | check
ASSUME_YES=0

usage() { sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE="check" ;;
    --env)   shift; ENV_FILE="${1:?--env butuh path file}" ;;
    --base)  shift; BASE_URL="${1:?--base butuh URL}" ;;
    --yes|-y) ASSUME_YES=1 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Opsi tidak dikenal: $1 (lihat --help)" >&2; exit 2 ;;
  esac
  shift
done

[ -f "$ENV_FILE" ] || { echo "ERROR: file .env tidak ditemukan: $ENV_FILE" >&2; exit 1; }

# Baca nilai kunci dari .env TANPA menampilkan nilainya.
baca_key() {
  grep -E '^[[:space:]]*ESP32_API_KEY[[:space:]]*=' "$ENV_FILE" | tail -n1 \
    | cut -d= -f2- | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
    | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

# Cek ringan ke server: GET /api/get-thresholds dgn kunci dari .env.
# Tidak pernah mencetak kunci; hanya status HTTP + penjelasan.
do_check() {
  local key code
  key="$(baca_key)"
  if [ -z "$key" ]; then
    echo "GAGAL  : ESP32_API_KEY kosong/tidak ada di $ENV_FILE"
    return 1
  fi
  echo "info   : kunci terbaca (panjang ${#key} karakter) — nilai tidak dicetak"
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
            -H "X-API-KEY: $key" "$BASE_URL/api/get-thresholds" || echo 000)"
  case "$code" in
    200) echo "OK     : 200 — kunci AKTIF diterima server ($BASE_URL)" ;;
    403) echo "GAGAL  : 403 — kunci di .env TIDAK cocok dgn yang di memori server."
         echo "         Pastikan backend sudah di-restart setelah .env diubah." ;;
    000) echo "GAGAL  : server tidak terjangkau di $BASE_URL (cek IP/port/service)" ;;
    *)   echo "GAGAL  : HTTP $code dari $BASE_URL/api/get-thresholds" ;;
  esac
  [ "$code" = "200" ]
}

do_rotate() {
  command -v openssl >/dev/null 2>&1 || { echo "ERROR: openssl tidak ada" >&2; exit 1; }
  local lama baru backup
  lama="$(baca_key)"
  echo "target  : $ENV_FILE"
  if [ -n "$lama" ]; then
    echo "kunci lama: ${#lama} karakter (nilai tidak ditampilkan)"
  else
    echo "catatan : ESP32_API_KEY belum ada di $ENV_FILE — akan DITAMBAHKAN"
  fi

  if [ "$ASSUME_YES" != "1" ]; then
    if [ -t 0 ]; then
      printf 'Rotasi akan MEMUTUS semua ESP32 sampai firmware & backend ikut di-update. Lanjut? [y/N] '
      read -r jawab
      case "$jawab" in y|Y|yes|YES) ;; *) echo "Dibatalkan."; exit 0 ;; esac
    else
      echo "ERROR: mode non-interaktif butuh --yes untuk rotasi (atau pakai --check)." >&2
      exit 2
    fi
  fi

  baru="$(openssl rand -hex 32)"
  backup="$ENV_FILE.bak.$(date +%Y%m%d-%H%M%S)"
  cp -p "$ENV_FILE" "$backup"
  echo "backup  : $backup"

  if grep -qE '^[[:space:]]*ESP32_API_KEY[[:space:]]*=' "$ENV_FILE"; then
    # Ganti HANYA baris ESP32_API_KEY (nilai baru hex → aman utk sed).
    ESP32_NEW="$baru" awk 'BEGIN{done=0} /^[[:space:]]*ESP32_API_KEY[[:space:]]*=/ {
      if(!done){ print "ESP32_API_KEY=" ENVIRON["ESP32_NEW"]; done=1 } next } { print }
      END{ if(!done) print "ESP32_API_KEY=" ENVIRON["ESP32_NEW"] }' \
      "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
  else
    printf '\nESP32_API_KEY=%s\n' "$baru" >> "$ENV_FILE"
  fi
  unset baru
  chmod 600 "$ENV_FILE" 2>/dev/null || true

  echo "selesai: kunci ESP32_API_KEY dirotasi (nilai baru TIDAK dicetak)."
  echo
  echo ">>> LANGKAH WAJIB BERIKUTNYA:"
  echo "  1. Restart backend supaya membaca kunci baru: sudo systemctl restart vertonik-api"
  echo "  2. Update API_KEY di firmware SEMUA ESP32 (docs/ESP32_API.md §3.1) lalu flash ulang"
  echo "  3. Verifikasi: $0 --check   (harus OK : 200)"
  echo "Catatan: selama 1–2 belum dilakukan, ESP32 akan menerima 403 'Unauthorized'."
}

if [ "$MODE" = "check" ]; then
  do_check
else
  do_rotate
fi
