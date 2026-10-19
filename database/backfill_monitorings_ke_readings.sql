-- ============================================================================
-- BACKFILL FASE 2 — monitorings (arsip lama) -> sensor_readings (skema V2)
--
-- STATUS  : DRAFT — BELUM DIEKSEKUSI. JANGAN dijalankan ke live
--           `vertonik_smartfarm` tanpa persetujuan user. Skrip ini MENULIS data
--           (INSERT) — uji wajib di DB scratch dulu (README_CRON.md bagian Uji).
-- SUMBER  : docs/RANCANGAN_DB_V2.md §10 butir "Fase 2 Backfill":
--             * hanya baris dengan id_meja terisi (kolom hasil migrasi
--               perancangan) — baris id_meja NULL dilewati TANPA pemetaan,
--               kecuali user mengisi p_id_meja_default;
--             * TANPA kolom `id` (identity) -> tak perlu setval sequence;
--             * suhu_air = "waterTemp", suhu_ruangan = "airTemp",
--               kelembapan = humidity, ec_ms_cm = kolom ec_ms_cm ASLI;
--               `tds` (ppm) TIDAK dijadikan EC (dilarang menebak);
--             * sumber = 'IMPORT' -> jalur "hapus WHERE sumber='IMPORT'" utk
--               membedakan data backfill dari tulisan ESP32.
-- IDEMPOTEN: penanda unik per baris sumber = device_id 'backfill:' || monitorings.id.
--            Rerun tidak pernah menggandakan baris: kandidat disaring lewat satu
--            scan terbatas rentang created_at sumber, lalu ON CONFLICT DO NOTHING
--            sebagai jaring pengaman kedua.
--            (monitorings TIDAK punya natural key: 12 baris = 7 created_at
--            berbeda, jadi created_at tak bisa dipakai penanda.)
-- PARAMETER (psql):
--    p_id_meja_default : id meja tujuan utk baris monitorings yang id_meja NULL.
--                        default = NULL  -> baris NULL dilewati (sesuai dokumen).
--                        contoh  : psql -v p_id_meja_default=3 -f <file>
-- SIFAT  : satu transaksi; bila gagal di tengah -> rollback penuh.
--            (tabel sementara pg_temp.* dibuat ON COMMIT DROP -> tak meninggalkan
--             objek apa pun, live maupun scratch.)
-- ============================================================================

\set ON_ERROR_STOP on

-- Default parameter bila tidak diberikan lewat `psql -v p_id_meja_default=...`
\if :{?p_id_meja_default}
\else
    \set p_id_meja_default NULL
\endif

BEGIN;

SET LOCAL lock_timeout = '60s';
SET LOCAL statement_timeout = '30min';

-- ---------------------------------------------------------------------------
-- 0. PRA-SYARAT + RINGKASAN SUMBER (dibaca dulu sebelum menulis apa pun)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    n integer;
BEGIN
    IF to_regclass('public.monitorings') IS NULL THEN
        RAISE EXCEPTION 'monitorings tidak ada';
    END IF;
    IF to_regclass('public.sensor_readings') IS NULL THEN
        RAISE EXCEPTION 'sensor_readings tidak ada — skema V2 belum terpasang';
    END IF;
    IF (SELECT relkind FROM pg_class WHERE oid = 'public.sensor_readings'::regclass) <> 'p' THEN
        RAISE EXCEPTION 'sensor_readings bukan tabel partisi';
    END IF;
    IF to_regclass('public.sensor_readings_hourly') IS NULL THEN
        RAISE EXCEPTION 'sensor_readings_hourly tidak ada (dibutuhkan langkah rollup)';
    END IF;
    SELECT count(*) INTO n FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace
       AND proname IN ('fn_partisi_readings_bulanan', 'fn_rollup_readings');
    IF n < 2 THEN
        RAISE EXCEPTION 'fn_partisi_readings_bulanan / fn_rollup_readings tidak ditemukan';
    END IF;
    -- pastikan kolom sumber migrasi ada (bukan tds!)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'monitorings'
                      AND column_name IN ('id_meja', 'ec_ms_cm')) THEN
        RAISE EXCEPTION 'kolom monitorings.id_meja / ec_ms_cm belum ada (migrasi perancangan?)';
    END IF;
END $$;

-- Hitungan sumber: total, siap impor, perlu pemetaan, unik created_at.
SELECT count(*)                                                        AS sumber_total,
       count(*) FILTER (WHERE id_meja IS NOT NULL)                     AS siap_impor,
       count(*) FILTER (WHERE id_meja IS NULL)                         AS perlu_pemetaan,
       count(DISTINCT created_at)                                      AS created_at_unik,
       min(created_at)                                                 AS rentang_awal,
       max(created_at)                                                 AS rentang_akhir
  FROM monitorings;

