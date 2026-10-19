-- ============================================================================
-- MIGRASI — jadwal perawatan rutin, kalibrasi sensor, mapping channel ESP32
-- Tanggal : 2026-10-19
-- Sumber  : Perancangan_Sistem_IoT_Hidroponik_FINAL.docx
--           seksi 11 Tabel 14 (Jadwal Perawatan Rutin),
--           seksi 10 par.212-220 (Kalibrasi dan Uji Coba Bertahap),
--           Lampiran A Tabel 17 (kebutuhan channel) + Tabel 18 (tabel pin/kabel),
--           seksi 12 Tabel 15 (BOM: jumlah unit per komponen).
-- Jalankan: psql "$DATABASE_URL" -f database/migrations/2026-10-19_perancangan_jadwal_kalibrasi_channel.sql
-- Idempoten: CREATE TABLE IF NOT EXISTS + INSERT ... ON CONFLICT DO NOTHING.
-- Forward-only: tabel baru saja.
-- Catatan: `hasil_ukur` pada kalibrasi_sensor sengaja NULL — isi setelah
--          pengukuran lapangan (Lampiran B par.252: hasil ukur masih kosong).
-- ============================================================================

BEGIN;

-- ── A. jadwal_perawatan — Tabel 14 (seksi 11) ──────────────────────────────
CREATE TABLE IF NOT EXISTS jadwal_perawatan (
    kode        varchar(24) NOT NULL,
    periode     varchar(24) NOT NULL,
    periode_hari integer,
    kegiatan    text NOT NULL,
    lama_menit  integer,
    sumber      varchar(120),
    CONSTRAINT jadwal_perawatan_pkey PRIMARY KEY (kode)
);

COMMENT ON TABLE jadwal_perawatan IS
    'Jadwal perawatan rutin — Perancangan FINAL seksi 11 Tabel 14';

INSERT INTO jadwal_perawatan (kode, periode, periode_hari, kegiatan, lama_menit, sumber) VALUES
    ('HARIAN', 'HARIAN', 1,
        'Lihat notifikasi HP; pastikan air penampung cukup; pastikan botol sampel terisi dan float responsif; kuras kerak ringan bila kelihatan',
        5, 'Perancangan FINAL seksi 11 Tabel 14'),
    ('MINGGUAN', 'MINGGUAN', 7,
        'Kalibrasi pH (buffer 4,0 / 6,86); bersihkan probe EC & pH dari kerak; cek pompa bilas & wadah air bersih; cek float isi air',
        20, 'Perancangan FINAL seksi 11 Tabel 14'),
    ('DUA_MINGGU', '2 MINGGU', 14,
        'Uji takaran peristaltik (timbang 1 pulse) - cocokkan tabel dosis; cek check valve & selang dosing',
        30, 'Perancangan FINAL seksi 11 Tabel 14'),
    ('BULANAN', 'BULANAN', 30,
        'Kalibrasi EC (larutan 1413 µS/cm); bersihkan seluruh selang & manifold; cek baut/klamp; uji tombol E-STOP & RESET',
        60, 'Perancangan FINAL seksi 11 Tabel 14'),
    ('KAPAN_PERLU', 'KAPAN PERLU', NULL,
        'Kalibrasi ulang setelah pindah posisi sensor / ganti probe / mati listrik panjang',
        NULL, 'Perancangan FINAL seksi 11 Tabel 14')
ON CONFLICT (kode) DO NOTHING;

-- ── B. kalibrasi_sensor — seksi 10 + seksi 11 + Lampiran B ─────────────────
CREATE TABLE IF NOT EXISTS kalibrasi_sensor (
    sensor           varchar(32) NOT NULL,
    metode           text NOT NULL,
    larutan_ref      varchar(64),
    nilai_ref        numeric(10,3),
    satuan           varchar(24),
    periode_hari_min integer,
    periode_hari_max integer,
    penyimpanan      varchar(64),
    hasil_ukur       numeric(10,3),
    terakhir_dikalibrasi timestamp without time zone,
    keterangan       text,
    sumber           varchar(120),
    CONSTRAINT kalibrasi_sensor_pkey PRIMARY KEY (sensor)
);

COMMENT ON TABLE kalibrasi_sensor IS
    'Kalibrasi & uji lapangan per parameter — Perancangan FINAL seksi 10 + Lampiran B par.252';

