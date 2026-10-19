-- ============================================================================
-- DRAFT SKEMA DATABASE V2 — GARAP / Vertonik Smartfarm (PostgreSQL 17)
-- Status: DRAFT / PROPOSAL — JANGAN dijalankan ke database live, JANGAN commit
--         tanpa verdict review. File ini DI LUAR database/migrations/ secara
--         sengaja (migrasi yang sedang diverifikasi pihak lain tidak disentuh).
--
-- Berkas : database/proposal_skema_v2.sql
-- Dokumen: docs/RANCANGAN_DB_V2.md (ERD mermaid, alasan desain, jalur migrasi,
--          dampak kontrak API, keputusan yang butuh user)
-- Prasyarat (hasil migrasi perancangan yang SEDANG diverifikasi — asumsikan
--            sudah ada sebelum file ini dieksekusi):
--            - penampung_states, konfigurasi_dosis, timing_operasi,
--              aturan_fail_safe, jadwal_perawatan, kalibrasi_sensor,
--              mapping_channel_esp32, target_nutrisi
--            - kolom: monitorings.id_meja / monitorings.ec_ms_cm,
--              alert_logs.id_meja/severity/locked/acknowledged,
--              sensor_thresholds.satuan/deadband/sanity_min/sanity_max,
--              mejas.jenis_talang/kapasitas_penampung_l/...
--
-- Konvensi:
--   * Semua tabel memakai `timestamp without time zone` — konsisten dengan 13
--     tabel live (created_at lama dibaca aplikasi sebagai UTC; batas partisi
--     dihitung pada waktu server aplikasi = WITA).
--   * Semua DDL memakai IF NOT EXISTS / CREATE OR REPLACE → idempoten.
--   * Forward-only: tidak ada DROP tabel/kolom lama (monitorings dkk tetap ada;
--     perpindahan tulis diatur di dokumen, bab Jalur Migrasi).
--   * Kolom `sumber`/komentar COMMENT ON mencantumkan sumber dokumen perancangan
--     (Perancangan FINAL = Perancangan_Sistem_IoT_Hidroponik_FINAL.docx) atau
--     AUDIT_PERFORMA_GARAP.md.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 0. HELPER PARTISI (opsional tapi disarankan)
--    Partisi bulanan untuk sensor_readings — lihat dokumen butir 1, opsi A.
-- ============================================================================
CREATE OR REPLACE FUNCTION fn_partisi_readings_bulanan(target date)
RETURNS text
LANGUAGE plpgsql
AS $$
-- Membuat partisi bulanan sensor_readings_<yyyy_mm> bila belum ada.
-- target = tanggal mana pun dalam bulan yang diinginkan.
-- Bila ada DEFAULT partition, ia di-DETACH dulu, baris yang jatuh di rentang
-- target dipindahkan ke partisi baru, lalu DEFAULT di-ATTACH kembali
-- (ATTACH VALIDATION lolos karena rentang sudah bersih). Aman diulang.
DECLARE
    nama text := 'sensor_readings_' || to_char(target, 'YYYY_MM');
    awal date := date_trunc('month', target)::date;
    akhir date := (date_trunc('month', target) + interval '1 month')::date;
    ada_default boolean;
