-- 17 Nov 2026 — Status & progres setup wizard per penampung (lintas perangkat/akun).
ALTER TABLE penampung_states
  ADD COLUMN IF NOT EXISTS setup_selesai boolean NOT NULL DEFAULT false;

ALTER TABLE penampung_states
  ADD COLUMN IF NOT EXISTS setup_selesai_pada timestamptz;

ALTER TABLE penampung_states
  ADD COLUMN IF NOT EXISTS setup_progres jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN penampung_states.setup_selesai IS 'Menandakan wizard setup awal penampung telah diselesaikan oleh admin';
COMMENT ON COLUMN penampung_states.setup_selesai_pada IS 'Waktu penyelesaian wizard setup awal penampung';
COMMENT ON COLUMN penampung_states.setup_progres IS 'Progres tiap langkah setup wizard (kalibrasi, tandon, uji lab, tutorial semai, jumlah semai)';
