-- ============================================================================
-- SARAN INDEX UNTUK /laporan, /tarik, /chart-data, getReport6Jam (SARGABLE)
--
-- STATUS  : DRAFT — BELUM DIEKSEKUSI. BUTUH PERSETUJUAN USER untuk dijalankan
--           ke database live `vertonik_smartfarm`. Uji di scratch dulu
--           (README_CRON.md bagian Uji).
-- SUMBER  : pola query dibaca dengan GREP saja dari src/ (daftar baris di
--           bawah) — tidak ada file src/ yang diubah oleh berkas ini.
-- TEMUAN  : kolom tanggal yang dipakai /laporan SUDAH terindeks semua
--           (idx_semais_tgl, idx_peremajaans_tgl, idx_pendewasaans_tgl,
--           idx_panens_tgl, idx_monitorings_created). Yang kurang sargable
--           adalah PREDIKATNYA: `date_trunc('month', kolom) = bln` memaksa
--           evaluasi fungsi per baris sehingga index tak bisa dipakai. Karena
--           itu berkas ini berisi (a) index pelengkap (covering) yang benar-
--           benar belum ada, (b) bentuk sargable dari query-nya, (c) saran
--           pembuangan index ganda (dicek: monitorings & alert_logs masing-
--           masing punya 2 index created_at — sisa pola audit performa).
-- EKSEKUSI: `CREATE INDEX CONCURRENTLY` TIDAK BOLEH di dalam transaksi.
--           Jalankan TANPA BEGIN:  psql -X -v ON_ERROR_STOP=1 -f database/index_laporan.sql
--           (psql default = autocommit per statement -> aman; jangan pakai -1/-f
--           berbarengan dengan berkas lain dalam satu transaksi).
-- SIFAT   : idempoten (IF NOT EXISTS) — aman diulang.
-- ============================================================================

\set ON_ERROR_STOP on

-- ============================================================================
-- A. POLA QUERY YANG DIBACA (grep src/ — referensi, jangan diubah dari sini)
-- ----------------------------------------------------------------------------
-- src/routes/laporan.js:12-19  matrix(): subquery terkorelasi per bulan
--     SELECT count(*) FROM semais s
--      WHERE date_trunc('month', s.tgl_awal_semai) = bln          -- NON-SARGABLE
--     pola sama utk peremajaans (tgl_awal_peremajaan),
--     pendewasaans (tgl_awal_pendewasaan), panens (tgl_panen, sum panen_berhasil),
--     monitorings (avg m.ph utk "RATA-RATA PH").
-- src/routes/monitoring.js:104-105 getReport6Jam: avg(...) FROM monitorings
--     WHERE created_at >= now() - interval '6 hours'               -- sargable (index sudah ada)
-- src/routes/monitoring.js:106              alert_logs created_at >= now()-6h ORDER BY created_at DESC
-- src/routes/monitoring.js:140              monitorings ORDER BY created_at DESC LIMIT 288
-- src/routes/monitoring.js:152-153 /tarik   monitorings WHERE created_at >= $1 <= $2 ORDER BY created_at DESC LIMIT n
-- src/routes/monitoring.js:165-166 /tarik/csv  sama, LIMIT 5000
-- src/routes/dashboard.js:13                monitorings ORDER BY created_at DESC LIMIT 1
-- src/routes/dashboard.js:56                panens ORDER BY tgl_panen DESC LIMIT 5
-- ----------------------------------------------------------------------------

-- ============================================================================
-- B. INDEX BARU (pelengkap/covering — belum ada di live)
-- ============================================================================

-- B1. monitorings: seluruh agregat /laporan & getReport6Jam mengambil metrik
--     di rentang created_at. Dengan INCLUDE (ph, waterTemp, airTemp, humidity,
--     tds) indeks ini menampung SEMUA kolom yang dibaca -> Index Only Scan,
--     tanpa menyentuh heap. (Barisnya kecil, tapi pola tulisnya 5 detik,
--     jadi menghemat juga bacaan dashboard & 6-jam-an.)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_monitorings_created_metrics
    ON public.monitorings USING btree (created_at DESC)
    INCLUDE (ph, "waterTemp", "airTemp", humidity, tds);

-- B2. panens: /laporan menjumlahkan panen_berhasil per bulan (kolom proyeksi),
--     dashboard mengurutkan tgl_panen DESC LIMIT 5. Index + INCLUDE membuat
--     kedua jalur itu index-only.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_panens_tgl_panen_hasil
    ON public.panens USING btree (tgl_panen DESC)
    INCLUDE (panen_berhasil, panen_gagal);

-- B3. rollup V2 untuk laporan > 24 jam: rentang lintas meja pada
--     sensor_readings_hourly memakai PK (id_meja, bucket_start) utk 1 meja dan
--     idx_readings_hourly_bucket utk lintas meja; keduanya sudah ada.
--     Index pelengkap berikut hanya diperlukan bila kelak ada laporan yang
--     mengambil kolom metrik per rentang (index-only) — DIKOMENTARI agar tidak
--     menambah write amplification tanpa query pemakainya:
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_hourly_bucket_metrics
--     ON public.sensor_readings_hourly USING btree (bucket_start DESC)
--     INCLUDE (n_bacaan, n_valid, ph_avg, ec_avg, suhu_air_avg, kelembapan_avg);

