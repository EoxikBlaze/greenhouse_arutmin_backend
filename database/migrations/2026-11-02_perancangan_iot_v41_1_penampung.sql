-- ============================================================================
-- MIGRASI — Penyesuaian Perancangan Sistem IoT Hidroponik 1 Penampung v4.1
--           & Wiring Sistem v2.0 & Kontrak MQTT Hidro Control
-- Tanggal : 2026-11-02
-- Sumber  :
--   1. Perancangan_Sistem_IoT_Hidroponik_1_Penampung_v4_1.docx / Perancangan_Sistem_v4.1.md
--   2. Wiring_Sistem_IoT_Hidroponik_1_Penampung_v2.docx / Wiring_Sistem_v2.0.md
--   3. Kontrak_MQTT_Hidro_Control.docx
--   4. Penjelasan_Alur_Sistem_IoT_Hidroponik_1_Penampung.docx
-- Idempoten & Forward-Only: INSERT ... ON CONFLICT DO NOTHING / DO UPDATE aman.
-- ============================================================================

BEGIN;

-- ── A. Parameter Dosing & Saklar Sistem 1-Penampung v4.1 ─────────────────────
INSERT INTO konfigurasi_dosis (param, nilai, satuan, keterangan, sumber) VALUES
    ('volume_efektif_l',          200,     'L',
        'Volume efektif penampung portable (wajib > 0 L agar dosing diizinkan)',
        'Perancangan v4.1 Bab 4 / Pengaturan Alat'),
    ('jumlah_talang',               5,     'talang',
        'Jumlah talang meja yang disuplai oleh 1 penampung untuk hitung waktu putaran larutan',
        'Perancangan v4.1 Bab 2 / Pengaturan Alat'),
    ('debit_per_talang_lpm',      1.0,     'L/menit',
        'Debit aliran per talang (T_putar = volume / (talang x debit))',
        'Perancangan v4.1 Bab 2 / Pengaturan Alat'),
    ('saklar_ab',                   1,     'status',
        'Saklar izin dosing nutrisi A + B (1 = menyala, 0 = mati / peringatan saja)',
        'Perancangan v4.1 Bab 3.3 / Saklar & Mode'),
    ('saklar_ph_up',                1,     'status',
        'Saklar izin koreksi pH Up (1 = menyala, 0 = mati / tidur pH)',
        'Perancangan v4.1 Bab 3.3 / Saklar & Mode'),
    ('saklar_ph_down',              1,     'status',
        'Saklar izin koreksi pH Down (1 = menyala, 0 = mati / tidur pH)',
        'Perancangan v4.1 Bab 3.3 / Saklar & Mode'),
    ('saklar_pengenceran',          1,     'status',
        'Saklar izin pengenceran air untuk menurunkan EC (hanya jalan bila isi air otomatis menyala)',
        'Perancangan v4.1 Bab 3.3 / Saklar & Mode'),
    ('mode_isi_otomatis',           1,     'status',
        'Mode pengisian air penampung (1 = otomatis mengikuti float bawah/atas, 0 = manual)',
        'Perancangan v4.1 Bab 3.1 / Saklar & Mode'),
    ('ppm_per_ml',             100.70,     'ppm/mL',
        'Kenaikan EC (ppm) per 1 mL larutan A+B pada 1 L air hasil Uji Lab EC',
        'Perancangan v4.1 Bab 6.1 / Uji Lab'),
    ('ph_up_ml_per_ph_l',       1.000,     'mL/pH/L',
        'Takaran mL pH Up untuk menaikkan 1 satuan pH per 1 L air hasil Uji Lab pH',
        'Perancangan v4.1 Bab 6.2 / Uji Lab'),
    ('ph_down_ml_per_ph_l',     1.000,     'mL/pH/L',
        'Takaran mL pH Down untuk menurunkan 1 satuan pH per 1 L air hasil Uji Lab pH',
        'Perancangan v4.1 Bab 6.2 / Uji Lab'),
    ('laju_pompa_a_mls',         1.00,     'mL/detik',
        'Laju alir Pompa A hasil kalibrasi takar gelas ukur',
        'Perancangan v4.1 Bab 7.3 / Kalibrasi Pompa'),
    ('laju_pompa_b_mls',         2.10,     'mL/detik',
        'Laju alir Pompa B hasil kalibrasi takar gelas ukur',
        'Perancangan v4.1 Bab 7.3 / Kalibrasi Pompa'),
    ('laju_pompa_ph_up_mls',     1.50,     'mL/detik',
        'Laju alir Pompa pH Up hasil kalibrasi takar gelas ukur',
        'Perancangan v4.1 Bab 7.3 / Kalibrasi Pompa'),
    ('laju_pompa_ph_down_mls',   1.53,     'mL/detik',
        'Laju alir Pompa pH Down hasil kalibrasi takar gelas ukur',
        'Perancangan v4.1 Bab 7.3 / Kalibrasi Pompa'),
    ('batas_ec_bawah_ppm',        900,     'ppm',
        'Batas aman EC bawah tanaman (isi 0 saat tidur agar air bersih tidak memicu alarm)',
        'Perancangan v4.1 Bab 5 / Pengaturan Alat'),
    ('batas_ec_atas_ppm',        1500,     'ppm',
        'Batas aman EC atas tanaman',
        'Perancangan v4.1 Bab 5 / Pengaturan Alat'),
    ('batas_ph_bawah',            5.0,     'pH',
        'Batas aman pH bawah tanaman',
        'Perancangan v4.1 Bab 5 / Pengaturan Alat'),
    ('batas_ph_atas',             7.0,     'pH',
        'Batas aman pH atas tanaman',
        'Perancangan v4.1 Bab 5 / Pengaturan Alat'),
    ('ph_maks_ml',                  0,     'mL',
        'Batas mL per koreksi pH (0 = otomatis dari volume: maks(5, 0,2 x volume_l) mL)',
        'Perancangan v4.1 Bab 5 / Pengaturan Alat'),
    ('maks_penjagaan_ec_hari',     10,     'kali/hari',
        'Batas harian penjagaan EC gabungan (dosing A+B + pengenceran), reset pukul 00:00',
        'Perancangan v4.1 Bab 5.4 / Saklar & Mode'),
    ('maks_pengenceran_hari',       3,     'kali/hari',
        'Batas harian pengenceran air (bagian dari 10 penjagaan EC), reset pukul 00:00',
        'Perancangan v4.1 Bab 5.4 / Saklar & Mode'),
    ('maks_koreksi_ph_hari',        5,     'kali/hari',
        'Batas harian koreksi pH (pH Up + pH Down), jeda 120 menit, reset pukul 00:00',
        'Perancangan v4.1 Bab 5.4 / Saklar & Mode')