BEGIN
    IF to_regclass('public.' || nama) IS NOT NULL THEN
        RETURN nama;                       -- sudah ada, tidak berbuat apa-apa
    END IF;

    ada_default := to_regclass('public.sensor_readings_default') IS NOT NULL;
    IF ada_default THEN
        EXECUTE 'ALTER TABLE public.sensor_readings DETACH PARTITION public.sensor_readings_default';
    END IF;

    EXECUTE format(
        'CREATE TABLE public.%I PARTITION OF public.sensor_readings
         FOR VALUES FROM (%L) TO (%L)', nama, awal, akhir);

    IF ada_default THEN
        -- angkut baris telat (bila ada) dari partisi default ke partisi baru
        EXECUTE 'INSERT INTO public.sensor_readings
                   (id, id_meja, device_id, created_at, ph, ec_ms_cm,
                    suhu_air_c, suhu_ruangan_c, kelembapan_pct, water_level,
                    valid, alasan_invalid, sumber)
                 SELECT id, id_meja, device_id, created_at, ph, ec_ms_cm,
                        suhu_air_c, suhu_ruangan_c, kelembapan_pct, water_level,
                        valid, alasan_invalid, sumber
                   FROM public.sensor_readings_default
                  WHERE created_at >= $1 AND created_at < $2'
            USING awal, akhir;
        EXECUTE 'DELETE FROM public.sensor_readings_default
                  WHERE created_at >= $1 AND created_at < $2' USING awal, akhir;
        EXECUTE 'ALTER TABLE public.sensor_readings
                 ATTACH PARTITION public.sensor_readings_default DEFAULT';
    END IF;

    RETURN nama;
END;
$$;
COMMENT ON FUNCTION fn_partisi_readings_bulanan(date) IS
    'Buat partisi bulanan sensor_readings (retensi = DROP partisi; AUDIT_PERFORMA_GARAP.md saran indeks (id_meja, created_at DESC))';

CREATE OR REPLACE FUNCTION fn_pensiun_readings(lama_hari integer)
RETURNS integer
LANGUAGE plpgsql
AS $$
-- Retensi: DETACH + DROP partisi yang berakhir lebih dari lama_hari lalu.
-- DETACH dulu (cepat, tidak memindahkan baris) lalu DROP (instan, tanpa
-- VACUUM/bloat seperti DELETE besar-besahan — lihat dokumen butir 1, opsi A).
-- Mengembalikan jumlah partisi yang dipensiunkan.
DECLARE
    r record;
    n integer := 0;
BEGIN
    FOR r IN
        SELECT c.relname
        FROM pg_inherits i
        JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'public.sensor_readings'::regclass
          AND c.relname <> 'sensor_readings_default'
          AND c.relname ~ 'sensor_readings_[0-9]{4}_[0-9]{2}$'
          AND (to_date(substring(c.relname from '([0-9]{4}_[0-9]{2})$'), 'YYYY_MM')
               + interval '1 month')::date <= now()::date - lama_hari
    LOOP
        EXECUTE format('DETACH PARTITION public.%I', r.relname);
        EXECUTE format('DROP TABLE public.%I', r.relname);
        n := n + 1;
    END LOOP;
    RETURN n;
END;
$$;
COMMENT ON FUNCTION fn_pensiun_readings(integer) IS
    'Retensi bacaan sensor: buang partisi mentah lebih tua dari N hari (rollup hourly TIDAK ikut terbuang)';

-- ============================================================================
-- 1. BUTIR 1 — sensor_readings: bacaan sensor PER MEJA (5 metrik)
--    Volume: ESP32 menulis tiap ±5 dtk (AUDIT: 17.280/hari) → partisi bulanan,
--    PK (id_meja, created_at, id) SARGABLE + mencakup kunci partisi.
-- ============================================================================
CREATE TABLE IF NOT EXISTS sensor_readings (
    id              bigint GENERATED BY DEFAULT AS IDENTITY,
    id_meja         bigint NOT NULL,
    device_id       varchar(32) DEFAULT 'esp32-a' NOT NULL,
    created_at      timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    ph              numeric(4,2),
    ec_ms_cm        numeric(5,3),
    suhu_air_c      numeric(4,2),
    suhu_ruangan_c  numeric(4,2),
    kelembapan_pct  numeric(5,2),
    water_level     varchar(20),
    valid           boolean DEFAULT true NOT NULL,
    alasan_invalid  varchar(60),
    sumber          varchar(16) DEFAULT 'ESP32' NOT NULL,
    CONSTRAINT sensor_readings_pkey PRIMARY KEY (id_meja, created_at, id),
    CONSTRAINT sensor_readings_id_meja_foreign
        FOREIGN KEY (id_meja) REFERENCES public.mejas (id_meja) ON DELETE CASCADE,
    CONSTRAINT sensor_readings_ph_check
        CHECK (ph IS NULL OR (ph >= 0 AND ph <= 14)),
    CONSTRAINT sensor_readings_ec_check
        CHECK (ec_ms_cm IS NULL OR (ec_ms_cm >= 0 AND ec_ms_cm <= 10)),
    CONSTRAINT sensor_readings_suhu_air_check
        CHECK (suhu_air_c IS NULL OR (suhu_air_c >= -10 AND suhu_air_c <= 80)),
    CONSTRAINT sensor_readings_suhu_ruangan_check
        CHECK (suhu_ruangan_c IS NULL OR (suhu_ruangan_c >= -20 AND suhu_ruangan_c <= 60)),
    CONSTRAINT sensor_readings_kelembapan_check
        CHECK (kelembapan_pct IS NULL OR (kelembapan_pct >= 0 AND kelembapan_pct <= 100)),
    CONSTRAINT sensor_readings_sumber_check
        CHECK (sumber IN ('ESP32', 'SIMULASI', 'IMPORT', 'MANUAL')),
    CONSTRAINT sensor_readings_valid_check
        CHECK (valid OR alasan_invalid IS NOT NULL)
) PARTITION BY RANGE (created_at);

COMMENT ON TABLE sensor_readings IS
    'Bacaan sensor PER MEJA (ph, EC mS/cm, suhu air, suhu ruangan, kelembapan) — Perancangan FINAL seksi 1.4/2.2; menggantikan monitorings (global 1 baris). Partisi bulanan + retensi DROP partisi (AUDIT_PERFORMA_GARAP.md: 17.280 baris/hari, proyeksi 84,6 MiB/30 hari).';
COMMENT ON COLUMN sensor_readings.device_id IS
    'Perangkat penulis — kompatibel usulan 2 ESP32 (docs/KONTRAK_API.md seksi 6)';
COMMENT ON COLUMN sensor_readings.ec_ms_cm IS
    'EC sensor langsung mS/cm — Perancangan FINAL seksi 2.2 par.48 (ppm = EC x 500)';
COMMENT ON COLUMN sensor_readings.valid IS
    'FALSE = bacaan LOLOS input tetapi gagal sanity check (Perancangan FINAL seksi 4.1 par.60 / seksi 9 par.209) → tetap disimpan untuk audit, TIDAK dipakai perhitungan';
COMMENT ON COLUMN sensor_readings.alasan_invalid IS
    'Penyebab invalid: sanity_ec | sanity_ph | sanity_suhu | lonjakan_ec | timeout_baca (aturan di aturan_fail_safe)';
COMMENT ON COLUMN sensor_readings.sumber IS
    'ESP32 (normal) | SIMULASI | IMPORT (backfill monitorings lama) | MANUAL (uji)';

-- Partisi awal: bulan berjalan + bulan berikutnya
SELECT fn_partisi_readings_bulanan(date_trunc('month', now())::date);
SELECT fn_partisi_readings_bulanan((date_trunc('month', now()) + interval '1 month')::date);

DO $$
BEGIN
    -- DEFAULT partition: penampung tulis di luar rentang (delay/keliru jam)
    IF to_regclass('public.sensor_readings_default') IS NULL THEN
        EXECUTE 'CREATE TABLE public.sensor_readings_default
                 PARTITION OF public.sensor_readings DEFAULT';
    END IF;
    -- jaga-jaga: partisi 3 bulan lalu (tujuan backfill monitorings) s/d 7 bulan
    -- ke depan (bulanan, otomatis lewat fn_partisi_readings_bulanan)
    FOR i IN -3..7 LOOP
        PERFORM fn_partisi_readings_bulanan(
            (date_trunc('month', now()) + (i || ' month')::interval)::date);
    END LOOP;
END $$;

-- Indeks: PK sudah jadi indeks (id_meja, created_at, id) per partisi — sargable
-- untuk WHERE id_meja = ? AND created_at >= ? AND < ? (audit: saran indeks
-- (id_meja, created_at DESC)). Tidak ada index created_at ganda seperti pada
-- monitorings (audit: 2 indeks created_at redundan, 5,1 MB + write amplifikasi).

-- ============================================================================
-- 2. BUTIR 1 (lanjutan) — rollup hourly + snapshot latest
--    Rollup = bahan chart/laporan jangka panjang; latest = /api/latest-sensor
--    tanpa harus menyenggol partisi (audit: query latest harus index-only).
-- ============================================================================
CREATE TABLE IF NOT EXISTS sensor_readings_hourly (
    id_meja          bigint NOT NULL,
    bucket_start     timestamp(0) without time zone NOT NULL,
    n_bacaan         integer DEFAULT 0 NOT NULL,
    n_valid          integer DEFAULT 0 NOT NULL,
    n_override       integer DEFAULT 0 NOT NULL,
    ph_avg           numeric(4,2), ph_min numeric(4,2), ph_max numeric(4,2),
    ec_avg           numeric(5,3), ec_min numeric(5,3), ec_max numeric(5,3),
    suhu_air_avg     numeric(4,2), suhu_air_min numeric(4,2), suhu_air_max numeric(4,2),
    suhu_ruangan_avg numeric(4,2),
    kelembapan_avg   numeric(5,2),
    dihitung_pada    timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT sensor_readings_hourly_pkey PRIMARY KEY (id_meja, bucket_start),
    CONSTRAINT sensor_readings_hourly_id_meja_foreign
        FOREIGN KEY (id_meja) REFERENCES public.mejas (id_meja) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_readings_hourly_bucket
    ON sensor_readings_hourly (bucket_start DESC);

COMMENT ON TABLE sensor_readings_hourly IS
    'Rollup per jam per meja (rata-rata/min/max/n) — bahan chart & laporan > 24 jam; 120 baris/hari (5 meja) vs 17.280 baris mentah; retensi 2 tahun (±8 MB) — Perancangan FINAL seksi 8 (laporan) + AUDIT_PERFORMA_GARAP.md (query range sargable)';
COMMENT ON COLUMN sensor_readings_hourly.n_override IS
    'Jumlah bacaan dalam jam itu yang mengambil nilai sensor_overrides (bukan nilai sensor)';

CREATE TABLE IF NOT EXISTS sensor_readings_latest (
    id_meja           bigint NOT NULL,
    ph                numeric(4,2),
    ec_ms_cm          numeric(5,3),
    suhu_air_c        numeric(4,2),
    suhu_ruangan_c    numeric(4,2),
    kelembapan_pct    numeric(5,2),
    water_level       varchar(20),
    id_reading        bigint,
    sumber_created_at timestamp(0) without time zone,
    id_override_aktif bigint,
    diupdate_pada     timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT sensor_readings_latest_pkey PRIMARY KEY (id_meja),
    CONSTRAINT sensor_readings_latest_id_meja_foreign
        FOREIGN KEY (id_meja) REFERENCES public.mejas (id_meja) ON DELETE CASCADE
);
COMMENT ON TABLE sensor_readings_latest IS
    'Snapshot bacaan terakhir tiap meja (1 baris/meja) — diupsert pada tiap tulis sensor_readings; sumber /api/latest-sensor & /dashboard tanpa scan partisi (audit: cache latest 2 dtk, is_online ≤ 120 dtk)';

-- Rollup idempoten per rentang (dipanggil job tiap jam / setelah backfill).
CREATE OR REPLACE FUNCTION fn_rollup_readings(jam_awal timestamp, jam_akhir timestamp)
RETURNS integer
LANGUAGE plpgsql
AS $$
-- Hitung ulang rollup hourly untuk rentang [jam_awal, jam_akhir) — idempoten
-- (ON CONFLICT DO UPDATE), aman dipanggil berulang. Mengembalikan baris rollup.
DECLARE
    n integer;
BEGIN
    INSERT INTO sensor_readings_hourly (
        id_meja, bucket_start, n_bacaan, n_valid, n_override,
        ph_avg, ph_min, ph_max,
        ec_avg, ec_min, ec_max,
        suhu_air_avg, suhu_air_min, suhu_air_max,
        suhu_ruangan_avg, kelembapan_avg, dihitung_pada)
    SELECT r.id_meja,
           date_trunc('hour', r.created_at),
           count(*),
           count(*) FILTER (WHERE r.valid),
           count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM sensor_overrides o
               WHERE o.id_meja = r.id_meja
                 AND o.status <> 'dibatalkan'
                 AND o.mulai_pada <= r.created_at
                 AND r.created_at < LEAST(COALESCE(o.berakhir_pada, 'infinity'::timestamp),
                                          COALESCE(o.dihentikan_pada, 'infinity'::timestamp)))),
           round(avg(r.ph)::numeric, 2), min(r.ph), max(r.ph),
           round(avg(r.ec_ms_cm)::numeric, 3), min(r.ec_ms_cm), max(r.ec_ms_cm),
           round(avg(r.suhu_air_c)::numeric, 2), min(r.suhu_air_c), max(r.suhu_air_c),
           round(avg(r.suhu_ruangan_c)::numeric, 2),
           round(avg(r.kelembapan_pct)::numeric, 2),
           CURRENT_TIMESTAMP
    FROM sensor_readings r
    WHERE r.created_at >= jam_awal AND r.created_at < jam_akhir
    GROUP BY r.id_meja, date_trunc('hour', r.created_at)
    ON CONFLICT (id_meja, bucket_start) DO UPDATE
        SET n_bacaan = EXCLUDED.n_bacaan,
            n_valid = EXCLUDED.n_valid,
            n_override = EXCLUDED.n_override,
            ph_avg = EXCLUDED.ph_avg, ph_min = EXCLUDED.ph_min, ph_max = EXCLUDED.ph_max,
            ec_avg = EXCLUDED.ec_avg, ec_min = EXCLUDED.ec_min, ec_max = EXCLUDED.ec_max,
            suhu_air_avg = EXCLUDED.suhu_air_avg, suhu_air_min = EXCLUDED.suhu_air_min, suhu_air_max = EXCLUDED.suhu_air_max,
            suhu_ruangan_avg = EXCLUDED.suhu_ruangan_avg,
            kelembapan_avg = EXCLUDED.kelembapan_avg,
            dihitung_pada = EXCLUDED.dihitung_pada;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END;
