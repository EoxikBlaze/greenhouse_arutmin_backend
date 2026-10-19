-- ============================================================================
-- REINDEX + ANALYZE — monitorings & partisi sensor_readings (anti bloat)
--
-- STATUS  : DRAFT — BELUM DIEKSEKUSI. BUTUH PERSETUJUAN USER untuk dijalankan
--           ke database live `vertonik_smartfarm`. Uji di scratch dulu
--           (README_CRON.md bagian Uji).
-- RASIONAL: audit AUDIT_PERFORMA_GARAP.md mencatat index ganda + tulis pola
--           5 detik; tabel kecil tapi dead tuple / index lama tetap menumpuk
--           (autoanalyze menemukan n_dead_tup di monitorings & alert_logs).
--           REINDEX biasa (bukan CONCURRENTLY) memakai ACCESS EXCLUSIVE lock
--           singkat — ukuran tabel di sini kecil (KB), jadi lock hanya
--           milidetik. Bila kelak tabel sudah ratusan MB, ganti ke
--           `REINDEX TABLE ... CONCURRENTLY` (TIDAK boleh dalam transaksi).
-- JADWAL  : bulanan (opsional) — lihat README_CRON.md.
-- PANGGIL : psql -X -v ON_ERROR_STOP=1 -f database/reindex_monitorings.sql
-- SIFAT   : idempoten (diulang berapa kali pun hasilnya sama). Bagian 0-1-2 =
--           satu transaksi (gagal di tengah = rollback penuh); bagian 2b-4 =
--           autocommit, karena `REINDEX TABLE <tabel partisi>` di PostgreSQL 17
--           DILARANG di dalam blok transaksi.
-- CATATAN : skrip ini TIDAK membuat/menghapus index, TIDAK mengubah DDL — hanya
--           membangun ulang index yang sudah ada + statistik.
-- ============================================================================

\set ON_ERROR_STOP on

BEGIN;

SET LOCAL lock_timeout = '5s';   -- menolak mengantre lama di belakang tulis aktif
SET LOCAL statement_timeout = '30min';

-- ---------------------------------------------------------------------------
-- 0. PRA-SYARAT
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF to_regclass('public.monitorings') IS NULL THEN
        RAISE EXCEPTION 'monitorings tidak ada';
    END IF;
    IF to_regclass('public.sensor_readings') IS NULL THEN
        RAISE EXCEPTION 'sensor_readings tidak ada — skema V2 belum terpasang';
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. SEBELUM (bukti kondisi awal — dicetak di log cron)
-- ---------------------------------------------------------------------------
SELECT c.relname,
       pg_size_pretty(pg_relation_size(c.oid))        AS ukuran,
       coalesce(s.n_live_tup, 0)                      AS baris_hidup,
       coalesce(s.n_dead_tup, 0)                      AS baris_mati,
       s.last_vacuum,
       s.last_autovacuum
  FROM pg_class c
  LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
 WHERE c.oid = 'public.monitorings'::regclass
    OR c.relname = 'sensor_readings'
 ORDER BY c.relname;

-- ---------------------------------------------------------------------------
-- 2. REINDEX — monitorings + seluruh partisi sensor_readings (bulanan & DEFAULT)
--    + hourly/latest, lalu ANALYZE statistiknya.
--    DI DALAM transaksi hanya relasi biasa (relkind='r'): PARTISI dan tabel
--    biasa aman direindex dalam blok transaksi.
--    INDUK tabel partisi (relkind='p') sengaja DILOMPATKAN di sini — pada
--    PostgreSQL 17 `REINDEX TABLE <tabel partisi>` DILARANG di dalam blok
--    transaksi ("REINDEX TABLE cannot run inside a transaction block"), jadi
--    diurus terpisah pada langkah 2b setelah COMMIT.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    r record;
    n integer := 0;
BEGIN
    FOR r IN
        SELECT c.oid, c.relname, c.relkind
          FROM pg_class c
          JOIN pg_namespace ns ON ns.oid = c.relnamespace
         WHERE ns.nspname = 'public'
           AND c.relkind = 'r'
           AND (c.relname = 'monitorings'
                OR c.relname LIKE 'sensor_readings_%')
         ORDER BY c.relname
    LOOP
        EXECUTE format('REINDEX TABLE public.%I', r.relname);
        EXECUTE format('ANALYZE public.%I', r.relname);
        n := n + 1;
        RAISE NOTICE 'REINDEX+ANALYZE % (%)', r.relname, r.relkind;
    END LOOP;
    RAISE NOTICE 'total tabel/partisi direindex: %', n;
END $$;

-- ---------------------------------------------------------------------------
-- 2b. SESUDAH COMMIT — REINDEX induk partisi (wajib di luar transaksi, PG17).
--     Induk hanya mempunyai index partisi tanpa penyimpanan sendiri, jadi
--     langkah ini cepat; tetap penting supaya keabsahan (indisvalid) indeks
--     induk ikut diperiksa ulang.
-- ---------------------------------------------------------------------------
COMMIT;

REINDEX TABLE public.sensor_readings;
ANALYZE public.sensor_readings;

-- ---------------------------------------------------------------------------
-- 3. SESUDAH (bandingkan dengan langkah 1; baris_mati harus 0)
-- ---------------------------------------------------------------------------
SELECT c.relname,
       pg_size_pretty(pg_relation_size(c.oid))        AS ukuran,
       coalesce(s.n_live_tup, 0)                      AS baris_hidup,
       coalesce(s.n_dead_tup, 0)                      AS baris_mati,
       s.last_analyze
  FROM pg_class c
  LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
 WHERE c.oid = 'public.monitorings'::regclass
    OR c.relname = 'sensor_readings'
 ORDER BY c.relname;

-- ---------------------------------------------------------------------------
-- 4. SEHAT-HIDUP index: pastikan tak ada index invalid/sampah hasil REINDEX
--    yang tertinggal (khususnya index ber-ARKIV / invalid).
-- ---------------------------------------------------------------------------
SELECT c.relname AS tabel,
       i.relname AS index_name,
       indisvalid,
       indisready,
       pg_size_pretty(pg_relation_size(i.oid)) AS ukuran
  FROM pg_index x
  JOIN pg_class i ON i.oid = x.indexrelid
  JOIN pg_class c ON c.oid = x.indrelid
 WHERE c.relname = 'monitorings'
    OR c.relname LIKE 'sensor_readings%'
 ORDER BY c.relname, i.relname;

-- ============================================================================
-- BILA gagal dengan "index is not valid": perbaiki dengan
--   REINDEX INDEX <nama_index>;   -- non-concurrent, aman di transaksi
-- BILA lock_timeout tercapai (tulisan ESP32 sedang padat): jalankan ulang pada
--   jam sepi, atau gunakan REINDEX ... CONCURRENTLY (tanpa BEGIN).
-- ============================================================================
