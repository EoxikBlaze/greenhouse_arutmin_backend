-- MIGRASI — riwayat transisi siklus dosing + idempotensi (Fase 3C, DESAIN_FASE2 §3.B / §4.4)
-- Tanggal : 2026-10-29
-- Sifat   : ADITIF. Tabel baru (append-only oleh kode, seperti siklus_transisi); tabel/baris lama tidak diubah.
-- Rollback: DROP TABLE dosing_transisi; (tidak ada data lama yang bergantung padanya)
BEGIN;

CREATE TABLE IF NOT EXISTS dosing_transisi (
  id              bigserial PRIMARY KEY,
  id_kejadian     bigint NOT NULL REFERENCES dosing_events(id) ON DELETE RESTRICT,
  dari            varchar(20),
  ke              varchar(20) NOT NULL,
  aktor_tipe      varchar(10) NOT NULL CHECK (aktor_tipe IN ('user', 'system')),
  aktor_user_id   bigint REFERENCES users(id) ON DELETE SET NULL,
  alasan          text,
  data            jsonb,
  idempotency_key uuid,
  permintaan_hash char(64),
  terjadi_pada    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dosing_transisi_aktor_cek CHECK (aktor_tipe = 'system' OR aktor_user_id IS NOT NULL),
  CONSTRAINT dosing_transisi_idem_cek CHECK ((idempotency_key IS NULL) = (permintaan_hash IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS dosing_transisi_idem_unik ON dosing_transisi (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS dosing_transisi_kejadian_idx ON dosing_transisi (id_kejadian, terjadi_pada);

COMMIT;