ON CONFLICT (param) DO NOTHING;

-- ── B. Timing Operasi v4.1 ───────────────────────────────────────────────────
INSERT INTO timing_operasi (param, nilai, satuan, keterangan, sumber) VALUES
    ('jeda_ec_menit',              20,     'menit',
        'Jeda antar tindakan penjagaan EC / pengenceran (1-240 menit)',
        'Perancangan v4.1 Bab 4 / Pengaturan Alat'),
    ('pemeliharaan_maks_menit',   120,     'menit',
        'Batas waktu mode pemeliharaan / kuras sebelum kembali bekerja otomatis (5-360 menit)',
        'Perancangan v4.1 Bab 8 / Pengaturan Alat'),
    ('jeda_koreksi_ph_menit',     120,     'menit',
        'Jeda wajib antar suntikan koreksi pH agar asam/basa tercampur penuh',
        'Perancangan v4.1 Bab 5.3')
ON CONFLICT (param) DO NOTHING;

-- ── C. Aturan Fail-Safe Tambahan v4.1 (1-Penampung & Interlock Fisik) ────────
INSERT INTO aturan_fail_safe (kode, kondisi, aksi, ambang, satuan, sumber) VALUES
    ('FS-V41-AIR-DIGANTI',
        'EC turun mendadak >= 200 ppm dan >= 30% dalam 10 menit (bukan saat ISI/ENCER)',
        'Curiga air dikuras/diganti -> tahan dosing otomatis + kirim peringatan AIR_DIGANTI sampai dikonfirmasi petani',
        200, 'ppm', 'Perancangan v4.1 Bab 8.2 / Penjelasan Alur'),
    ('FS-V41-INTERLOCK-FLOAT',
        'Float atas mengambang (air penuh)',
        'Relay interlock fisik DPDT memutus jalur daya pompa isi air 12V secara langsung walau MCU hang',
        1, 'float_atas', 'Wiring Sistem v2.0 Bab 5'),
    ('FS-V41-ISI-SERING',
        'Pengisian air otomatis terjadi > 6 kali dalam satu hari',
        'Kirim peringatan kuning ISI_SERING (curiga kebocoran talang atau penampung)',
        6, 'kali/hari', 'Perancangan v4.1 Bab 9 / lib/harian.php'),
    ('FS-V41-PAPAN-BARU',
        'ESP32 pengganti menyala dengan flash NVS kosong (status BARU)',
        'Tahan dosing sampai paket parameter & 6 arsip kalibrasi dikirim lewat Pemulihan Papan',
        NULL, NULL, 'Perancangan v4.1 Bab 10 / Kontrak MQTT')