$$;
COMMENT ON FUNCTION fn_rollup_readings(timestamp, timestamp) IS
    'Rollup idempoten per jam per meja — dipanggil job terjadwal (tiap jam + saat backfill)';

-- ============================================================================
-- 3. BUTIR 2 — sensor_overrides: ambil-nilai-manual yang MENIMPA bacaan sensor
--    Kunci: 1 baris AKTIF per (id_meja, field) — partial unique index.
-- ============================================================================
CREATE TABLE IF NOT EXISTS sensor_overrides (
    id                bigint GENERATED BY DEFAULT AS IDENTITY,
    id_meja           bigint NOT NULL,
    field             varchar(24) NOT NULL,
    nilai             numeric(8,3) NOT NULL,
    satuan            varchar(12),
    alasan            text NOT NULL,
    status            varchar(12) DEFAULT 'aktif' NOT NULL,
    mulai_pada        timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    berakhir_pada     timestamp(0) without time zone,
    durasi_rencana_menit integer,
    dibuat_oleh       bigint NOT NULL,
    dipicu_dari       varchar(16) DEFAULT 'web' NOT NULL,
    dihentikan_pada   timestamp(0) without time zone,
    dihentikan_oleh   bigint,
    alasan_penutup    text,
    created_at        timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at        timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT sensor_overrides_pkey PRIMARY KEY (id),
    CONSTRAINT sensor_overrides_id_meja_foreign
        FOREIGN KEY (id_meja) REFERENCES public.mejas (id_meja) ON DELETE CASCADE,
    CONSTRAINT sensor_overrides_dibuat_oleh_foreign
        FOREIGN KEY (dibuat_oleh) REFERENCES public.users (id) ON DELETE RESTRICT,
    CONSTRAINT sensor_overrides_dihentikan_oleh_foreign
        FOREIGN KEY (dihentikan_oleh) REFERENCES public.users (id) ON DELETE RESTRICT,
    CONSTRAINT sensor_overrides_field_check
        CHECK (field IN ('ph', 'ec_ms_cm', 'suhu_air_c', 'suhu_ruangan_c', 'kelembapan_pct')),
    CONSTRAINT sensor_overrides_status_check
        CHECK (status IN ('aktif', 'selesai', 'dibatalkan')),
    CONSTRAINT sensor_overrides_alasan_check
        CHECK (length(btrim(alasan)) >= 5),
    CONSTRAINT sensor_overrides_waktu_check
        CHECK (berakhir_pada IS NULL OR berakhir_pada > mulai_pada),
    CONSTRAINT sensor_overrides_tutup_check
        CHECK (status = 'aktif' OR dihentikan_pada IS NOT NULL)
);

