-- 18 Nov 2026 — Kurva naik harian disalin ke BATCH saat mulai semai (dulu dibaca langsung dari tanamen,
-- sehingga mengubah kurva tanaman melompatkan target semua batch berjalan).
-- Perubahan kurva di tengah jalan melanjutkan dari target hari itu (kurva_mulai_hari/ppm), tanpa lompatan:
--   target(h) = kurva_mulai_ppm + (kurva_ppm_target − kurva_mulai_ppm) × (h − kurva_mulai_hari) / (kurva_hari_capai − kurva_mulai_hari)
--   h = hari sejak pindah netpot; h ≥ kurva_hari_capai → kurva_ppm_target.
-- Hanya ADD COLUMN nullable + backfill dari kurva tanaman saat ini (hasil hitung sama dengan sebelumnya).
ALTER TABLE semais ADD COLUMN IF NOT EXISTS kurva_ppm_awal integer;
ALTER TABLE semais ADD COLUMN IF NOT EXISTS kurva_ppm_target integer;
ALTER TABLE semais ADD COLUMN IF NOT EXISTS kurva_hari_capai integer;
ALTER TABLE semais ADD COLUMN IF NOT EXISTS kurva_mulai_hari integer;
ALTER TABLE semais ADD COLUMN IF NOT EXISTS kurva_mulai_ppm integer;
ALTER TABLE semais ADD COLUMN IF NOT EXISTS kurva_diubah_pada timestamp without time zone;
COMMENT ON COLUMN semais.kurva_ppm_awal IS 'ppm hari pindah netpot (salinan kurva tanaman saat mulai semai)';
COMMENT ON COLUMN semais.kurva_mulai_hari IS 'hari ke-h (sejak netpot) kurva terakhir diubah; 0 = belum pernah diubah';
COMMENT ON COLUMN semais.kurva_mulai_ppm IS 'target ppm pada kurva_mulai_hari (titik lanjut tanpa lompatan)';

UPDATE semais s
   SET kurva_ppm_awal = t.ppm_awal, kurva_ppm_target = t.ppm_target, kurva_hari_capai = t.hari_capai,
       kurva_mulai_hari = 0, kurva_mulai_ppm = t.ppm_awal
  FROM tanamen t
 WHERE t.id_tanaman = s.id_tanaman AND s.kurva_ppm_awal IS NULL
   AND t.ppm_awal IS NOT NULL AND t.ppm_target IS NOT NULL AND t.hari_capai IS NOT NULL;

ALTER TABLE semais DROP CONSTRAINT IF EXISTS semais_kurva_cek;
ALTER TABLE semais ADD CONSTRAINT semais_kurva_cek CHECK (
  kurva_ppm_awal IS NULL OR (
    kurva_ppm_awal BETWEEN 50 AND 2500 AND kurva_ppm_target BETWEEN 50 AND 2500
    AND kurva_hari_capai BETWEEN 1 AND 365
    AND kurva_mulai_hari BETWEEN 0 AND kurva_hari_capai AND kurva_mulai_ppm BETWEEN 50 AND 2500));
