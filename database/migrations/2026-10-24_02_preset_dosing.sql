-- MIGRASI — preset dosing otomatis (target EC/pH penampung diambil dari preset target_nutrisi)
-- Tanggal : 2026-10-24
-- Masalah : target_ec_ppm/target_ph tiap penampung diisi manual satu per satu; tabel target_nutrisi
--           (target per tanaman × tahap × umur) sudah ada tetapi tidak pernah dipakai otomasi.
-- Solusi  : penampung_states.target_mode = 'otomatis' → server mengisi target dari preset yang cocok
--           dengan batch yang sedang berjalan di meja itu (src/presetDosing.js). 'manual' → target
--           diisi admin dan tidak disentuh sinkronisasi.
--           Penampung yang SUDAH punya target diisi 'manual' agar nilainya tidak berubah diam-diam.
-- Idempoten.
BEGIN;

ALTER TABLE penampung_states ADD COLUMN IF NOT EXISTS target_mode varchar(10) NOT NULL DEFAULT 'otomatis';
ALTER TABLE penampung_states ADD COLUMN IF NOT EXISTS target_preset_id bigint;
ALTER TABLE penampung_states ADD COLUMN IF NOT EXISTS target_diperbarui timestamp without time zone;

ALTER TABLE penampung_states DROP CONSTRAINT IF EXISTS penampung_states_target_mode_check;
ALTER TABLE penampung_states ADD CONSTRAINT penampung_states_target_mode_check CHECK (target_mode IN ('otomatis', 'manual'));
ALTER TABLE penampung_states DROP CONSTRAINT IF EXISTS penampung_states_target_preset_fk;
ALTER TABLE penampung_states ADD CONSTRAINT penampung_states_target_preset_fk
  FOREIGN KEY (target_preset_id) REFERENCES target_nutrisi(id) ON DELETE SET NULL;

UPDATE penampung_states SET target_mode = 'manual'
 WHERE target_mode = 'otomatis' AND target_preset_id IS NULL AND (target_ec_ppm IS NOT NULL OR target_ph IS NOT NULL);

COMMIT;