ON CONFLICT (kode) DO NOTHING;

-- ── D. Mapping Pin GPIO ESP32 sesuai Wiring Sistem v2.0 (1 Penampung) ────────
INSERT INTO mapping_channel_esp32 (kode, kategori, nama, jumlah_channel, pin_gpio, keterangan, sumber) VALUES
    ('V2-SENS-EC',    'sensor_input',   'Sensor EC/TDS Analog (Wadah Alir)', 1, 'GPIO 34 (ADC1_CH6)', 'Input analog hanya-baca; probe terendam tetap di wadah ukur pipa balik', 'Wiring Sistem v2.0 Bab 3'),
    ('V2-SENS-PH',    'sensor_input',   'Sensor pH Analog (Wadah Alir)',     1, 'GPIO 35 (ADC1_CH7)', 'Input analog hanya-baca; kalibrasi 2 titik buffer 4,0 & 7,0', 'Wiring Sistem v2.0 Bab 3'),
    ('V2-SENS-SUHU',  'sensor_input',   'Sensor Suhu Air DS18B20 + DHT22',   2, 'GPIO 4 & GPIO 17',   'DS18B20 (GPIO 4 pull-up 4,7k) + DHT22 ruang (GPIO 17)', 'Wiring Sistem v2.0 Bab 3'),
    ('V2-FLOAT-2',    'digital_input',  'Pelampung Bawah & Pelampung Atas',  2, 'GPIO 32 & GPIO 33',  'Float bawah (GPIO 32: 0=turun/kurang, 1=cukup); Float atas (GPIO 33 + interlock fisik)', 'Wiring Sistem v2.0 Bab 3 & 5'),
    ('V2-BTN-RESET',  'digital_input',  'Tombol Fisik RESET di Boks Panel',  1, 'GPIO 13',            'Ditekan 3 detik untuk membuka penguncian (LOCK) dari lokasi', 'Wiring Sistem v2.0 Bab 3'),
    ('V2-RELAY-5',    'relay_output',   'Relay 8-Ch Aktuator 12V DC (IN1-5)',5, 'GPIO 25,26,27,18,16','IN1=Pompa A (25), IN2=Pompa B (26), IN3=pH Up (27), IN4=pH Down (18), IN5=Pompa Isi 12V (16)', 'Wiring Sistem v2.0 Bab 4')
ON CONFLICT (kode) DO NOTHING;

COMMIT;