INSERT INTO kalibrasi_sensor
    (sensor, metode, larutan_ref, nilai_ref, satuan, periode_hari_min, periode_hari_max, penyimpanan, hasil_ukur, keterangan, sumber) VALUES
    ('ph', 'Kalibrasi 2 titik dengan buffer', 'Buffer pH 4,0 dan 6,86', NULL, 'pH', 7, 14, 'Larutan KCl', NULL,
        'Kalibrasi pH tiap 1-2 minggu (probe paling rentan); hasil_ukur = NULL sampai kalibrasi lapangan',
        'Perancangan FINAL seksi 10 par.212 & par.220'),
    ('ec', 'Kalibrasi dengan larutan standar', 'Larutan 1413 µS/cm', 1413, 'µS/cm', 28, 28, 'Larutan KCl', NULL,
        'Kalibrasi EC tiap 4 minggu; hasil_ukur = NULL sampai kalibrasi lapangan',
        'Perancangan FINAL seksi 10 par.212 & par.220'),
    ('debit_sirkulasi', 'Ukur pakai ember: liter/menit per meja', NULL, NULL, 'L/menit', NULL, NULL, NULL, NULL,
        'Konfirmasi tabel 4.4 (laju per meja) — masih "…" di dokumen',
        'Perancangan FINAL seksi 10 par.213 / Lampiran B par.252'),
    ('durasi_bilas', 'Stopwatch pompa celup bilas sampai ±300 mL', NULL, 300, 'mL', NULL, NULL, NULL, NULL,
        'Acuan ≥ 2× isi pipa; durasi detik = parameter program',
        'Perancangan FINAL seksi 10 par.214 / seksi 4.2 par.73'),
    ('waktu_isi_botol', 'Timer per penampung + timeout penuh yang aman', NULL, NULL, 'detik', NULL, NULL, NULL, NULL,
        'Timeout awal 60 detik; final = 2× hasil ukur — masih "…" untuk hasil akhir',
        'Perancangan FINAL seksi 10 par.215 / Lampiran B par.252'),
    ('pulsa_peristaltik', 'Timbang mL per detik tiap pompa', NULL, NULL, 'mL/detik', 14, 14, NULL, NULL,
        'Cocokkan dengan tabel dosis (Tabel 4); pengujian 2 mingguan',
        'Perancangan FINAL seksi 10 par.216 / Tabel 14'),
    ('mixing', 'Uji TANPA aduk: dosis kecil → sampel tiap 2 menit → EC berhenti berubah', NULL, 15, 'menit', NULL, NULL, NULL, NULL,
        'Konfirmasi (boleh dipangkas) mixing 15 menit seragam',
        'Perancangan FINAL seksi 10 par.217 / seksi 4.4 par.94'),
    ('bilas_anti_endapan', 'Dosis A → bilas → cek EC air keluar bilas sebelum B', NULL, NULL, 'mS/cm', NULL, NULL, NULL, NULL,
        'Harus mendekati air bersih; uji bilas anti-endapan',
        'Perancangan FINAL seksi 10 par.218')
ON CONFLICT (sensor) DO NOTHING;

-- ── C. mapping_channel_esp32 — Lampiran A ──────────────────────────────────
CREATE TABLE IF NOT EXISTS mapping_channel_esp32 (
    kode          varchar(32) NOT NULL,
    kategori      varchar(24) NOT NULL,
    nama          varchar(80) NOT NULL,
    jumlah_channel smallint,
    pin_gpio      varchar(40),
    keterangan    text,
    sumber        varchar(120),
    CONSTRAINT mapping_channel_esp32_pkey PRIMARY KEY (kode)
);

COMMENT ON TABLE mapping_channel_esp32 IS
    'Pembagian channel & pin ESP32 — Perancangan FINAL Lampiran A Tabel 17 & Tabel 18';

