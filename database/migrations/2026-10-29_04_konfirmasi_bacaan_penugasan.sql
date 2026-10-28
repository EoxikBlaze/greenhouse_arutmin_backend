-- MIGRASI — bukti pengamatan sensor + penugasan petani ↔ penampung (Fase 3B.1)
-- Tanggal : 2026-10-29
-- Sifat   : ADITIF.
-- 1) monitorings: bacaan identik tidak menambah baris (hanya menyegarkan updated_at), jadi jumlah baris
--    tidak bisa membuktikan kestabilan, dan pemadaman yang diapit dua bacaan identik tersembunyi.
--    n_konfirmasi = berapa kali bacaan ini diterima; celah_maks_detik = jeda terpanjang antar penerimaan.
--    Baris LAMA sengaja dibiarkan NULL (= tidak diketahui → tidak dihitung sebagai bukti); default hanya
--    berlaku untuk baris baru (DEFAULT dipasang SETELAH kolom ditambahkan agar tidak di-backfill).
-- 2) penugasan_penampung: hak tulis petani per penampung. Belum ada baris → petani tidak punya hak tulis.
-- 3) parameter toleransi kestabilan: NULL (belum diputuskan) → transisi otomatis tetap mati.
BEGIN;

ALTER TABLE monitorings ADD COLUMN IF NOT EXISTS n_konfirmasi integer;
ALTER TABLE monitorings ADD COLUMN IF NOT EXISTS celah_maks_detik integer;
ALTER TABLE monitorings ALTER COLUMN n_konfirmasi SET DEFAULT 1;
ALTER TABLE monitorings ALTER COLUMN celah_maks_detik SET DEFAULT 0;
ALTER TABLE monitorings DROP CONSTRAINT IF EXISTS monitorings_konfirmasi_cek;
ALTER TABLE monitorings ADD CONSTRAINT monitorings_konfirmasi_cek
  CHECK ((n_konfirmasi IS NULL OR n_konfirmasi >= 1) AND (celah_maks_detik IS NULL OR celah_maks_detik >= 0));

CREATE TABLE IF NOT EXISTS penugasan_penampung (
  id            bigserial PRIMARY KEY,
  id_user       bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id_meja       bigint NOT NULL REFERENCES mejas(id_meja) ON DELETE CASCADE,
  aktif         boolean NOT NULL DEFAULT true,
  mulai_pada    timestamptz NOT NULL DEFAULT now(),
  dibuat_oleh   bigint REFERENCES users(id) ON DELETE SET NULL,
  dicabut_pada  timestamptz,
  dicabut_oleh  bigint REFERENCES users(id) ON DELETE SET NULL,
  alasan_cabut  text,
  CONSTRAINT penugasan_cabut_cek CHECK (aktif = (dicabut_pada IS NULL)),
  CONSTRAINT penugasan_alasan_cek CHECK (aktif OR length(btrim(coalesce(alasan_cabut, ''))) >= 5)
);
CREATE UNIQUE INDEX IF NOT EXISTS penugasan_aktif_unik ON penugasan_penampung (id_user, id_meja) WHERE aktif;
CREATE INDEX IF NOT EXISTS penugasan_meja_idx ON penugasan_penampung (id_meja) WHERE aktif;

INSERT INTO konfigurasi_dosis (param, nilai, satuan, keterangan, sumber, diubah_pada) VALUES
  ('stabil_toleransi_ph', NULL, 'pH', 'Selisih maks–min pH dalam jendela stabil. NULL = belum diputuskan → konfirmasi tandon otomatis mati', 'Fase 3B.1 (terbuka)', now()),
  ('stabil_toleransi_tds_ppm', NULL, 'ppm', 'Selisih maks–min TDS dalam jendela stabil. NULL = belum diputuskan → konfirmasi tandon otomatis mati', 'Fase 3B.1 (terbuka)', now())
ON CONFLICT (param) DO NOTHING;

COMMIT;
