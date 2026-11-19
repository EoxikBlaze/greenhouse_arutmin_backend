-- 19 Nov 2026 — Riwayat kejadian dosing untuk grafik "Nutrisi: target vs aktual" (menu Sensor).
-- Alat hanya melaporkan HITUNGAN harian (dosing_ab_hari, dosing_ph_hari, encer_hari, isi_hari, Kontrak MQTT v2.0 §3.2);
-- server mencatat satu baris tiap hitungan naik, sehingga tahu KAPAN alat menyuntik (jumlah mL tidak dilaporkan alat).
-- Hanya CREATE TABLE/INDEX; aman diulang.
CREATE TABLE IF NOT EXISTS dosing_kejadian (
  id             bigserial PRIMARY KEY,
  perangkat_kode varchar(32) NOT NULL,
  id_meja        bigint,
  jenis          varchar(10) NOT NULL CHECK (jenis IN ('AB', 'PH', 'ENCER', 'ISI')),
  total_hari     integer NOT NULL,
  terjadi_pada   timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE dosing_kejadian IS 'AB = nutrisi A+B, PH = koreksi pH, ENCER = pengenceran, ISI = isi air; total_hari = hitungan alat hari itu setelah kejadian';
CREATE INDEX IF NOT EXISTS dosing_kejadian_waktu ON dosing_kejadian (terjadi_pada DESC);
CREATE INDEX IF NOT EXISTS dosing_kejadian_meja ON dosing_kejadian (id_meja, terjadi_pada DESC);
