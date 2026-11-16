-- 16 Nov 2026 — Status keselamatan & level tandon dari ESP32 gabungan-0.7.
-- Dulu pelampung (float) dan asal E-STOP dibuang di server: level tandon tidak pernah tersimpan dan
-- E-STOP fisik tak bisa dibedakan dari E-STOP server. Kolom NULL = alat belum pernah melaporkannya (bukan "aman").
ALTER TABLE perangkat ADD COLUMN IF NOT EXISTS float_bawah_rendah boolean;
ALTER TABLE perangkat ADD COLUMN IF NOT EXISTS float_atas_penuh boolean;
ALTER TABLE perangkat ADD COLUMN IF NOT EXISTS level_diperbarui_pada timestamptz;
ALTER TABLE perangkat ADD COLUMN IF NOT EXISTS estop_fisik boolean;
ALTER TABLE perangkat ADD COLUMN IF NOT EXISTS estop_diperbarui_pada timestamptz;
ALTER TABLE perangkat ADD COLUMN IF NOT EXISTS reset_terakhir_pada timestamptz;

COMMENT ON COLUMN perangkat.float_bawah_rendah IS 'Pelampung bawah turun (air kurang) menurut laporan alat terakhir; NULL = belum pernah dilaporkan';
COMMENT ON COLUMN perangkat.float_atas_penuh IS 'Pelampung atas terangkat (tandon penuh) menurut laporan alat terakhir; NULL = belum pernah dilaporkan';
COMMENT ON COLUMN perangkat.estop_fisik IS 'Tombol E-STOP fisik (GPIO36) sedang/masih mengunci menurut alat; NULL = firmware lama tidak melaporkan';
COMMENT ON COLUMN perangkat.reset_terakhir_pada IS 'Waktu server menerima laporan tombol RESET fisik (GPIO19) ditekan';
