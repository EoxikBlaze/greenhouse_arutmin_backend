-- MIGRASI — target nutrisi naik per hari, per jenis tanaman
-- Tanggal : 2026-10-27
-- Masalah : target ppm penampung hanya titik tengah preset per tahap → naik bertangga (mis. melon
--           500 → 1000 → 1125 ppm). Praktik petani: setelah pindah netpot mulai ±400 ppm lalu dinaikkan
--           sedikit tiap hari sampai target akhir (melon 2400 ppm ±2 bulan).
-- Solusi  : tiap tanaman boleh punya ppm_awal, ppm_target, hari_capai. Mulai tahap Peremajaan (pindah
--           netpot) target = awal + (target − awal) × hari / hari_capai, lalu ditahan di target sampai panen.
--           Kosong = tetap memakai preset per tahap (src/presetDosing.js). Idempoten.
BEGIN;

ALTER TABLE tanamen ADD COLUMN IF NOT EXISTS ppm_awal numeric(8,2);
ALTER TABLE tanamen ADD COLUMN IF NOT EXISTS ppm_target numeric(8,2);
ALTER TABLE tanamen ADD COLUMN IF NOT EXISTS hari_capai integer;

ALTER TABLE tanamen DROP CONSTRAINT IF EXISTS tanamen_naik_harian_cek;
ALTER TABLE tanamen ADD CONSTRAINT tanamen_naik_harian_cek CHECK (
  (ppm_awal IS NULL AND ppm_target IS NULL AND hari_capai IS NULL)
  OR (ppm_awal BETWEEN 50 AND 2500 AND ppm_target BETWEEN 50 AND 2500 AND ppm_awal <= ppm_target
      AND hari_capai BETWEEN 1 AND 365)
);

COMMIT;
