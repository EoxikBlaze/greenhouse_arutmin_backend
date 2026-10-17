-- ============================================================================
-- MIGRASI — panens.id_pendewasaan : ON DELETE CASCADE → ON DELETE RESTRICT
-- Tanggal : 2026-10-17
-- Alasan  : menghapus 1 baris pendewasaan ikut menghapus baris PANEN (riwayat
--           panen = data paling berharga). Dengan RESTRICT, pendewasaan hanya
--           bisa dihapus bila belum ada panen yang merujuknya.
-- Jalankan: psql "$DATABASE_URL" -f database/migrations/2026-10-17_panens_fk_restrict.sql
-- Idempoten: DROP IF EXISTS + ADD selalu berakhir pada kondisi RESTRICT.
--            (scripts/restore.sh menjalankan seluruh database/migrations/*.sql otomatis)
-- ============================================================================

BEGIN;

ALTER TABLE panens
  DROP CONSTRAINT IF EXISTS panens_id_pendewasaan_foreign;

ALTER TABLE panens
  ADD CONSTRAINT panens_id_pendewasaan_foreign
  FOREIGN KEY (id_pendewasaan)
  REFERENCES pendewasaans (id_pendewasaan)
  ON DELETE RESTRICT;

COMMIT;

-- Verifikasi (harus: ON DELETE RESTRICT)
-- SELECT pg_get_constraintdef(oid) FROM pg_constraint
--  WHERE conname = 'panens_id_pendewasaan_foreign';
