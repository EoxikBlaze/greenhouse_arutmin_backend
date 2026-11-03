-- ============================================================================
-- KOREKSI AMAN modul IoT v4.1 (3 Nov 2026) — forward-only, aditif; tidak mengubah migrasi 2026-11-02.
-- Alasan: docs/TINJAUAN_MIGRASI_IOT_V41.md (temuan 5, 6, 4) dan keputusan pemilik 3 Nov 2026
--   (tahap awal hanya saran; kontrak MQTT garap/; pemetaan GPIO mengikuti Wiring v2.0 tetapi firmware v0.2 belum selaras).
-- Aman dijalankan ulang. Tidak menyentuh baris yang sudah diubah pengguna lewat aplikasi (sumber 'Aplikasi Web v4.1').
-- ============================================================================
BEGIN;

-- 1. Semua saklar izin dan mode isi otomatis MATI sampai pemilik menyalakannya (aman-secara-bawaan).
UPDATE konfigurasi_dosis
   SET nilai = 0, diubah_pada = CURRENT_TIMESTAMP
 WHERE param IN ('saklar_ab', 'saklar_ph_up', 'saklar_ph_down', 'saklar_pengenceran', 'mode_isi_otomatis')
   AND sumber LIKE 'Perancangan v4.1%'
   AND nilai IS DISTINCT FROM 0;

-- 2. Pemetaan GPIO: tandai bentrok dengan firmware aktuator v0.2 (GPIO 32/33 output di v0.2, pelampung input di wiring v2.0).
UPDATE mapping_channel_esp32
   SET keterangan = keterangan || ' [PERINGATAN 3 Nov 2026: firmware aktuator v0.2 memakai GPIO 32/33 sebagai OUTPUT; jangan flash v0.2 pada wiring v2.0 sebelum firmware diselaraskan dan pin diverifikasi di perangkat keras.]'
 WHERE kode IN ('V2-FLOAT-2', 'V2-RELAY-5')
   AND keterangan NOT LIKE '%PERINGATAN 3 Nov 2026%';

COMMIT;