INSERT INTO mapping_channel_esp32 (kode, kategori, nama, jumlah_channel, pin_gpio, keterangan, sumber) VALUES
    -- Tabel 17 — pembagian channel logis
    ('CH-ISI-AIR', 'kelompok_channel', 'Isi air', 5, NULL,
        '4 solenoid + 1 contactor', 'Perancangan FINAL Lampiran A Tabel 17'),
    ('CH-SAMPLING', 'kelompok_channel', 'Sampling', 8, NULL,
        '4 pompa celup + 4 solenoid return', 'Perancangan FINAL Lampiran A Tabel 17'),
    ('CH-DOSING', 'kelompok_channel', 'Dosing', 9, NULL,
        '4 peristaltik (A, B, pH Up, pH Down) + 4 solenoid cabang + 1 pompa bilas', 'Perancangan FINAL Lampiran A Tabel 17'),
    ('CH-SIRKULASI', 'kelompok_channel', 'Sirkulasi & aerator', 0, NULL,
        'Langsung listrik, di luar panel alat & di luar E-STOP', 'Perancangan FINAL Lampiran A Tabel 17'),
    ('CH-TOTAL-OUTPUT', 'kelompok_channel', 'TOTAL OUTPUT', 26, NULL,
        '5 + 8 + 9 + 4 indikator = 26 channel terpakai dari 32 (2× MCP23017)', 'Perancangan FINAL Lampiran A Tabel 17'),
    ('CH-INDIKATOR', 'kelompok_channel', 'Indikator pilot lamp', 4, NULL,
        '4 pilot lamp RGB (sisa channel MCP23017); hijau/kuning/merah per penampung', 'Perancangan FINAL Lampiran A Tabel 17'),
    ('CH-INPUT', 'kelompok_channel', 'INPUT', 8, NULL,
        '4 float isi + 1 float botol + tombol E-STOP & RESET', 'Perancangan FINAL Lampiran A Tabel 17'),
    -- Tabel 18 — pin/kabel
    ('PIN-I2C', 'pin', 'Bus I2C bersama (MCP23017 #1 & #2, SEN0334, ADS1115, LCD 20×4)', NULL, '21,22',
        'GPIO 21 = SDA, GPIO 22 = SCL', 'Perancangan FINAL Lampiran A Tabel 18'),
    ('PIN-ADC-EC-PH', 'pin', 'ADC eksternal ADS1115 untuk sensor EC & pH', NULL, 'I2C',
        'ADC1 bawaan cadangan; hindari ADC2 (bentrok WiFi)', 'Perancangan FINAL Lampiran A Tabel 18 / par.242'),
    ('PIN-DS18B20', 'pin', 'Sensor suhu air DS18B20', NULL, '4',
        'GPIO 4 digital, kabel 3 inti + resistor pull-up', 'Perancangan FINAL Lampiran A Tabel 18'),
    ('PIN-FLOAT', 'pin', 'Float switch (4 isi air + 1 penuh botol)', NULL, '34-39',
        'GPIO 34-39 input; 1 kabel ground bersama', 'Perancangan FINAL Lampiran A Tabel 18 / par.243'),
    ('PIN-TOMBOL', 'pin', 'Tombol E-STOP (status) & RESET', NULL, '18,19',
        'GPIO 18 = E-STOP, GPIO 19 = RESET; pemutus daya E-STOP jalur fisis', 'Perancangan FINAL Lampiran A Tabel 18'),
    ('PIN-MCP23017-1', 'pin', 'MCP23017 #1 — relay solenoid & contactor', 13, 'I2C',
        'solenoid return 4 + solenoid cabang dosing 4 + solenoid isi 4 + contactor 1 (dari 16 ch)', 'Perancangan FINAL Lampiran A Tabel 18'),
    ('PIN-MCP23017-2', 'pin', 'MCP23017 #2 — pompa celup sampling, peristaltik, bilas', 9, 'I2C',
        'pompa celup sampling 4 + peristaltik 4 + pompa bilas 1; sisa channel cadangan', 'Perancangan FINAL Lampiran A Tabel 18'),
    ('PIN-RELAY-CADANGAN', 'pin', 'Relay modul optocoupled total', 22, NULL,
        '±22 channel dari 3-4 modul relay 8-16 ch (22 output > ±18 pin aman ESP32 → wajib MCP23017)', 'Perancangan FINAL Lampiran A par.241 / Tabel 15')
ON CONFLICT (kode) DO NOTHING;

COMMIT;

-- Verifikasi (jalankan paska-migrasi):
--   SELECT kode, periode, periode_hari, lama_menit FROM jadwal_perawatan ORDER BY periode_hari NULLS LAST;
--   SELECT sensor, larutan_ref, periode_hari_min, periode_hari_max FROM kalibrasi_sensor ORDER BY sensor;
--   SELECT kategori, sum(jumlah_channel) FROM mapping_channel_esp32 WHERE kategori='kelompok_channel' GROUP BY 1;
--   SELECT count(*) FROM mapping_channel_esp32;  -- harus 15 (7 channel + 8 pin)