-- Kunci anti-dobel: hanya BOLEH SATU override aktif per meja per field
-- (histori selesai/dibatalkan tetap tersimpan, jadi unique penuh tidak dipakai).
CREATE UNIQUE INDEX IF NOT EXISTS uq_sensor_overrides_aktif
    ON sensor_overrides (id_meja, field) WHERE status = 'aktif';

CREATE INDEX IF NOT EXISTS idx_sensor_overrides_aktif
    ON sensor_overrides (id_meja, status) WHERE status = 'aktif';
CREATE INDEX IF NOT EXISTS idx_sensor_overrides_created
    ON sensor_overrides (created_at DESC);

COMMENT ON TABLE sensor_overrides IS
    'OVERRIDE bacaan sensor per meja (siapa/kapan/kena berapa lama/field apa) — mengalahkan nilai sensor pada pembacaan efektif; 1 aktif per (id_meja, field)';
COMMENT ON COLUMN sensor_overrides.field IS
    'Field yang ditimpa — harus satu dari kolom metrik sensor_readings';
COMMENT ON COLUMN sensor_overrides.nilai IS
    'Nilai manual; divalidasi aplikasi terhadap sensor_thresholds.sanity_min/max sebelum INSERT (rangkaian: sanity -> override -> deadband/ambang)';
COMMENT ON COLUMN sensor_overrides.berakhir_pada IS
    'NULL = aktif sampai dihentikan manual; selain itu = auto-selesai (durasi aktif)';
COMMENT ON COLUMN sensor_overrides.dibuat_oleh IS
    'WAJIB — user yang membuat override (role diizinkan = keputusan user; saran: admin saja)';

-- Pembacaan efektif: nilai override bila ada yang aktif, kalau tidak nilai sensor.
-- Satu baris per (meja, waktu, field) — dipakai API baca, bukan penyimpanan.
CREATE OR REPLACE VIEW v_bacaan_efektif AS
SELECT r.id_meja,
       r.created_at,
       r.device_id,
       f.field,
       f.nilai_sensor,
       CASE WHEN o.id IS NOT NULL THEN o.nilai ELSE f.nilai_sensor END AS nilai_efektif,
       o.id   AS id_override,
       o.alasan AS override_alasan,
       r.valid
