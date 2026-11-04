-- DESTRUKTIF: menunggu-konfirmasi
-- Sistem dipersempit untuk MELON dan SATU kebun. Migrasi ini MENGHAPUS data operasional lama.
-- Tidak dijalankan oleh `npm run migrate` sebelum pengguna menyetujui daftar di bawah
-- (jalankan: node scripts/migrate.js --izinkan-destruktif). Cadangkan DB dulu (scripts/backup-pi.sh).
--
-- DIHAPUS (seluruh isi):
--   monitorings, sensor_readings (+partisi), sensor_readings_hourly, sensor_readings_latest, sensor_overrides,
--   alert_logs, anomali, anomali_tindakan, notifikasi, notifikasi_baca,
--   dosing_events, dosing_rounds, dosing_transisi, persetujuan_dosing, rekomendasi_dosing,
--   perintah_aktuator, permintaan_konfirmasi, penugasan_penampung, pemetaan_katup,
--   siklus_budidaya, siklus_lot, siklus_transisi, semais, peremajaans, pendewasaans, panens,
--   water_fill_events, report_logs, kalibrasi_log, uji_lab, penampung_states
-- DIHAPUS SEBAGIAN:
--   tanamen / sikluses / target_nutrisi / preset_nutrisi (+preset_versi) : semua yang BUKAN Melon (target_nutrisi global tanpa tanaman tetap)
--   mejas : semua baris dihapus kecuali satu, lalu dinamai "Kebun Melon" (jangkar teknis; kolom NFT/DFT dikosongkan)
-- DIPERTAHANKAN: users, perangkat, api_keys, audit_logs, konfigurasi_dosis, timing_operasi, aturan_fail_safe,
--   jadwal_perawatan, kalibrasi_sensor, mapping_channel_esp32, sensor_thresholds, jenis_alert, preset Melon,
--   wa_settings, cctv_kameras, water_controls, saklar_aktuator, aktuator_state.
BEGIN;

TRUNCATE
  monitorings, sensor_readings, sensor_readings_hourly, sensor_readings_latest, sensor_overrides,
  alert_logs, anomali, anomali_tindakan, notifikasi, notifikasi_baca,
  dosing_events, dosing_rounds, dosing_transisi, persetujuan_dosing, rekomendasi_dosing,
  perintah_aktuator, permintaan_konfirmasi, penugasan_penampung, pemetaan_katup,
  siklus_budidaya, siklus_lot, siklus_transisi, semais, peremajaans, pendewasaans, panens,
  water_fill_events, report_logs, kalibrasi_log, uji_lab, penampung_states
  RESTART IDENTITY;

-- preset nutrisi milik tanaman lain ikut dihapus (FK RESTRICT, saling menunjuk dengan preset_versi)
UPDATE preset_nutrisi SET aktif_versi_id = NULL WHERE id_tanaman IN (SELECT id_tanaman FROM tanamen WHERE lower(nama_tanaman) <> 'melon');
ALTER TABLE preset_versi DISABLE TRIGGER USER; -- versi preset dibekukan oleh trigger; dimatikan sementara di transaksi ini
DELETE FROM preset_versi WHERE id_preset IN (SELECT id FROM preset_nutrisi WHERE id_tanaman IN (SELECT id_tanaman FROM tanamen WHERE lower(nama_tanaman) <> 'melon'));
DELETE FROM preset_nutrisi WHERE id_tanaman IN (SELECT id_tanaman FROM tanamen WHERE lower(nama_tanaman) <> 'melon');
ALTER TABLE preset_versi ENABLE TRIGGER USER;

-- master tanaman: hanya Melon
DELETE FROM tanamen WHERE lower(nama_tanaman) <> 'melon';
INSERT INTO tanamen (nama_tanaman)
SELECT 'Melon' WHERE NOT EXISTS (SELECT 1 FROM tanamen WHERE lower(nama_tanaman) = 'melon');
UPDATE tanamen SET id_meja = NULL;

INSERT INTO sikluses (id_tanaman, nama_siklus, waktu_siklus)
SELECT t.id_tanaman, v.nama, v.hari
  FROM tanamen t, (VALUES ('Semai', 10), ('Peremajaan', 21), ('Pendewasaan', 50)) AS v(nama, hari)
 WHERE lower(t.nama_tanaman) = 'melon'
   AND NOT EXISTS (SELECT 1 FROM sikluses s WHERE s.id_tanaman = t.id_tanaman AND s.nama_siklus = v.nama);
DELETE FROM sikluses WHERE id_tanaman IS NULL OR id_tanaman NOT IN (SELECT id_tanaman FROM tanamen);
DELETE FROM target_nutrisi WHERE id_tanaman IS NOT NULL AND id_tanaman NOT IN (SELECT id_tanaman FROM tanamen);

-- satu kebun: sisakan satu meja, jadikan "Kebun Melon"
DELETE FROM mejas WHERE id_meja <> COALESCE((SELECT min(id_meja) FROM mejas), -1);
INSERT INTO mejas (meja, jumlah_lubang, created_at, updated_at)
SELECT 'Kebun Melon', 1, now(), now() WHERE NOT EXISTS (SELECT 1 FROM mejas);
UPDATE mejas SET meja = 'Kebun Melon', jenis_talang = NULL, jumlah_talang = NULL, lubang_per_talang = NULL,
                 panjang_talang_m = NULL, laju_per_talang_lpm = NULL;
INSERT INTO penampung_states (id_meja) SELECT id_meja FROM mejas ON CONFLICT (id_meja) DO NOTHING;

COMMIT;
