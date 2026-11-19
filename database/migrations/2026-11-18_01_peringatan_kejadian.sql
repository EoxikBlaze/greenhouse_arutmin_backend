-- 18 Nov 2026 — Peringatan sebagai KEJADIAN (buka saat kondisi bertahan, tutup sendiri saat pulih).
-- Kontrak MQTT v2.0 §3 & §9: alat tidak mengirim peringatan; web menilai dari angka & keadaan (src/peringatan.js).
-- Hanya ADD COLUMN nullable + indeks; aman diulang.
ALTER TABLE alert_logs ADD COLUMN IF NOT EXISTS kunci_kejadian varchar(60);
ALTER TABLE alert_logs ADD COLUMN IF NOT EXISTS selesai_pada timestamp without time zone;
COMMENT ON COLUMN alert_logs.kunci_kejadian IS 'Kunci kondisi (mis. sensor_ph, kunci_sensor_rusak). NULL = catatan sekali jadi (E-STOP, RESET, baris lama).';
COMMENT ON COLUMN alert_logs.selesai_pada IS 'Waktu kondisi pulih. NULL + kunci_kejadian terisi = peringatan sedang terjadi.';
-- satu kejadian aktif per kondisi
CREATE UNIQUE INDEX IF NOT EXISTS alert_logs_kejadian_aktif
  ON alert_logs (kunci_kejadian) WHERE kunci_kejadian IS NOT NULL AND selesai_pada IS NULL;
-- Baris kunci_* lama (dulu dicatat ulang tiap laporan alat) ditandai sudah ditangani; bila kunci masih aktif,
-- penilai membuka satu kejadian baru dalam 30 detik.
UPDATE alert_logs SET acknowledged = true, acknowledged_at = now(), updated_at = now()
 WHERE type LIKE 'kunci\_%' AND kunci_kejadian IS NULL AND NOT acknowledged;