FROM sensor_readings r
CROSS JOIN LATERAL (VALUES
        ('ph',              r.ph),
        ('ec_ms_cm',        r.ec_ms_cm),
        ('suhu_air_c',      r.suhu_air_c),
        ('suhu_ruangan_c',  r.suhu_ruangan_c),
        ('kelembapan_pct',  r.kelembapan_pct)
     ) AS f(field, nilai_sensor)
LEFT JOIN sensor_overrides o
       ON o.id_meja = r.id_meja
      AND o.field = f.field
      AND o.status <> 'dibatalkan'
      AND o.mulai_pada <= r.created_at
      AND r.created_at < LEAST(COALESCE(o.berakhir_pada, 'infinity'::timestamp),
                               COALESCE(o.dihentikan_pada, 'infinity'::timestamp));
COMMENT ON VIEW v_bacaan_efektif IS
    'Bacaan live dgn prioritas: override aktif > sensor (Prioritas 1: sensor_overrides; fallback: sensor_readings). Urutan pemrosesan: sanity (valid) -> override -> deadband/ambang sensor_thresholds';

-- ============================================================================
-- 4. BUTIR 3 — dosing: log pemberian nutrisi (kejadian + suntikan/ronde)
--    Konfigurasi pagar (8 kejadian/hari, 500 mL, 5 suntikan) TETAP di
--    konfigurasi_dosis; counter harian TURUNAN dari tabel ini (lihat dokumen).
-- ============================================================================
CREATE TABLE IF NOT EXISTS dosing_events (
    id              bigint GENERATED BY DEFAULT AS IDENTITY,
    id_meja         bigint NOT NULL,
    hari            date NOT NULL,
    mulai_pada      timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    selesai_pada    timestamp(0) without time zone,
    durasi_detik    integer,
    pemicu          varchar(24) NOT NULL,
    aktor_tipe      varchar(16) DEFAULT 'esp32' NOT NULL,
    dipicu_oleh     bigint,
    alasan          text,
    ronde_total     smallint DEFAULT 0 NOT NULL,
    volume_total_ml numeric(8,2) DEFAULT 0 NOT NULL,
    ec_sebelum      numeric(5,3),
    ec_sesudah      numeric(5,3),
    target_ec       numeric(5,3),
    hasil           varchar(16) DEFAULT 'berjalan' NOT NULL,
    lock_terpicu    boolean DEFAULT false NOT NULL,
    id_alert        bigint,
    created_at      timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at      timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT dosing_events_pkey PRIMARY KEY (id),
    CONSTRAINT dosing_events_id_meja_foreign
        FOREIGN KEY (id_meja) REFERENCES public.mejas (id_meja) ON DELETE RESTRICT,
    CONSTRAINT dosing_events_dipicu_oleh_foreign
        FOREIGN KEY (dipicu_oleh) REFERENCES public.users (id) ON DELETE SET NULL,
    CONSTRAINT dosing_events_id_alert_foreign
        FOREIGN KEY (id_alert) REFERENCES public.alert_logs (id) ON DELETE SET NULL,
    CONSTRAINT dosing_events_hari_check
        CHECK (hari >= DATE '2026-01-01'),
    CONSTRAINT dosing_events_waktu_check
        CHECK (selesai_pada IS NULL OR selesai_pada >= mulai_pada),
    CONSTRAINT dosing_events_pemicu_check
        CHECK (pemicu IN ('ESP32_OTOMATIS', 'USER_MANUAL', 'SISTEM', 'API')),
    CONSTRAINT dosing_events_aktor_check
        CHECK (aktor_tipe IN ('user', 'esp32', 'system')),
    CONSTRAINT dosing_events_hasil_check
        CHECK (hasil IN ('berjalan', 'sukses', 'gagal', 'lock', 'timeout', 'dibatalkan')),
    CONSTRAINT dosing_events_ronde_check
        CHECK (ronde_total BETWEEN 0 AND 5),
    CONSTRAINT dosing_events_volume_check
        CHECK (volume_total_ml >= 0),
    CONSTRAINT dosing_events_manual_check
        CHECK (pemicu <> 'USER_MANUAL' OR dipicu_oleh IS NOT NULL),
    CONSTRAINT dosing_events_aktor_check2
        CHECK ((pemicu = 'USER_MANUAL' AND aktor_tipe = 'user')
            OR (pemicu <> 'USER_MANUAL'))
);

CREATE INDEX IF NOT EXISTS idx_dosing_events_meja_hari
    ON dosing_events (id_meja, hari DESC);
CREATE INDEX IF NOT EXISTS idx_dosing_events_mulai
    ON dosing_events (mulai_pada DESC);
CREATE INDEX IF NOT EXISTS idx_dosing_events_pemicu
    ON dosing_events (pemicu, mulai_pada DESC);

COMMENT ON TABLE dosing_events IS
    'Log pemberian nutrisi: 1 baris = 1 KEJADIAN (sesi maks 5 suntikan + baca ulang) — Perancangan FINAL seksi 1.6/2.3, Aturan 6/7/9/11; pemicu ESP32 otomatis atau user manual';
COMMENT ON COLUMN dosing_events.hari IS
    'Tanggal harian menurut reset 00:00 (RTC/WITA) — Aturan 11; kunci counter 8 kejadian/hari & 500 mL (Tabel 13)';
COMMENT ON COLUMN dosing_events.pemicu IS
    'ESP32_OTOMATIS (Aturan 6) | USER_MANUAL (dari aplikasi) | SISTEM | API';
COMMENT ON COLUMN dosing_events.hasil IS
    'sukses = target tercapai (-> MONITORING 60 mnt) | gagal = retry habis | lock = ALERT+LOCK (Aturan 9) | timeout | dibatalkan (isi air mendahului — Aturan 3)';
