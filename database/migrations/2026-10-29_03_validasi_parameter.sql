-- MIGRASI — status validasi parameter & idempotensi transisi siklus (Fase 3B)
-- Tanggal : 2026-10-29
-- Sifat   : ADITIF. Nilai parameter lama TIDAK diubah. Kolom `tervalidasi` baru default false: belum ada
--           parameter yang divalidasi terhadap alat fisik (sumber "Perancangan FINAL" = dokumen desain).
--           Hanya tiga parameter KEBIJAKAN yang diputuskan eksplisit oleh pengguna ditandai tervalidasi.
BEGIN;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['konfigurasi_dosis', 'timing_operasi'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS tervalidasi boolean NOT NULL DEFAULT false', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS divalidasi_oleh bigint REFERENCES users(id) ON DELETE SET NULL', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS divalidasi_pada timestamptz', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS catatan_validasi text', t);
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t, t || '_validasi_cek');
    -- tervalidasi hanya untuk nilai yang ada, dengan waktu & catatan validasi
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (NOT tervalidasi OR (nilai IS NOT NULL AND divalidasi_pada IS NOT NULL AND catatan_validasi IS NOT NULL))',
      t, t || '_validasi_cek');
  END LOOP;
END $$;

-- Nilai berubah → status validasi gugur (kecuali UPDATE yang sama sekaligus memvalidasi ulang).
CREATE OR REPLACE FUNCTION parameter_validasi_gugur() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.nilai IS DISTINCT FROM OLD.nilai AND OLD.tervalidasi AND NEW.tervalidasi
     AND NEW.divalidasi_pada IS NOT DISTINCT FROM OLD.divalidasi_pada THEN
    NEW.tervalidasi := false;
    NEW.divalidasi_oleh := NULL;
    NEW.divalidasi_pada := NULL;
    NEW.catatan_validasi := NULL;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS konfigurasi_dosis_validasi_gugur ON konfigurasi_dosis;
CREATE TRIGGER konfigurasi_dosis_validasi_gugur BEFORE UPDATE ON konfigurasi_dosis
  FOR EACH ROW EXECUTE FUNCTION parameter_validasi_gugur();
DROP TRIGGER IF EXISTS timing_operasi_validasi_gugur ON timing_operasi;
CREATE TRIGGER timing_operasi_validasi_gugur BEFORE UPDATE ON timing_operasi
  FOR EACH ROW EXECUTE FUNCTION parameter_validasi_gugur();

-- Keputusan kebijakan eksplisit pengguna (bukan kalibrasi alat).
UPDATE konfigurasi_dosis SET tervalidasi = true, divalidasi_pada = now(),
       catatan_validasi = 'Keputusan pengguna 2026-10-28 (kebijakan FAULT, bukan hasil uji alat)'
 WHERE param = 'maks_gagal_berturut' AND nilai = 4 AND NOT tervalidasi;
UPDATE timing_operasi SET tervalidasi = true, divalidasi_pada = now(),
       catatan_validasi = 'Keputusan pengguna (spesifikasi Fase 3: H+4 = 96 jam sejak semai dimulai)'
 WHERE param = 'konfirmasi_peremajaan_jam_ke' AND nilai = 96 AND NOT tervalidasi;
UPDATE timing_operasi SET tervalidasi = true, divalidasi_pada = now(),
       catatan_validasi = 'Keputusan pengguna (spesifikasi: batas jawab konfirmasi peremajaan 24 jam)'
 WHERE param = 'konfirmasi_peremajaan_batas_jam' AND nilai = 24 AND NOT tervalidasi;

-- Idempotensi operasi siklus: setiap operasi tulis menghasilkan tepat satu transisi berkunci.
ALTER TABLE siklus_transisi ADD COLUMN IF NOT EXISTS idempotency_key uuid;
ALTER TABLE siklus_transisi ADD COLUMN IF NOT EXISTS permintaan_hash char(64);
CREATE UNIQUE INDEX IF NOT EXISTS siklus_transisi_idem_unik ON siklus_transisi (idempotency_key) WHERE idempotency_key IS NOT NULL;
ALTER TABLE siklus_transisi DROP CONSTRAINT IF EXISTS siklus_transisi_idem_cek;
ALTER TABLE siklus_transisi ADD CONSTRAINT siklus_transisi_idem_cek CHECK ((idempotency_key IS NULL) = (permintaan_hash IS NULL));

COMMIT;
