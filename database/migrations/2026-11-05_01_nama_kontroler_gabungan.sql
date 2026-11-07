-- 5 Nov 2026 — Satu ESP32 = satu perangkat 'gabungan' (modul sensor + modul aktuator), login 'aktuator-01'.
-- Peran baru 'gabungan': boleh kirim data sensor DAN menerima perintah/melaporkan hasil. Kode & kunci tidak berubah.
-- Kunci lama (scope aktuator:perintah saja) tetap sah untuk MQTT; buat ulang kunci agar HTTP sensor juga boleh.
ALTER TABLE perangkat DROP CONSTRAINT IF EXISTS perangkat_peran_cek;
ALTER TABLE perangkat ADD CONSTRAINT perangkat_peran_cek CHECK (peran IS NULL OR peran IN ('sensor', 'aktuator', 'gabungan'));
COMMENT ON COLUMN perangkat.peran IS 'sensor = kirim data sensor; aktuator = ambil perintah; gabungan = satu ESP32 yang melakukan keduanya. NULL = perangkat lama.';
UPDATE perangkat
   SET peran = 'gabungan',
       nama = 'ESP32 gabungan (sensor + aktuator)',
       keterangan = 'Satu papan: membaca sensor dan menjalankan perintah pompa. Login MQTT aktuator-01.'
 WHERE kode = 'aktuator-01';