COMMENT ON COLUMN dosing_events.volume_total_ml IS
    'Turunan SUM(dosing_rounds.volume_ml) dihitung saat kejadian ditutup — dipakai counter harian tanpa JOIN (konsistensi via v_dosing_harian)';

CREATE TABLE IF NOT EXISTS dosing_rounds (
    id                bigint GENERATED BY DEFAULT AS IDENTITY,
    id_kejadian       bigint NOT NULL,
    ronde_ke          smallint NOT NULL,
    jenis             varchar(12) NOT NULL,
    target_delta_ec   numeric(5,3),
    volume_ml         numeric(7,2) NOT NULL,
    durasi_pulse_detik numeric(6,2),
    volume_bilas_ml   numeric(7,2),
    mulai_pada        timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    selesai_pada      timestamp(0) without time zone,
    ec_setelah        numeric(5,3),
    retry_ke          smallint,
    hasil             varchar(12) DEFAULT 'ok' NOT NULL,
    catatan           text,
    CONSTRAINT dosing_rounds_pkey PRIMARY KEY (id),
    CONSTRAINT dosing_rounds_id_kejadian_foreign
        FOREIGN KEY (id_kejadian) REFERENCES public.dosing_events (id) ON DELETE CASCADE,
    CONSTRAINT dosing_rounds_unik UNIQUE (id_kejadian, ronde_ke),
    CONSTRAINT dosing_rounds_ronde_check CHECK (ronde_ke BETWEEN 1 AND 5),
    CONSTRAINT dosing_rounds_jenis_check
        CHECK (jenis IN ('A', 'B', 'PH_UP', 'PH_DOWN')),
    CONSTRAINT dosing_rounds_volume_check
        CHECK (volume_ml >= 0 AND volume_ml <= 500),
    CONSTRAINT dosing_rounds_hasil_check
        CHECK (hasil IN ('ok', 'gagal', 'timeout', 'dibatalkan')),
    CONSTRAINT dosing_rounds_retry_check
        CHECK (retry_ke IS NULL OR (retry_ke >= 1 AND retry_ke <= 5))
);

CREATE INDEX IF NOT EXISTS idx_dosing_rounds_kejadian
    ON dosing_rounds (id_kejadian);

COMMENT ON TABLE dosing_rounds IS
    'Detail suntikan/ronde dalam satu kejadian dosing (maks 5, Perancangan FINAL Aturan 6/7) — A/B/PH_UP/PH_DOWN, bilas, pulse, hasil';
COMMENT ON COLUMN dosing_rounds.volume_ml IS
    'Volume suntikan (Tabel 4 takaran pulse; pagar 500 mL/hari = konfigurasi_dosis.maks_volume_ab_hari_ml)';
COMMENT ON COLUMN dosing_rounds.retry_ke IS
    'Retry maks: EC 5x, pH 3x (Tabel 13 / konfigurasi_dosis.maks_retry_*)';

-- Turunan counter harian (sumber kebenaran = event log).
CREATE OR REPLACE VIEW v_dosing_harian AS
SELECT e.id_meja,
       e.hari,
       count(*)::int                    AS kejadian,
       coalesce(sum(e.ronde_total), 0)::int AS suntikan,
       coalesce(sum(e.volume_total_ml), 0)  AS volume_ml,
       count(*) FILTER (WHERE e.hasil = 'lock')::int AS kejadian_lock,
       max(kd.nilai)::int               AS maks_kejadian,
       max(kv.nilai)::numeric           AS maks_volume_ml
FROM dosing_events e
LEFT JOIN konfigurasi_dosis kd ON kd.param = 'maks_kejadian_per_hari'
LEFT JOIN konfigurasi_dosis kv ON kv.param = 'maks_volume_ab_hari_ml'
GROUP BY e.id_meja, e.hari;
COMMENT ON VIEW v_dosing_harian IS
    'Counter harian per meja TURUNAN dari dosing_events + pagar dari konfigurasi_dosis (8 kejadian/hari, 500 mL/hari — Tabel 13). penampung_states.kejadian_dosis_hari/volume_ab_hari_ml = CACHE yang disinkronkan & direkonsiliasi dari view ini.';