-- ============================================================================
-- C. BENTUK SARGABLE untuk query /laporan (rekomendasi perubahan kode — DOKUMEN,
--    bukan eksekusi SQL; agen yang mengedit src/ yang menerapkannya)
-- ----------------------------------------------------------------------------
-- Sebelum (laporan.js, NON-SARGABLE — date_trunc dipakai per baris):
--     SELECT round(avg(m.ph)::numeric,2)
--       FROM monitorings m
--      WHERE date_trunc('month', m.created_at) = bln;
-- Sesudah (rentang, index dipakai -> pg_operator + range scan):
--     SELECT round(avg(m.ph)::numeric,2)
--       FROM monitorings m
--      WHERE m.created_at >= bln AND m.created_at < bln + interval '1 month';
--     -- bln berasal dari date_trunc('month', ...) di CTE bulan (tetap utuh,
--     -- karena hanya dijalankan sekali utk daftar bulan)
--
-- Untuk kolom date (tgl_awal_semai / tgl_awal_peremajaan /
-- tgl_awal_pendewasaan / tgl_panen) rentangnya memakai ::date:
--     WHERE s.tgl_awal_semai >= bln::date
--       AND s.tgl_awal_semai  < (bln + interval '1 month')::date
--
-- /tarik & /chart-data sudah sargable (created_at >= $1 AND <= $2 ORDER BY
-- created_at DESC LIMIT n) — hanya perlu index urutan DESC, yang sudah ada
-- (idx_monitorings_created). Setelah B1 terpasang, kebutuhan itu tercakup
-- juga oleh idx_monitorings_created_metrics.
-- ============================================================================

-- ============================================================================
-- D. PEMBUANGAN INDEX GANDA (OPSIONAL — DIKOMENTARI; butuh persetujuan user)
--     Keduanya index pertama-urutan-arah-bertentangan dari index lain di
--     tabel yang sama (polanya persis temuan AUDIT_PERFORMA_GARAP.md: index
--     created_at ganda = pemborosan ruang + write amplifikasi tiap tulis 5 dtk).
--     Urutan aman: verifikasi EXPLAIN dulu (E), baru buka komentar di bawah.
-- ============================================================================
-- DROP INDEX CONCURRENTLY IF EXISTS public.monitorings_created_at_index;  -- ganda dari idx_monitorings_created (created_at DESC)
-- DROP INDEX CONCURRENTLY IF EXISTS public.alert_logs_created_at_index;   -- ganda dari idx_alertlogs_created (created_at DESC)
-- (idx_monitorings_id_meja_created DIPERTAHANKAN — dipakai saat tulis pindah
--  ke skema per-meja; alert_logs_type_index dipertahankan utk filter alert.)

-- ============================================================================
-- E. VERIFIKASI (SELECT saja — aman dijalankan di live read-only kapan pun)
-- ============================================================================

-- E1. daftar index + pemakaian (idx_scan) utk tabel yang disentuh /laporan
SELECT c.relname AS tabel,
       i.relname AS index_name,
       pg_size_pretty(pg_relation_size(i.oid)) AS ukuran,
       coalesce(s.idx_scan, 0) AS pemakaian_scan,
       pg_get_indexdef(x.indexrelid) AS definisi
  FROM pg_index x
  JOIN pg_class i ON i.oid = x.indexrelid
  JOIN pg_class c ON c.oid = x.indrelid
  LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = x.indexrelid
 WHERE c.relname IN ('monitorings', 'panens', 'semais', 'peremajaans',
                     'pendewasaans', 'alert_logs', 'sensor_readings_hourly')
 ORDER BY c.relname, i.relname;

-- E2. cek index invalid (hasil CREATE INDEX CONCURRENTLY yang terganggu)
SELECT c.relname AS tabel, i.relname AS index_name, x.indisvalid, x.indisready
  FROM pg_index x
  JOIN pg_class i ON i.oid = x.indexrelid
  JOIN pg_class c ON c.oid = x.indrelid
 WHERE NOT x.indisvalid OR NOT x.indisready;

-- E3. bukti sargable vs non-sargable utk /laporan (jalankan manual per query;
--     semua SELECT, aman di live):
--   EXPLAIN (ANALYZE, BUFFERS)
--   SELECT round(avg(m.ph)::numeric,2) FROM monitorings m
--    WHERE m.created_at >= date_trunc('month', now())
--      AND m.created_at <  date_trunc('month', now()) + interval '1 month';
--   EXPLAIN (ANALYZE, BUFFERS)
--   SELECT round(avg(m.ph)::numeric,2) FROM monitorings m
--    WHERE date_trunc('month', m.created_at) = date_trunc('month', now());
--   -- bentuk pertama harus terbaca "Index Only Scan idx_monitorings_created_metrics";
--   -- bentuk kedua memakai filter per baris (Seq Scan/Index Scan + Filter).
