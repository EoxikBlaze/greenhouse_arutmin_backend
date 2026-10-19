-- ============================================================================
-- MIGRASI — parameter dosis AB mix, timing operasi, dan aturan fail-safe
-- Tanggal : 2026-10-19
-- Sumber  : Perancangan_Sistem_IoT_Hidroponik_FINAL.docx
--           seksi 2.2 Tabel 3-4 (k = 196, tabel takaran pulse),
--           seksi 2.3 par.51 (aturan 65% per ronde, maks 300 ppm ≈ 214 mL),
--           seksi 1.6 par.35 (8 kejadian/hari, 500 mL/hari),
--           Tabel 12 + Tabel 13 "Ringkasan Timing Operasi" (seksi 8)
--           + "Aturan Batas dan Fail-safe" (seksi 9),
--           seksi 5 Aturan 3/4/6/7/8/9/11/14 (timeout, retry, LOCK, alert),
--           seksi 4.1 par.60 + seksi 9 par.209-210 (sanity & 3× invalid).
-- Jalankan: psql "$DATABASE_URL" -f database/migrations/2026-10-19_perancangan_konfigurasi_dosis.sql
-- Idempoten: CREATE TABLE IF NOT EXISTS + INSERT ... ON CONFLICT DO NOTHING
--            (nilai sudah ada TIDAK ditimpa — perubahan via aplikasi aman).
-- Forward-only: tabel baru saja; tidak menyentuh tabel yang sudah ada.
-- Catatan: aturan diimplementasikan di ESP32 (seksi 5 par.97 "empat belas
--          aturan sumber tunggal logika kontrol"); tabel ini adalah salinan
--          terstruktur untuk web/API/kalibrasi — bukan firmware.
-- ============================================================================

BEGIN;

-- ── A. konfigurasi_dosis — parameter perhitungan & pagar dosis ─────────────
CREATE TABLE IF NOT EXISTS konfigurasi_dosis (
    param      varchar(64) NOT NULL,
    nilai      numeric(12,4) NOT NULL,
    satuan     varchar(24) NOT NULL,
    keterangan text,
    sumber     varchar(120),
    diubah_pada timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT konfigurasi_dosis_pkey PRIMARY KEY (param)
);

COMMENT ON TABLE konfigurasi_dosis IS
    'Parameter dosis AB mix & pagar harian — Perancangan FINAL seksi 2.2/2.3 + Tabel 13';

INSERT INTO konfigurasi_dosis (param, nilai, satuan, keterangan, sumber) VALUES
    ('k_faktor',                  196,    'faktor',
        'K = rata-rata dua uji (201 dan 191), dipakai k=196 mS/cm',
        'Perancangan FINAL seksi 2.2 Tabel 3'),
    ('persen_ronde_dosis',         65,    '%',
        'Dosis per ronde = 65% dari kekurangan; tidak pernah 100% sekaligus',
        'Perancangan FINAL seksi 2.3 par.51'),
    ('maks_ppm_per_suntikan',     300,    'ppm',
        'Batas per suntikan (0,6 mS/cm)',
        'Perancangan FINAL seksi 2.3 par.51 / Tabel 13'),
    ('maks_ms_per_suntikan',     0.6,     'mS/cm',
        'Batas per suntikan setara 300 ppm',
        'Perancangan FINAL seksi 2.3 par.51'),
    ('maks_ml_per_suntikan',     214,     'mL',
        'Setara 300 ppm / 0,6 mS/cm pada penampung 70 L',
        'Perancangan FINAL seksi 2.3 par.51'),
    ('maks_suntikan_per_kejadian', 5,     'suntikan',
        '1 kejadian dosing = sesi sampai 5 suntikan dengan baca ulang',
        'Perancangan FINAL seksi 1.6 par.35 / Tabel 2'),
    ('maks_kejadian_per_hari',    8,      'kejadian',
        'Retry TIDAK memotong jatah kejadian; reset pukul 00:00',
        'Perancangan FINAL seksi 1.6 par.35 / Tabel 13'),
    ('maks_volume_ab_hari_ml',  500,      'mL/hari',
        'Pagar utama — SEMUA suntikan termasuk retry dihitung',
        'Perancangan FINAL seksi 1.6 par.35 / Tabel 13'),
    ('maks_volume_ph_hari_ml',  100,      'mL/hari',
        'pH Up/Down per penampung, reset 00:00',
        'Perancangan FINAL Tabel 13'),
    ('maks_retry_ec',             5,      'kali',
        'Retry EC per penampung sebelum ALERT + LOCK',
        'Perancangan FINAL Aturan 7 par.143 / Tabel 13'),
    ('maks_retry_ph',             3,      'kali',
        'Retry pH per penampung sebelum ALERT + LOCK',
        'Perancangan FINAL Aturan 6 par.139 / Tabel 13'),
    ('deadband_ec_ppm',         100,      'ppm',
        'Pita mati EC (±0,1 mS/cm) — masuk deadband = MONITORING',
        'Perancangan FINAL Tabel 13'),
    ('deadband_ec_ms',          0.1,      'mS/cm',
        'Pita mati EC setara 100 ppm',
        'Perancangan FINAL Tabel 13'),
    ('deadband_ph',             0.2,      'pH',
        'Pita mati pH',
        'Perancangan FINAL Tabel 13'),
    ('faktor_ppm_per_ec',        500,     'ppm per mS/cm',
        'Konversi ppm = EC x 500 (LCD & komunikasi petani)',
        'Perancangan FINAL seksi 1.6 par.38 / 2.2 par.48'),
    ('ppm_per_detik_pulsa',      4.7,     'ppm/detik',
        'Referensi cepat: 1 detik pulsa A+B ≈ +4,7 ppm di 70 L',
        'Perancangan FINAL Tabel 4'),
    ('faktor_skala_dosis_dft',   1.0714,  'kali',
        'Penampung DFT 75 L: dosis diskalakan volume (kali 75/70 ≈ +7%)',
        'Perancangan FINAL seksi 2.2 par.46'),
    ('peringatan_dini_kejadian',  3,      'kejadian berturut',
        'INFO dini ke petani sebelum jatah habis (belum LOCK)',
        'Perancangan FINAL Aturan 9 par.152'),
    ('antrian_alert_maks',       20,      'pesan',
        'Alert ditahan saat WiFi mati, maks 20 pesan + stempel waktu',
        'Perancangan FINAL Aturan 14 par.176')
ON CONFLICT (param) DO NOTHING;

-- ── B. timing_operasi — durasi & jeda operasi ──────────────────────────────
CREATE TABLE IF NOT EXISTS timing_operasi (
    param      varchar(64) NOT NULL,
    -- nilai NULL = nilai di dokumen masih "…" (belum ditentukan, menyusul kalibrasi)
    nilai      numeric(10,3),
    satuan     varchar(24) NOT NULL,
    keterangan text,
    sumber     varchar(120),
    diubah_pada timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT timing_operasi_pkey PRIMARY KEY (param)
);

COMMENT ON TABLE timing_operasi IS
    'Durasi/jeda operasi (mixing, monitoring, bilas, timeout) — Perancangan FINAL seksi 4 + Tabel 12 (Ringkasan Timing Operasi)';

INSERT INTO timing_operasi (param, nilai, satuan, keterangan, sumber) VALUES
    ('mixing_menit',            15,    'menit',
        'Tunggu tercampur rata sebelum baca ulang — seragam semua penampung',
        'Perancangan FINAL seksi 4.4 par.94 / Tabel 12'),
    ('monitoring_menit',        60,    'menit',
        'Masa istirahat setelah target tercapai; tidak disuntik apa-apa',
        'Perancangan FINAL Aturan 8 par.147 / Tabel 12'),
    ('jeda_ab_menit',            2,    'menit',
        'Jeda keamanan A sebelum B (setelah bilas #1)',
        'Perancangan FINAL seksi 4.2 par.74 / Tabel 12'),
    ('jeda_a_ke_bilas_detik',    3,    'detik',
        'Rentang 2-3 detik setelah pulsa A sebelum BILAS #1 (nilai ambil batas atas)',
        'Perancangan FINAL seksi 4.2 par.72 / Tabel 12'),
    ('jeda_pasca_bilas_detik',   2,    'detik',
        'Rentang 1-2 detik setelah bilas sebelum hitung mundur 2 menit',
        'Perancangan FINAL seksi 4.2 par.74'),
    ('volume_bilas_ml',        300,    'mL',
        'Acuan bilas per ganti cairan; aturan >= 2x isi pipa; durasi detik = kalibrasi',
        'Perancangan FINAL seksi 4.2 par.73/79 / Tabel 12'),
    ('isi_botol_timeout_detik', 60,    'detik',
        'Awal; final = 2x hasil ukur. Lewat → pompa mati + ALERT',
        'Perancangan FINAL seksi 4.1 par.66 / Tabel 13'),
    ('isi_botol_normal_detik',  30,    'detik',
        'Isi botol sampai float penuh, rentang ±15-30 detik (terkalibrasi)',
        'Perancangan FINAL Tabel 12'),
    ('baca_stabil_timeout_detik', 120, 'detik',
        'Baca median 9 + stabil; lewat → ALERT sensor, bacaan dibuang',
        'Perancangan FINAL Tabel 12 / Aturan 4 par.129'),
    ('isi_air_timeout_menit',   15,    'menit',
        'Jam pasir pengaman isi air; final = 2x waktu isi normal; lewat → contactor OFF + ALERT',
        'Perancangan FINAL Aturan 3 par.122 / Tabel 13'),
    ('ronde_dosing_menit',      20,    'menit',
        'Satu ronde = dosing + mixing + baca',
        'Perancangan FINAL Tabel 12 / seksi 2.3 par.52'),
    ('jeda_pasca_isi_air_menit', 2,    'menit',
        'Baca segar minimal ±2 menit setelah isi selesai; perintah dosing lama dibatalkan',
        'Perancangan FINAL Aturan 3 par.124-125'),
    ('median_pembacaan_n',       9,    'bacaan',
        'Ambil nilai tengah dari 9 bacaan (buang noise kecil)',
        'Perancangan FINAL Tabel 2 / 4.1 par.60'),
    ('gap_besar_menit',         48,    'menit',
        'Contoh 102→700 ppm: 2 ronde ≈ 48 menit otomatis',
        'Perancangan FINAL Tabel 5 / Tabel 12'),
    ('reset_counter_jam',        0,    'jam (RTC)',
        'Reset counter dosis & volume harian pukul 00:00; LOCK tidak ikut direset',
        'Perancangan FINAL Aturan 11 par.159 / Tabel 12'),
    ('limit_batas_ons_pompa',  NULL,   'detik',
        'Batas waktu ON maksimum per pompa peristaltik + watchdog controller — NILAI BELUM DITENTUKAN (dokumen hanya menyebut kewajibannya)',
        'Perancangan FINAL seksi 9 par.200')
ON CONFLICT (param) DO NOTHING;

-- ── C. aturan_fail_safe — pemicu alert/LOCK & perilaku darurat ─────────────
CREATE TABLE IF NOT EXISTS aturan_fail_safe (
    kode       varchar(24) NOT NULL,
    kondisi    text NOT NULL,
    aksi       text NOT NULL,
    ambang     numeric(12,3),
    satuan     varchar(24),
    aktif      boolean DEFAULT true NOT NULL,
    sumber     varchar(120),
    CONSTRAINT aturan_fail_safe_pkey PRIMARY KEY (kode)
);

COMMENT ON TABLE aturan_fail_safe IS
    'Fail-safe & pemicu alert/LOCK — Perancangan FINAL seksi 5 (Aturan 9-14) + seksi 9';

INSERT INTO aturan_fail_safe (kode, kondisi, aksi, ambang, satuan, sumber) VALUES
    ('FS-TIMEOUT-ISI-AIR',
        'Isi air melewati timeout',
        'Contactor mati + ALERT ke HP petani (tandon habis / keran lupa / selang lepas)',
        15, 'menit', 'Perancangan FINAL Aturan 3 par.122 / seksi 9'),
    ('FS-TIMEOUT-ISI-BOTOL',
        'Pompa isi botol menyala melewati timeout tetapi float tidak naik',
        'Pompa mati + ALERT (float macet / selang bocor)',
        60, 'detik', 'Perancangan FINAL seksi 4.1 par.66 / Aturan 4'),
    ('FS-TIMEOUT-BACA',
        'Bacaan tidak stabil lewat timeout',
        'ALERT sensor, bacaan dibuang',
        120, 'detik', 'Perancangan FINAL Aturan 4 par.129 / Tabel 13'),
    ('FS-SENSOR-INVALID-3X',
        '3 kali bacaan invalid berturut-turut',
        'ALERT sensor + LOCK dosing penampung; sirkulasi & isi air tetap jalan',
        3, 'kali', 'Perancangan FINAL seksi 9 par.210'),
    ('FS-SANITY-EC',
        'Bacaan EC di luar rentang fisik wajar (0,1-5 mS/cm = 50-2500 ppm)',
        'Bacaan mustahil DIBUANG (sanity check)',
        NULL, NULL, 'Perancangan FINAL seksi 4.1 par.60 / seksi 9 par.209'),
    ('FS-SANITY-PH',
        'Bacaan pH di luar rentang fisik wajar (3-9)',
        'Bacaan mustahil DIBUANG (sanity check)',
        NULL, NULL, 'Perancangan FINAL seksi 4.1 par.60 / seksi 9 par.209'),
    ('FS-SANITY-SUHU-AIR',
        'Bacaan suhu air di luar rentang fisik wajar (5-45 C)',
        'Bacaan mustahil DIBUANG (sanity check)',
        NULL, NULL, 'Perancangan FINAL seksi 4.1 par.60 / seksi 9 par.209'),
    ('FS-LONJAKAN-EC',
        'Lonjakan EC > 0,5 mS/cm antar bacaan berurutan',
        'Baca ulang dulu, JANGAN dosing',
        0.5, 'mS/cm', 'Perancangan FINAL seksi 4.1 par.60'),
    ('FS-JATAH-KEJADIAN',
        'Jatah kejadian dosing harian habis',
        'ALERT + LOCK penampung; reset 00:00',
        8, 'kejadian/hari', 'Perancangan FINAL seksi 1.6 par.35 / Aturan 9'),
    ('FS-JATAH-VOLUME',
        'Volume AB mix harian habis (semua suntikan termasuk retry)',
        'ALERT + LOCK penampung; reset 00:00',
        500, 'mL/hari', 'Perancangan FINAL seksi 1.6 par.35 / Aturan 9'),
    ('FS-RETRY-HABIS',
        'Retry habis (EC 5x / pH 3x) untuk satu penampung',
        'ALERT + LOCK penampung itu; sampling penampung lain lanjut normal',
        5, 'kali', 'Perancangan FINAL Aturan 7 par.143-144'),
    ('FS-EC-TINGGI-LEVEL-AMAN',
        'EC tinggi + level air AMAN, baca ulang tetap tinggi',
        'JANGAN isi, JANGAN dosis → ALERT + LOCK penampung',
        NULL, NULL, 'Perancangan FINAL Aturan 5 Tabel 9 / Aturan 9'),
    ('FS-INFO-DINI',
        'Satu penampung mencapai kejadian dosing berturut dalam sehari',
        'INFO dini ke petani (belum LOCK) — cek kebocoran talang/sensor/kebutuhan tanaman',
        3, 'kejadian berturut', 'Perancangan FINAL Aturan 9 par.152'),
    ('FS-BOOT-DEFAULT-OFF',
        'Boot / restart / error',
        'Semua pompa dosing & celup, solenoid & contactor = OFF; sirkulasi & aerator tetap ON',
        NULL, NULL, 'Perancangan FINAL Aturan 0 par.102 / seksi 9 par.199'),
    ('FS-E-STOP',
        'E-STOP ditekan',
        'Daya aktuator dosing & isi air diputus FISIK; sirkulasi & aerator tidak ikut; butuh tombol RESET untuk mulai',
        NULL, NULL, 'Perancangan FINAL Aturan 12 par.162-163 / seksi 9 par.208'),
    ('FS-RESET-LOCK',
        'Tombol RESET ditekan petani',
        'Semua status LOCK dibersihkan, siklus mulai awal; counter harian TIDAK direset',
        NULL, NULL, 'Perancangan FINAL Aturan 12 par.164'),
    ('FS-RESET-HARIAN',
        'Pukul 00:00 (RTC)',
        'Counter dosis & volume harian semua penampung direset; LOCK TIDAK ikut direset',
        NULL, NULL, 'Perancangan FINAL Aturan 11 par.159-160'),
    ('FS-WIFI-MATI',
        'WiFi putus',
        'Alert ditahan di antrian (maks 20) + LCD "WIFI OFF"; kontrol lokal tetap jalan; kirim ulang saat online',
        20, 'pesan', 'Perancangan FINAL Aturan 14 par.176-178'),
    ('FS-MODE-PEMELIHARAAN',
        'Mode pemeliharaan aktif (dari aplikasi)',
        'Sampling & dosing dijeda, bacaan tidak dicatat, jatah dibekukan; isi air tetap jalan',
        NULL, NULL, 'Perancangan FINAL Aturan 13 par.169-170'),
    ('FS-DEAD-HEAD',
        'Pompa ON saat jalur tertutup (atau jalur ditutup saat pompa ON)',
        'DILARANG — matikan pompa dulu baru tutup jalan (Aturan 1)',
        NULL, NULL, 'Perancangan FINAL Aturan 1 par.112')
ON CONFLICT (kode) DO NOTHING;

COMMIT;

-- Verifikasi (jalankan paska-migrasi):
--   SELECT param, nilai, satuan FROM konfigurasi_dosis ORDER BY param;
--   SELECT param, nilai, satuan FROM timing_operasi ORDER BY param;
--   SELECT kode, ambang, satuan FROM aturan_fail_safe ORDER BY kode;
--   -- ulangi file yang sama → jumlah baris TIDAK berubah (idempoten):
--   SELECT (SELECT count(*) FROM konfigurasi_dosis) AS dosis,
--          (SELECT count(*) FROM timing_operasi)    AS timing,
--          (SELECT count(*) FROM aturan_fail_safe)  AS failsafe;
