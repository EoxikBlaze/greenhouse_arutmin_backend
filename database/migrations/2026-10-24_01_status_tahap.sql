-- MIGRASI — status berjalan/selesai untuk peremajaan & pendewasaan
-- Tanggal : 2026-10-24
-- Masalah : hanya semais yang punya kolom status. POST /tanam/peremajaan|pendewasaan/:id/selesai
--           menulis "status = 'selesai'" ke tabel tanpa kolom itu → 500 untuk SETIAP batch (tombol
--           "Selesaikan tahap" di aplikasi HP tidak pernah berhasil), dan GET /tanam serta dashboard
--           menampilkan semua peremajaan/pendewasaan sebagai "aktif" selamanya.
-- Solusi  : kolom status ('proses' | 'selesai' | 'gagal'), sama dengan semais. Baris lama yang sudah
--           punya tahap lanjutan (pendewasaan / panen) diisi 'selesai'; sisanya 'proses'.
-- Idempoten.
BEGIN;

ALTER TABLE peremajaans ADD COLUMN IF NOT EXISTS status varchar(20) NOT NULL DEFAULT 'proses';
ALTER TABLE pendewasaans ADD COLUMN IF NOT EXISTS status varchar(20) NOT NULL DEFAULT 'proses';

ALTER TABLE peremajaans DROP CONSTRAINT IF EXISTS peremajaans_status_check;
ALTER TABLE peremajaans ADD CONSTRAINT peremajaans_status_check CHECK (status IN ('proses', 'selesai', 'gagal'));
ALTER TABLE pendewasaans DROP CONSTRAINT IF EXISTS pendewasaans_status_check;
ALTER TABLE pendewasaans ADD CONSTRAINT pendewasaans_status_check CHECK (status IN ('proses', 'selesai', 'gagal'));

UPDATE peremajaans p SET status = 'selesai'
 WHERE status = 'proses' AND EXISTS (SELECT 1 FROM pendewasaans d WHERE d.id_peremajaan = p.id_peremajaan);
UPDATE pendewasaans d SET status = 'selesai'
 WHERE status = 'proses' AND EXISTS (SELECT 1 FROM panens x WHERE x.id_pendewasaan = d.id_pendewasaan);

CREATE INDEX IF NOT EXISTS idx_peremajaans_status ON peremajaans (status);
CREATE INDEX IF NOT EXISTS idx_pendewasaans_status ON pendewasaans (status);

COMMIT;