-- ============================================================================
-- 5. BUTIR 4 — water_fill_events: log pengisian air (isi air / FORCE_FILL)
--    Timeout 15 menit = timing_operasi.isi_air_timeout_menit (Tabel 13/Aturan 3).
-- ============================================================================
CREATE TABLE IF NOT EXISTS water_fill_events (
    id                 bigint GENERATED BY DEFAULT AS IDENTITY,
    id_meja            bigint NOT NULL,
    id_sesi_kontaktor   uuid DEFAULT gen_random_uuid() NOT NULL,
    mulai_pada         timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    selesai_pada       timestamp(0) without time zone,
    durasi_detik       integer,
    pemicu             varchar(20) NOT NULL,
    dipicu_oleh        bigint,
    valve_sebelum      varchar(8) NOT NULL,
    valve_sesudah      varchar(8) NOT NULL,
    kontaktor_akhir    boolean DEFAULT false NOT NULL,
    timeout_menit      numeric(5,2) DEFAULT 15 NOT NULL,
    hasil              varchar(16) DEFAULT 'berjalan' NOT NULL,
    alert_terpicu      boolean DEFAULT false NOT NULL,
    keterangan         text,
    created_at         timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT water_fill_events_pkey PRIMARY KEY (id),
    CONSTRAINT water_fill_events_id_meja_foreign
        FOREIGN KEY (id_meja) REFERENCES public.mejas (id_meja) ON DELETE RESTRICT,
    CONSTRAINT water_fill_events_dipicu_oleh_foreign
        FOREIGN KEY (dipicu_oleh) REFERENCES public.users (id) ON DELETE SET NULL,
    CONSTRAINT water_fill_events_waktu_check
        CHECK (selesai_pada IS NULL OR selesai_pada >= mulai_pada),
    CONSTRAINT water_fill_events_pemicu_check
        CHECK (pemicu IN ('AUTO_FLOAT', 'FORCE_FILL', 'FORCE_STOP', 'MANUAL')),
    CONSTRAINT water_fill_events_valve_check
        CHECK (valve_sebelum IN ('ON', 'OFF') AND valve_sesudah IN ('ON', 'OFF')),
    CONSTRAINT water_fill_events_hasil_check
        CHECK (hasil IN ('berjalan', 'selesai', 'timeout', 'dibatalkan', 'force_stop')),
    CONSTRAINT water_fill_events_manual_check
        CHECK (pemicu NOT IN ('FORCE_FILL', 'FORCE_STOP', 'MANUAL') OR dipicu_oleh IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_water_fill_meja_mulai
    ON water_fill_events (id_meja, mulai_pada DESC);
CREATE INDEX IF NOT EXISTS idx_water_fill_mulai
    ON water_fill_events (mulai_pada DESC);

COMMENT ON TABLE water_fill_events IS
    'Log pengisian air bersih per penampung — Aturan 2/3 (prioritas isi air) + Tabel 13 timeout 15 menit; transisi solenoid & contactor dicatat';
COMMENT ON COLUMN water_fill_events.id_sesi_kontaktor IS
    'Kelompok jalur yang terisi BERSAMAAN (Aturan 3: dua float turun -> dua solenoid kebuka, contactor ON sekali)';
COMMENT ON COLUMN water_fill_events.pemicu IS
    'AUTO_FLOAT (pelampung turun) | FORCE_FILL (perintah web) | FORCE_STOP | MANUAL';
COMMENT ON COLUMN water_fill_events.hasil IS
    'timeout = lewat 15 menit float tidak naik -> contactor mati + ALERT (Aturan 3 par.122)';
COMMENT ON COLUMN water_fill_events.timeout_menit IS
    'Snapshot timeout yang berlaku saat kejadian (timing_operasi.isi_air_timeout_menit, default 15)';

-- ============================================================================
-- 6. BUTIR 5 — report_logs: riwayat laporan yang dibuat sistem/user
-- ============================================================================
CREATE TABLE IF NOT EXISTS report_logs (
    id              bigint GENERATED BY DEFAULT AS IDENTITY,
    jenis           varchar(32) NOT NULL,
    judul           varchar(160),
    periode_dari    date,
    periode_sampai  date,
    filter          jsonb DEFAULT '{}'::jsonb NOT NULL,
    format          varchar(12) DEFAULT 'json' NOT NULL,
    status          varchar(16) DEFAULT 'pending' NOT NULL,
    dibuat_oleh     bigint,
    aktor_tipe      varchar(16) DEFAULT 'user' NOT NULL,
    dimulai_pada    timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    selesai_pada    timestamp(0) without time zone,
    durasi_ms       integer,
    jumlah_baris    integer,
    file_path       text,
    file_size_bytes bigint,
    file_sha256     varchar(64),
    hasil_json      jsonb,
    error_message   text,
    ip              inet,
    created_at      timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT report_logs_pkey PRIMARY KEY (id),
    CONSTRAINT report_logs_dibuat_oleh_foreign
        FOREIGN KEY (dibuat_oleh) REFERENCES public.users (id) ON DELETE SET NULL,
    CONSTRAINT report_logs_jenis_check
        CHECK (jenis IN ('dashboard', 'enam_jam', 'chart', 'harian',
                         'mingguan', 'bulanan', 'csv_export', 'custom')),
    CONSTRAINT report_logs_format_check
        CHECK (format IN ('json', 'csv', 'pdf', 'xlsx')),
    CONSTRAINT report_logs_status_check
        CHECK (status IN ('pending', 'berjalan', 'selesai', 'gagal')),
    CONSTRAINT report_logs_aktor_check
        CHECK (aktor_tipe IN ('user', 'system', 'scheduler')),
    CONSTRAINT report_logs_periode_check
        CHECK (periode_dari IS NULL OR periode_sampai IS NULL OR periode_sampai >= periode_dari),
    CONSTRAINT report_logs_selesai_check
        CHECK (status <> 'selesai' OR selesai_pada IS NOT NULL),
    CONSTRAINT report_logs_gagal_check
        CHECK (status <> 'gagal' OR error_message IS NOT NULL),
    CONSTRAINT report_logs_user_check
        CHECK (aktor_tipe = 'user' OR dibuat_oleh IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_report_logs_created
    ON report_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_report_logs_aktor
    ON report_logs (dibuat_oleh, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_report_logs_jenis
    ON report_logs (jenis, created_at DESC);

COMMENT ON TABLE report_logs IS
    'Riwayat laporan: jenis, periode, filter, pembuat, waktu generate, status, referensi file/JSON — cukup untuk menjawab "siapa kapan membuat laporan apa" (audit performa: /laporan & getReport6Jam tanpa cache)';
COMMENT ON COLUMN report_logs.filter IS
    'Filter mentah request (mis. {"id_meja":3,"dari":"2026-10-01"}) — bukti reproduksi laporan';
COMMENT ON COLUMN report_logs.file_path IS
    'Path/URL file hasil ekspor (opsional — keputusan user: simpan file fisik atau hanya JSON)';

-- ============================================================================
-- 7. BUTIR 6 — audit_logs: jejak audit generik
--    Pemicu: middleware aplikasi TULIS ASYNC (batch, setelah response) — lihat
--    dokumen butir 6. Tabel ini TIDAK boleh disentuh oleh save-sensor (volume).
-- ============================================================================
CREATE TABLE IF NOT EXISTS audit_logs (
    id             bigint GENERATED BY DEFAULT AS IDENTITY,
    terjadi_pada   timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    actor_user_id  bigint,
    actor_tipe     varchar(16) DEFAULT 'user' NOT NULL,
    actor_label    varchar(120),
    aksi           varchar(32) NOT NULL,
    tabel          varchar(64),
    row_id         varchar(64),
    before_data    jsonb,
    after_data     jsonb,
    ip             inet,
    user_agent     text,
    request_id     uuid,
    meta           jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT audit_logs_pkey PRIMARY KEY (id),
    CONSTRAINT audit_logs_actor_user_foreign
        FOREIGN KEY (actor_user_id) REFERENCES public.users (id) ON DELETE SET NULL,
    CONSTRAINT audit_logs_actor_tipe_check
        CHECK (actor_tipe IN ('user', 'system', 'esp32', 'api_key', 'anonymous')),
    CONSTRAINT audit_logs_aksi_check
        CHECK (aksi IN ('create', 'update', 'delete',
                        'login', 'logout', 'login_failed',
                        'override_start', 'override_stop',
                        'command', 'export',
                        'reset_lock', 'maintenance_on', 'maintenance_off',
                        'config_change', 'report_generate')),
    CONSTRAINT audit_logs_target_check
        CHECK (aksi NOT IN ('create', 'update', 'delete')
               OR (tabel IS NOT NULL AND row_id IS NOT NULL)),
    CONSTRAINT audit_logs_user_check
        CHECK (actor_tipe <> 'user' OR actor_user_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_waktu
    ON audit_logs (terjadi_pada DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_target
    ON audit_logs (tabel, row_id, terjadi_pada DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor
    ON audit_logs (actor_user_id, terjadi_pada DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_aksi
    ON audit_logs (aksi, terjadi_pada DESC);

COMMENT ON TABLE audit_logs IS
    'Audit trail generik: siapa (user/system/ESP32) melakukan apa, di tabel/row mana, before/after JSONB, IP + user agent — retensi default 365 hari (keputusan user)';
COMMENT ON COLUMN audit_logs.actor_user_id IS
    'NULL = sistem/ESP32/anonymous (actor_tipe menjelaskan); ON DELETE SET NULL agar jejak tetap ada walau user dihapus';
COMMENT ON COLUMN audit_logs.actor_label IS
    'Snapshot username / nama API key saat peristiwa (tahan rename/delete user)';
COMMENT ON COLUMN audit_logs.before_data IS
    'Baris SEBELUM perubahan (UPDATE/DELETE); INSERT boleh NULL. Diambil dari row yang sudah di-load / RETURNING — TANPA SELECT tambahan';
COMMENT ON COLUMN audit_logs.request_id IS
    'Korelasi satu request → banyak baris audit (middleware membuat UUID per request)';

-- Contoh pemicu DB (OPSIONAL — DIKOMENTARI; jalur utama = middleware async
-- agar tulis sensor/CRUD tidak melambat, lihat dokumen butir 6):
-- CREATE TRIGGER trg_audit_mejas AFTER INSERT OR UPDATE OR DELETE ON mejas
--     FOR EACH ROW EXECUTE FUNCTION fn_audit_baris('mejas');
-- (fungsi fn_audit_baris menulis TG_ARGV-table, NEW/OLD::jsonb ke audit_logs;
--  gunakan hanya untuk tabel kritis ber-volume rendah: mejas, users,
--  sensor_thresholds, water_controls)

-- ============================================================================
-- 8. Penanda masa berlaku (opsional, untuk query status tanpa tabel baru)
-- ============================================================================
CREATE OR REPLACE FUNCTION fn_override_aktif(p_id_meja bigint, p_field varchar)
RETURNS SETOF sensor_overrides
LANGUAGE sql STABLE
AS $$
    SELECT * FROM sensor_overrides
    WHERE id_meja = p_id_meja
      AND field = p_field
      AND status = 'aktif'
      AND mulai_pada <= CURRENT_TIMESTAMP
      AND (berakhir_pada IS NULL OR berakhir_pada > CURRENT_TIMESTAMP);
$$;

COMMIT;

-- ============================================================================
-- VERIFIKASI (jalankan paska-penerapan di DB scratch — BUKAN ke live)
--   SELECT count(*) FROM information_schema.tables
--    WHERE table_name IN ('sensor_readings','sensor_readings_hourly',
--          'sensor_readings_latest','sensor_overrides','dosing_events',
--          'dosing_rounds','water_fill_events','report_logs','audit_logs');
--   SELECT inhrelid::regclass FROM pg_inherits
--    WHERE inhparent = 'public.sensor_readings'::regclass;
--   -- uji kunci unik override (harus DITOLAK baris kedua aktif):
--   --   INSERT INTO sensor_overrides (id_meja, field, nilai, alasan, dibuat_oleh)
--   --   VALUES (1,'ph',6.5,'uji',1), (1,'ph',6.6,'uji',1);
--   -- uji FK: id_meja 99999 harus DITOLAK.
--   -- idempoten: jalankan ulang file → tidak ada error, jumlah tabel sama.
--
-- KEBIJAKAN RETENSI (dijalankan terjadwal via cron aplikasi / pg_cron bila ada):
--   sensor_readings (partisi mentah) : SELECT fn_pensiun_readings(60);   -- 60 hari
--   sensor_readings_hourly            : DELETE ... bucket_start < now()-interval '2 years';
--   audit_logs                        : DELETE ... terjadi_pada < now()-interval '365 days';
--   report_logs                       : DELETE ... created_at  < now()-interval '365 days';
--   dosing_events / dosing_rounds / water_fill_events / sensor_overrides
--                                     : TIDAK dipensiunkan (volume kecil, nilai audit);
--                                       bila wajib: arsip ke tabel _arsip dulu.
--   Partisi auto-bulan depan: SELECT fn_partisi_readings_bulanan(now()::date + 30);
-- ============================================================================
