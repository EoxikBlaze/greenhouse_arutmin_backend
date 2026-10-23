-- MIGRASI — kamera CCTV tipe 'rtsp' (EZVIZ H8C & kamera IP biasa, frame diambil server lewat ffmpeg)
-- Tanggal : 2026-10-23
-- Jalankan: npm run migrate
-- Idempoten: constraint lama ('mjpeg','snapshot') diganti dengan yang menerima 'rtsp'.
ALTER TABLE cctv_kameras DROP CONSTRAINT IF EXISTS cctv_kameras_tipe_check;
ALTER TABLE cctv_kameras ADD CONSTRAINT cctv_kameras_tipe_check CHECK (tipe IN ('mjpeg', 'snapshot', 'rtsp'));
COMMENT ON COLUMN cctv_kameras.url IS 'http(s):// untuk mjpeg/snapshot (browser menarik langsung); rtsp(s):// untuk rtsp — berisi sandi kamera, tidak pernah dikirim utuh ke browser';
