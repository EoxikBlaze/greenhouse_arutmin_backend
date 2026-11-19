-- 19 Nov 2026 — Master Data untuk alur Mulai Semai → KONFIGURASI → SEMAI (firmware v6, Kontrak MQTT v2.0 §6.2/§8.1).
-- Jenis Tanaman: DUA resep — per hari (ppm_awal/ppm_target/hari_capai, sudah ada) dan per siklus (ppm per tahap) — + rentang pH.
--   Cara yang dipakai DIPILIH saat Mulai Semai (disimpan di batch: semais.kurva_cara), bukan di master.
-- Meja/Penampung: waktu monitoring & jeda A→B (NULL = dihitung otomatis dari talang & volume).
-- Batch (semais): salinan cara naik, ppm per tahap, pH — mengubah master tidak menggeser batch berjalan.
-- Alat terpasang di meja memakai kolom yang sudah ada: perangkat.id_meja.
-- Hanya ADD COLUMN nullable/bawaan + CHECK; aman diulang.

ALTER TABLE tanamen ADD COLUMN IF NOT EXISTS ppm_semai integer;
ALTER TABLE tanamen ADD COLUMN IF NOT EXISTS ppm_peremajaan integer;
ALTER TABLE tanamen ADD COLUMN IF NOT EXISTS ppm_pendewasaan integer;
ALTER TABLE tanamen ADD COLUMN IF NOT EXISTS ph_min numeric(4,2);
ALTER TABLE tanamen ADD COLUMN IF NOT EXISTS ph_max numeric(4,2);
COMMENT ON COLUMN tanamen.ppm_semai IS 'resep per siklus: ppm dijaga tetap selama tahap Semai (dipakai bila Mulai Semai memilih per siklus)';
ALTER TABLE tanamen DROP CONSTRAINT IF EXISTS tanamen_ppm_tahap_check;
ALTER TABLE tanamen ADD CONSTRAINT tanamen_ppm_tahap_check CHECK (
  (ppm_semai IS NULL OR ppm_semai BETWEEN 50 AND 2500)
  AND (ppm_peremajaan IS NULL OR ppm_peremajaan BETWEEN 50 AND 2500)
  AND (ppm_pendewasaan IS NULL OR ppm_pendewasaan BETWEEN 50 AND 2500)
  -- resep per siklus diisi lengkap atau dikosongkan semua
  AND ((ppm_semai IS NULL AND ppm_peremajaan IS NULL AND ppm_pendewasaan IS NULL)
       OR (ppm_semai IS NOT NULL AND ppm_peremajaan IS NOT NULL AND ppm_pendewasaan IS NOT NULL)));
-- rentang pH yang diterima firmware: 4,0–8,5, selisih ≥ 0,2 (Kontrak §6.2 SEMAI)
ALTER TABLE tanamen DROP CONSTRAINT IF EXISTS tanamen_ph_check;
ALTER TABLE tanamen ADD CONSTRAINT tanamen_ph_check CHECK (
  (ph_min IS NULL AND ph_max IS NULL)
  OR (ph_min BETWEEN 4 AND 8.5 AND ph_max BETWEEN 4 AND 8.5 AND ph_max - ph_min >= 0.2));

-- rentang firmware (Kontrak §6.4): monitoring_menit 5–720, jeda_ab_dtk 10–900
ALTER TABLE mejas ADD COLUMN IF NOT EXISTS monitoring_menit integer;
ALTER TABLE mejas ADD COLUMN IF NOT EXISTS jeda_ab_dtk integer;
ALTER TABLE mejas DROP CONSTRAINT IF EXISTS mejas_monitoring_menit_check;
ALTER TABLE mejas ADD CONSTRAINT mejas_monitoring_menit_check CHECK (monitoring_menit IS NULL OR monitoring_menit BETWEEN 5 AND 720);
ALTER TABLE mejas DROP CONSTRAINT IF EXISTS mejas_jeda_ab_dtk_check;
ALTER TABLE mejas ADD CONSTRAINT mejas_jeda_ab_dtk_check CHECK (jeda_ab_dtk IS NULL OR jeda_ab_dtk BETWEEN 10 AND 900);
COMMENT ON COLUMN mejas.monitoring_menit IS 'NULL = dihitung otomatis (2 × satu putaran larutan)';
COMMENT ON COLUMN mejas.jeda_ab_dtk IS 'NULL = dihitung otomatis dari satu putaran larutan';

ALTER TABLE semais ADD COLUMN IF NOT EXISTS kurva_cara varchar(10);
COMMENT ON COLUMN semais.kurva_cara IS 'cara naik ppm yang dipilih saat Mulai Semai: harian (per hari, sejak Mulai Semai) | tahap (per siklus) | NULL = batch lama (sejak pindah netpot)';
ALTER TABLE semais ADD COLUMN IF NOT EXISTS kurva_ppm_semai integer;
ALTER TABLE semais ADD COLUMN IF NOT EXISTS kurva_ppm_peremajaan integer;
ALTER TABLE semais ADD COLUMN IF NOT EXISTS kurva_ppm_pendewasaan integer;
ALTER TABLE semais ADD COLUMN IF NOT EXISTS kurva_ph_min numeric(4,2);
ALTER TABLE semais ADD COLUMN IF NOT EXISTS kurva_ph_max numeric(4,2);
-- Batch lama (kurva_cara NULL) memakai rumus lama sejak pindah netpot supaya targetnya tidak melompat;
-- batch baru 'harian' dihitung sejak Mulai Semai (hari pertama = ppm awal).
