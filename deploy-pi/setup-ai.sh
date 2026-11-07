#!/usr/bin/env bash
# ============================================================================
# setup-ai.sh — Pasang AI LOKAL (Ollama + model DeepSeek ringan) di Raspberry Pi
# ----------------------------------------------------------------------------
# Dipakai untuk: asisten keputusan budidaya pada endpoint backend
#                POST /api/ai/langkah-selanjutnya (lihat docs/AI_LOKAL_PI.md)
#
# Target   : Raspberry Pi OS (Debian) 64-bit (ARM64), Raspberry Pi 4/5 4–8 GB
# Jalankan : chmod +x deploy-pi/setup-ai.sh && ./deploy-pi/setup-ai.sh
# Aman dijalankan berulang-kali (idempotent).
#
# Pilihan model (bisa juga di-override lewat env: AI_MODEL=... ./setup-ai.sh):
#   Default   -> qwen2.5:0.5b  (paling ringan ±397 MB, sangat cepat di Raspberry Pi CPU)
#   RAM 4-8GB -> qwen2.5:1.5b  (opsional bila ingin model lebih besar)
# ============================================================================
set -euo pipefail

MODEL="${AI_MODEL:-qwen2.5:0.5b}"
MODEL_0_5B="qwen2.5:0.5b"                 # model ringan utama untuk Raspberry Pi
OLLAMA_URL="http://127.0.0.1:11434"
jalan() { printf '\033[1;32m[OK]\033[0m %s\n' "$*"; }
info()  { printf '\033[1;36m[..]\033[0m %s\n' "$*"; }
waspad() { printf '\033[1;33m[!!]\033[0m %s\n' "$*"; }

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

# ── Langkah 0 — cek lingkungan ────────────────────────────────────────────────
info "Memeriksa Raspberry Pi ..."
ARCH="$(uname -m)"
if [ "$ARCH" != "aarch64" ] && [ "$ARCH" != "arm64" ]; then
  waspad "Arsitektur terdeteksi: $ARCH (yang didukung installer Ollama: aarch64/arm64)."
  waspad "Tetap lanjut — bila gagal, jalankan di Pi OS 64-bit."
fi
TOTAL_KB="$(awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
TOTAL_GB=$(( TOTAL_KB / 1024 / 1024 ))
jalan "Arsitektur $ARCH, RAM ± ${TOTAL_GB} GB"

if [ "$TOTAL_GB" -gt 0 ] && [ "$TOTAL_GB" -lt 3 ]; then
  waspad "RAM ${TOTAL_GB} GB — pakai model 0,5B:  AI_MODEL=$MODEL_0_5B $0"
  waspad "Model 1,5B berisiko ter-kill OOM di Pi 2 GB."
  MODEL="$MODEL_0_5B"
fi

if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; else SUDO=""; fi

# ── Langkah 1 — instal Ollama (resmi) ────────────────────────────────────────
info "Mengunduh & menjalankan installer resmi Ollama (https://ollama.com/install.sh) ..."
if command -v ollama >/dev/null 2>&1; then
  jalan "Ollama sudah terpasang: $(ollama --version 2>/dev/null | head -1)"
else
  curl -fsSL https://ollama.com/install.sh | $SUDO sh
  jalan "Instalasi Ollama selesai"
fi

# ── Langkah 2 — nyalakan layanannya (auto-start saat Pi dinyalakan & kunci ke 127.0.0.1) ──
info "Mengaktifkan layanan ollama (terkunci ke 127.0.0.1:11434 & selalu restart) ..."
if command -v systemctl >/dev/null 2>&1; then
  $SUDO mkdir -p /etc/systemd/system/ollama.service.d
  cat <<'EOF' | $SUDO tee /etc/systemd/system/ollama.service.d/localhost.conf >/dev/null
[Unit]
Description=Ollama Service (GARAP Local AI)
After=network-online.target
Wants=network-online.target

[Service]
Environment="OLLAMA_HOST=127.0.0.1:11434"
Environment="OLLAMA_KEEP_ALIVE=-1"
Environment="OLLAMA_NUM_PARALLEL=1"
Environment="OLLAMA_MAX_LOADED_MODELS=1"
Restart=always
RestartSec=3
EOF
  $SUDO systemctl daemon-reload 2>/dev/null || true
  $SUDO systemctl enable --now ollama 2>/dev/null || true
  $SUDO systemctl restart ollama 2>/dev/null || true
  sleep 2
  if systemctl is-active --quiet ollama 2>/dev/null; then
    jalan "Layanan ollama AKTIF & AUTO-START di 127.0.0.1:11434 (enable on boot: $(systemctl is-enabled ollama 2>/dev/null || echo '?'))"
  else
    waspad "Layanan ollama belum aktif — coba: sudo systemctl start ollama"
  fi
