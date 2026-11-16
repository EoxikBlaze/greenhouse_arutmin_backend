#!/usr/bin/env bash
# Pasang penjaga jaringan di Raspberry Pi: sudo bash deploy-pi/jaga-jaringan/pasang.sh
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Jalankan dengan sudo."; exit 1; }
DIR="$(cd "$(dirname "$0")" && pwd)"
install -m 0755 "$DIR/vertonik-jaga-jaringan" /usr/local/sbin/vertonik-jaga-jaringan
install -m 0644 "$DIR/vertonik-jaga-jaringan.service" "$DIR/vertonik-jaga-jaringan.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now vertonik-jaga-jaringan.timer
echo "Terpasang. Pastikan profil hotspot ada: sudo vertonik-hotspot cadangan"
