-- Foto profil per akun. Tabel terpisah agar `SELECT * FROM users` tidak ikut
-- menarik byte gambar. Idempoten: aman dijalankan ulang.
CREATE TABLE IF NOT EXISTS user_foto (
  user_id bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tipe text NOT NULL CHECK (tipe IN ('image/png', 'image/jpeg', 'image/webp')),
  data bytea NOT NULL CHECK (octet_length(data) > 0 AND octet_length(data) <= 524288),
  diperbarui_pada timestamptz NOT NULL DEFAULT now()
);