else
  OLLAMA_HOST=127.0.0.1:11434 nohup ollama serve >/tmp/ollama.log 2>&1 &
  jalan "Menjalankan 'ollama serve' di 127.0.0.1:11434 tanpa systemd (lihat /tmp/ollama.log)"
fi

# ── Langkah 3 — verifikasi endpoint hidup ────────────────────────────────────
info "Memeriksa endpoint $OLLAMA_URL/api/version ..."
for i in $(seq 1 20); do
  if curl -fsS -m 3 "$OLLAMA_URL/api/version" >/tmp/ollama-version.json 2>/dev/null; then
    jalan "Ollama hidup: $(tr -d '\n' </tmp/ollama-version.json)"
    break
  fi
  [ "$i" = 20 ] && { echo "Ollama TIDAK menjawab di $OLLAMA_URL"; exit 1; }
  sleep 1
done

# ── Langkah 4 — unduh model ringan ───────────────────────────────────────────
if ollama list 2>/dev/null | awk '{print $1}' | grep -qx "$MODEL"; then
  jalan "Model $MODEL sudah ada"
else
  info "Mengunduh model $MODEL (sekali saja, ±1 GB — koneksi internet wajib) ..."
  ollama pull "$MODEL"
  jalan "Model $MODEL siap dipakai"
fi

# ── Langkah 5 — uji cepat model ──────────────────────────────────────────────
info "Uji singkat model $MODEL (bisa lambat 10–30 dtk di Pi) ..."
if curl -fsS -m 60 "$OLLAMA_URL/api/generate" \
     -d "{\"model\":\"$MODEL\",\"prompt\":\"Balas hanya JSON: {\\\"ok\\\":true}\",\"stream\":false}" \
     | head -c 300; then
  echo
  jalan "Model menjawab"
else
  waspad "Uji model gagal — cek RAM/swap (Langkah 6) dan logs: journalctl -u ollama -n 50"
fi

# ── Langkah 6 — RAM & swap ───────────────────────────────────────────────────
info "Pemakaian RAM/swap saat ini:"
free -h || true
if [ "$TOTAL_GB" -le 4 ]; then
  waspad "Pi ${TOTAL_GB} GB: model 1,5B + Postgres + backend bisa membuat swap tinggi."
  waspad "Bila 'swap' kosong/kecil, tambahkan swap file 2 GB:"
  cat <<'SWAP'
    sudo dphys-swapfile swapoff 2>/dev/null || true          # Pi OS lama (opsional)
    sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
    sudo mkswap /swapfile && sudo swapon /swapfile
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
SWAP
  waspad "Atau pakai zram (swap terkompresi di RAM — lebih cepat dari swap file):"
  cat <<'ZRAM'
    sudo apt update && sudo apt install -y zram-tools
    sudo systemctl enable --now zram-config 2>/dev/null || sudo systemctl restart zram-tools
ZRAM
fi

# ── Langkah 7 — hangatkan model di memori agar selalu siap & instan ───────────
info "Menghangatkan model $MODEL di RAM (Keep-Alive: Selalu Siap) ..."
curl -fsS -m 30 "$OLLAMA_URL/api/generate" \
  -d "{\"model\":\"$MODEL\",\"prompt\":\"\",\"keep_alive\":-1}" >/dev/null 2>&1 || true
jalan "Model $MODEL siap dan tetap berada di memori RAM (tanpa jeda cold-start)"

# ── Langkah 8 — konfigurasi backend (PENTING) ────────────────────────────────
cat <<EOF

$(jalan "SELESAI. Ringkasan:")
  Model aktif : $MODEL
  Endpoint    : $OLLAMA_URL   (uji: curl -s $OLLAMA_URL/api/tags)

Agar endpoint backend memakai AI ini, isi 2 baris di berkas .env backend
(bersamaan DATABASE_URL/JWT_SECRET) — kalau backend berjalan DI PI yang sama,
nilai defaultnya sudah benar:

  AI_MODEL=$MODEL
  AI_OLLAMA_URL=$OLLAMA_URL

Lalu restart backend (npm start). Bila Ollama mati, endpoint TETAP jalan dan
otomatis memakai jawaban heuristik (sumber:'heuristik') — lihat docs/AI_LOKAL_PI.md.
EOF
