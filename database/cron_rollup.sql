-- ============================================================================
-- SKRIP CRON ROLLUP HOURLY — V2 (sensor_readings -> sensor_readings_hourly)
--
-- STATUS  : DRAFT — BELUM DIEKSEKUSI. BUTUH PERSETUJUAN USER untuk dijalankan
--           ke database live `vertonik_smartfarm`. Uji dulu di DB scratch
--           (lihat database/README_CRON.md, bagian Uji).
-- RANCANGAN: docs/RANCANGAN_DB_V2.md §butir-1 (rollup per jam, PK
--           (id_meja, bucket_start), granularitas HOURLY = keputusan user,
--           tercatat docs/VERIFIKASI/EKSEKUSI_V2.md §5).
-- JADWAL  : tiap jam, beberapa menit setelah pergantian jam (mis. menit 5),
--           supaya bacaan jam terakhir sudah lengkap. Lihat README_CRON.md.
-- PANGGIL : psql -X -v ON_ERROR_STOP=1 -f database/cron_rollup.sql
-- SIFAT   : IDEMPOTEN — fn_rollup_readings memakai ON CONFLICT DO UPDATE atas
--           (id_meja, bucket_start), jadi job ganda / rerun / job yang telat
--           tidak pernah menggandakan baris, hanya menimpa dengan angka terbaru.
--           Satu transaksi; aman diulang tanpa batas.
-- ============================================================================

\set ON_ERROR_STOP on

BEGIN;

-- Kunci pengaman: pastikan fungsi rollup & tabelnya ada sebelum dipanggil.
DO $$
BEGIN
    IF to_regclass('public.sensor_readings') IS NULL
       OR to_regclass('public.sensor_readings_hourly') IS NULL THEN
        RAISE EXCEPTION 'sensor_readings / sensor_readings_hourly tidak ada — skema V2 belum terpasang';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc
                    WHERE pronamespace = 'public'::regnamespace
                      AND proname = 'fn_rollup_readings') THEN
        RAISE EXCEPTION 'fn_rollup_readings tidak ditemukan — jalankan proposal_skema_v2.sql dulu';
    END IF;
    RAISE NOTICE 'prasyarat rollup OK';
END $$;

SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '30min';

-- ---------------------------------------------------------------------------
-- 1. ROLLUP 2 JAM TERAKHIR (rentang [jam_akhir - 2 jam, jam_akhir)).
--    - jam_akhir = awal jam berjalan -> jam yang sedang berjalan BELUM dirangkum
--      (datanya masih masuk), sehingga hasilnya selalu deterministik.
--    - jendela 2 jam (bukan 1) menyerap bacaan yang telat masuk / clock drift
--      ESP32 pada jam sebelumnya; karena idempoten, menghitung ulang jam yang
--      sudah benar tidak merusak apa pun.
--    - NOTA PENTING: fungsi bertipe `timestamp without time zone`, sedangkan
--      now() bertipe timestamptz -> TANPA cast `::timestamp` muncul
--      "function fn_rollup_readings(timestamp with time zone, ...) does not exist"
--      (cast memakai timezone sesi = WITA, sama dengan cara aplikasi menulis
--      created_at; lihat RANCANGAN_DB_V2.md §10 catatan cast ::timestamp).
-- ---------------------------------------------------------------------------
SELECT fn_rollup_readings((date_trunc('hour', now()) - interval '2 hours')::timestamp,
                          date_trunc('hour', now())::timestamp) AS baris_rollup_ditulis;

-- ---------------------------------------------------------------------------
-- 2. REKONSILIASI RINGAN: bucket rollup yang belum pernah dihitung ulang
--    sejak > 6 jam setelah akhir jamnya (indikasi job yang terlewat).
--    Dipakai sebagai sinyal peringatan di log, bukan tindakan.
-- ---------------------------------------------------------------------------
SELECT count(*) AS bucket_menggantung
  FROM sensor_readings_hourly
 WHERE dihitung_pada > bucket_start + interval '6 hours';

-- ---------------------------------------------------------------------------
-- 3. RINGKASAN (baris ini yang tercetak di log cron).
-- ---------------------------------------------------------------------------
SELECT (SELECT count(*) FROM sensor_readings_hourly) AS baris_rollup_total,
       (SELECT max(bucket_start) FROM sensor_readings_hourly) AS rollup_terakhir,
       (SELECT count(*) FROM sensor_readings) AS baris_mentah;

COMMIT;

-- ============================================================================
-- BACKFILL / HITUNG ULANG RENTANG PANJANG (manual, bukan cron) — idempoten:
--   SELECT fn_rollup_readings('2026-10-01'::timestamp, '2026-11-01'::timestamp);
--   -- signature timestamp without time zone; rentang [awal, akhir)
--   -- dipakai setelah backfill monitorings (fase 2) dan bila rollup sempat mati.
-- ============================================================================
