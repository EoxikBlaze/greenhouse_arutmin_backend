-- MIGRASI — daftar kamera CCTV (papan kamera halaman /cctv)
-- Tanggal : 2026-10-22
-- Jalankan: psql "$DATABASE_URL" -f database/migrations/2026-10-22_01_cctv_kamera.sql
-- Idempoten. Rute /cctv juga membuat tabel ini otomatis bila belum ada.
CREATE TABLE IF NOT EXISTS cctv_kameras (
    id bigserial PRIMARY KEY,
    nama varchar(100) NOT NULL,
    lokasi varchar(100),
    tipe varchar(10) NOT NULL DEFAULT 'snapshot' CHECK (tipe IN ('mjpeg', 'snapshot')),
    url text NOT NULL,
    interval_detik integer NOT NULL DEFAULT 5 CHECK (interval_detik BETWEEN 1 AND 60),
    aktif boolean NOT NULL DEFAULT true,
    created_at timestamp(0) without time zone DEFAULT now() NOT NULL,
    updated_at timestamp(0) without time zone
);
