-- 15 Nov 2026 — Analisis AI harian (07.00 WIB). Satu laporan per tanggal; isi = keluaran deterministik
-- src/aiAnalisisHarian.js (hanya baca data). Tabel ini hanya ditulis oleh src/analisisHarianRepo.js.
-- Sifat: ADITIF, tidak menyentuh tabel lain.
BEGIN;

CREATE TABLE IF NOT EXISTS ai_analisis_harian (
  id              bigserial PRIMARY KEY,
  tanggal         date NOT NULL UNIQUE,
  pemicu          varchar(10) NOT NULL CHECK (pemicu IN ('jadwal', 'manual')),
  dijalankan_oleh bigint REFERENCES users(id) ON DELETE SET NULL,
  isi             jsonb NOT NULL CHECK (jsonb_typeof(isi) = 'object'),
  dibuat_pada     timestamptz NOT NULL DEFAULT now(),
  diperbarui_pada timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE ai_analisis_harian IS 'Laporan analisis AI harian (rekomendasi, tidak pernah menjalankan alat). tanggal = tanggal WIB.';

COMMIT;
