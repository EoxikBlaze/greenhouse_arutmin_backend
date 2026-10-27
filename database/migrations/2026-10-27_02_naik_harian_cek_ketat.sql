-- MIGRASI — perketat CHECK naik harian: isian setengah harus ditolak DB
-- Tanggal : 2026-10-27
-- Masalah : CHECK lama `(semua NULL) OR (awal BETWEEN … AND target BETWEEN … AND hari BETWEEN …)` meloloskan
--           isian setengah (mis. hari_capai NULL tetapi ppm terisi): `NULL BETWEEN 1 AND 365` bernilai NULL,
--           dan CHECK hanya menolak FALSE. Ditemukan debugging S4 (27 Okt 2026). API sudah menolaknya;
--           ini menutup jalur lain (SQL langsung, impor). Idempoten.
BEGIN;

ALTER TABLE tanamen DROP CONSTRAINT IF EXISTS tanamen_naik_harian_cek;
ALTER TABLE tanamen ADD CONSTRAINT tanamen_naik_harian_cek CHECK (
  (ppm_awal IS NULL AND ppm_target IS NULL AND hari_capai IS NULL)
  OR (ppm_awal IS NOT NULL AND ppm_target IS NOT NULL AND hari_capai IS NOT NULL
      AND ppm_awal BETWEEN 50 AND 2500 AND ppm_target BETWEEN 50 AND 2500 AND ppm_awal <= ppm_target
      AND hari_capai BETWEEN 1 AND 365)
);

COMMIT;