-- ---------------------------------------------------------------------------
-- 1. JAMIN PARTISI untuk rentang sumber (idempoten; mencegah tulis jatuh ke
--    DEFAULT partition bila baris lama berada di bulan yang belum dipartisi).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    d date;
BEGIN
    FOR d IN SELECT DISTINCT date_trunc('month', created_at)::date
               FROM monitorings
    LOOP
        PERFORM fn_partisi_readings_bulanan(d);
    END LOOP;
    RAISE NOTICE 'partisi untuk rentang backfill siap';
END $$;

-- ---------------------------------------------------------------------------
-- 2. KANDIDAT — baris sumber yang memenuhi syarat DAN belum tercatat.
--    Satu scan sensor_readings terbatas rentang created_at sumber (partisi
--    pruning), hasilnya disimpan sementara (ON COMMIT DROP) supaya INSERT di
--    bawah membaca daftar yang sama dan jumlahnya bisa diverifikasi.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE backfill_sisa ON COMMIT DROP AS
    SELECT m.id                                                        AS id_sumber,
           COALESCE(m.id_meja, :p_id_meja_default)                     AS id_meja_tujuan,
           m.created_at,
           m.ph,
           m.ec_ms_cm,                       -- EC asli; tds TIDAK dipakai utk EC
           m."waterTemp"                                           AS suhu_air,
           m."airTemp"                                             AS suhu_ruangan,
           m.humidity                                              AS kelembapan,
           m.water_level
      FROM monitorings m
      LEFT JOIN sensor_readings r
             ON r.sumber = 'IMPORT'
            AND r.device_id = 'backfill:' || m.id::text
            AND r.created_at >= (SELECT min(created_at) FROM monitorings)
            AND r.created_at <= (SELECT max(created_at) FROM monitorings)
     WHERE (m.id_meja IS NOT NULL OR :p_id_meja_default IS NOT NULL)
       AND r.id IS NULL;                     -- NULL = belum pernah diimpor

SELECT count(*) AS kandidat_insert FROM backfill_sisa;

-- ---------------------------------------------------------------------------
-- 3. INSERT ... SELECT (inti backfill) — tanpa kolom `id` (sequence identity
--    tak perlu setval), sumber='IMPORT', penanda device_id 'backfill:<id>'.
--    Output `INSERT 0 <n>` = jumlah baris benar-benar tertulis.
-- ---------------------------------------------------------------------------
INSERT INTO sensor_readings
    (id_meja, device_id, created_at, ph, ec_ms_cm,
     suhu_air_c, suhu_ruangan_c, kelembapan_pct, water_level,
     valid, alasan_invalid, sumber)
SELECT id_meja_tujuan,
       'backfill:' || id_sumber::text,
       created_at,
       ph, ec_ms_cm,
       suhu_air, suhu_ruangan, kelembapan, water_level,
       true, NULL, 'IMPORT'
  FROM backfill_sisa
 ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. VERIFIKASI pasca-tulis (wajib dicek sebelum COMMIT):
--    kandidat_tidak_tercatat harus 0, dan belum_tercatat (seluruh sumber yang
--    memenuhi syarat) juga harus 0.
-- ---------------------------------------------------------------------------
SELECT count(*) AS kandidat_tidak_tercatat
  FROM backfill_sisa b
 WHERE NOT EXISTS (SELECT 1 FROM sensor_readings r
                    WHERE r.sumber = 'IMPORT'
                      AND r.device_id = 'backfill:' || b.id_sumber::text);

SELECT count(*) AS belum_tercatat
  FROM monitorings m
 WHERE (m.id_meja IS NOT NULL OR :p_id_meja_default IS NOT NULL)
   AND NOT EXISTS (SELECT 1 FROM sensor_readings r
                    WHERE r.sumber = 'IMPORT'
                      AND r.device_id = 'backfill:' || m.id::text);

SELECT sumber, count(*) AS jumlah
  FROM sensor_readings
 GROUP BY sumber
 ORDER BY sumber;

-- ---------------------------------------------------------------------------
-- 5. ROLLUP rentang backfill (fase 2, sesuai dokumen: backfill lalu
--    fn_rollup_readings utk rentang tersebut). Idempoten; bila 0 baris terimpor
--    hasilnya juga 0 (rollup menimpa angka lama dengan angka yang sama).
-- ---------------------------------------------------------------------------
SELECT fn_rollup_readings(
           date_trunc('hour', (SELECT min(created_at) FROM monitorings)),
           date_trunc('hour', (SELECT max(created_at) FROM monitorings)) + interval '1 hour'
       ) AS baris_rollup_ditulis;

COMMIT;

-- ============================================================================
-- SETELAH LIVE (butuh izin user):
--   * rollback pola bila perlu:
--       DELETE FROM sensor_readings WHERE sumber = 'IMPORT' AND device_id LIKE 'backfill:%';
--     (lalu hitung ulang rollup utk rentang itu)
--   * setelah perpindahan tulis ke sensor_readings selesai (fase 3-5),
--     monitorings dibekukan sebagai arsip dan barisnya tak ditulis lagi.
-- ============================================================================
