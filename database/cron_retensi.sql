-- ============================================================================
-- SKRIP CRON RETENSI — V2 (partisi mentah 60 hari, rollup 2 tahun, audit/laporan 365 hari)
--
-- STATUS  : DRAFT — BELUM DIEKSEKUSI. BUTUH PERSETUJUAN USER untuk dijalankan
--           ke database live `vertonik_smartfarm`. Tanpa persetujuan, file ini
--           hanya boleh diuji di DB scratch (lihat README_CRON.md, bagian Uji).
-- KEBIJAKAN: angka retensi dari keputusan user (docs/RANCANGAN_DB_V2.md §12-§13
--           + eksekusi tercatat docs/VERIFIKASI/EKSEKUSI_V2.md §5):
--             - sensor_readings (mentah) : 60 hari  -> DROP partisi
--             - sensor_readings_hourly   : 2 tahun  -> DELETE
--             - audit_logs / report_logs : 365 hari -> DELETE
--           Mekanisme retensi mentah = DETACH + DROP partisi (bukan DELETE),
--           sehingga TIDAK menimpa beban VACUUM/bloat (RANCANGAN §3.3 opsi A).
-- JADWAL  : bulanan (mis. tgl 1, pukul 02:07 server) — bukan harian, karena
--           partisi bersifat bulanan. Lihat database/README_CRON.md.
-- PANGGIL : psql -X -v ON_ERROR_STOP=1 -f database/cron_retensi.sql
-- SIFAT   : idempoten & aman diulang. Dalam SATU transaksi (BEGIN/COMMIT);
--           bila gagal di tengah, rollback penuh (tak ada retensi setengah jadi).
-- CATATAN : `now()` memakai timezone server. Pastikan TZ database & cron host
--           sama (WITA) — lihat README_CRON.md bagian Timezone.
-- ============================================================================

\set ON_ERROR_STOP on

BEGIN;

-- Kunci pengaman: jangan menjalankan retensi bila objek V2 belum terpasang.
-- (Kalau muncul EXCEPTION ini, artinya proposal_skema_v2.sql belum dieksekusi
--  ke DB target — jalankan dulu setelah izin user.)
DO $$
DECLARE
    n integer := 0;
BEGIN
    IF to_regclass('public.sensor_readings') IS NULL THEN
        RAISE EXCEPTION 'sensor_readings tidak ada — skema V2 belum terpasang';
    END IF;
    IF (SELECT relkind FROM pg_class WHERE oid = 'public.sensor_readings'::regclass) <> 'p' THEN
        RAISE EXCEPTION 'sensor_readings bukan tabel partisi — DDL V2 tidak lengkap';
    END IF;
    SELECT count(*) INTO n FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace
       AND proname IN ('fn_pensiun_readings', 'fn_partisi_readings_bulanan');
    IF n < 2 THEN
        RAISE EXCEPTION 'fn_pensiun_readings / fn_partisi_readings_bulanan tidak ditemukan';
    END IF;
    RAISE NOTICE 'prasyarat retensi OK (partisi=%, fungsi=%)',
        (SELECT count(*) FROM pg_inherits WHERE inhparent = 'public.sensor_readings'::regclass), n;
END $$;

SET LOCAL lock_timeout = '15s';   -- jangan antre lama bila ada tulis padat
SET LOCAL statement_timeout = '10min';

-- ---------------------------------------------------------------------------
-- 1. SIAPKAN PARTISI MASA DEPAN (sebelum membuang yang lama, agar tulis ESP32
--    tak jatuh ke DEFAULT partition karena rentang tak tersedia).
--    Tipe argumen = date, jadi now()::date + 30 (now()+30 = interval, invalid).
-- ---------------------------------------------------------------------------
SELECT fn_partisi_readings_bulanan(now()::date + 30) AS partisi_dibuat_30h;
SELECT fn_partisi_readings_bulanan(now()::date + 60) AS partisi_dibuat_60h;

-- ---------------------------------------------------------------------------
-- 2. RETENSI MENTAH — buang partisi yang berakhir <= now() - 60 hari.
--    Mengembalikan jumlah partisi yang dipensiunkan (0 = tidak ada yang wajar
--    dibuang bulan ini; itu normal, bukan kegagalan).
--    CATATAN: partisi yang di-DROP ikut membawa barisnya; rollup hourly TIDAK
--    ikut terbuang (itu data laporan jangka panjang).
-- ---------------------------------------------------------------------------
SELECT fn_pensiun_readings(60) AS partisi_dipensiunkan;

-- ---------------------------------------------------------------------------
-- 3. RETENSI TABEL NON-PARTISI (guard to_regclass agar tetap aman bila salah
--    satu tabel belum dibuat oleh paket V2).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    n integer;
BEGIN
    IF to_regclass('public.sensor_readings_hourly') IS NOT NULL THEN
        EXECUTE 'DELETE FROM public.sensor_readings_hourly
                  WHERE bucket_start < now() - interval ''2 years''';
        GET DIAGNOSTICS n = ROW_COUNT;
        RAISE NOTICE 'sensor_readings_hourly kadaluarsa (2 thn) dihapus: %', n;
    END IF;

    IF to_regclass('public.audit_logs') IS NOT NULL THEN
        EXECUTE 'DELETE FROM public.audit_logs
                  WHERE terjadi_pada < now() - interval ''365 days''';
        GET DIAGNOSTICS n = ROW_COUNT;
        RAISE NOTICE 'audit_logs kadaluarsa (365 hari) dihapus: %', n;
    END IF;

    IF to_regclass('public.report_logs') IS NOT NULL THEN
        EXECUTE 'DELETE FROM public.report_logs
                  WHERE created_at < now() - interval ''365 days''';
        GET DIAGNOSTICS n = ROW_COUNT;
        RAISE NOTICE 'report_logs kadaluarsa (365 hari) dihapus: %', n;
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. RINGKASAN (baris ini yang tercetak di log cron — berguna untuk grep).
--    Kosong = tabel memang belum ada isinya.
-- ---------------------------------------------------------------------------
SELECT (SELECT count(*) FROM pg_inherits WHERE inhparent = 'public.sensor_readings'::regclass
          AND (SELECT c.relname FROM pg_class c WHERE c.oid = inhrelid) <> 'sensor_readings_default'
        )                                             AS partisi_mentah_aktif,
       (SELECT count(*) FROM sensor_readings)         AS baris_mentah,
       (SELECT count(*) FROM sensor_readings_hourly)  AS baris_rollup,
       (SELECT count(*) FROM audit_logs)              AS baris_audit,
       (SELECT count(*) FROM report_logs)             AS baris_laporan;

COMMIT;

-- ============================================================================
-- ROLLBACK / BATAL: cukup matikan transaksi — otomatis ter-rollback. Tidak ada
-- data yang "setengah terhapus" karena SELURUH skrip satu transaksi.
-- ============================================================================
