-- MIGRASI — pemetaan penampung ↔ katup perangkat untuk Water Control (Fase 3B.3)
-- Tanggal : 2026-10-29
-- Sifat   : ADITIF. Tabel dibuat KOSONG: pemetaan fisik penampung melon (dan lainnya) belum dipastikan
--           (firmware v0.2: katup {1→GPIO18, 2→GPIO19, 3→GPIO21} tidak cocok dengan id_meja DB maupun tabel
--           mapping_channel_esp32). Tanpa baris aktif, layanan kontrol air menolak semua perintah.
BEGIN;

CREATE TABLE IF NOT EXISTS pemetaan_katup (
  id             bigserial PRIMARY KEY,
  id_meja        bigint NOT NULL REFERENCES mejas(id_meja) ON DELETE RESTRICT,
  perangkat_kode varchar(64) NOT NULL REFERENCES perangkat(kode) ON DELETE RESTRICT,
  nomor_katup    integer NOT NULL CHECK (nomor_katup >= 1),
  aktif          boolean NOT NULL DEFAULT true,
  bukti          text NOT NULL CHECK (length(btrim(bukti)) >= 10),   -- foto/uji kabel/berita acara
  dibuat_oleh    bigint REFERENCES users(id) ON DELETE SET NULL,
  dibuat_pada    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS pemetaan_katup_meja_aktif_unik ON pemetaan_katup (id_meja) WHERE aktif;
CREATE UNIQUE INDEX IF NOT EXISTS pemetaan_katup_katup_aktif_unik ON pemetaan_katup (perangkat_kode, nomor_katup) WHERE aktif;

COMMIT;
