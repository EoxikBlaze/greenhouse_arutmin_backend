-- MIGRASI — user yang pernah login bisa dihapus tanpa menghapus jejak audit
-- Tanggal : 2026-10-23
-- Masalah : audit_logs.actor_user_id → users(id) ON DELETE SET NULL, tetapi CHECK audit_logs_user_check
--           melarang actor_user_id NULL untuk actor_tipe 'user'. Setiap login tercatat di audit, jadi
--           DELETE user yang PERNAH login selalu gagal (API: 422 "Kolom user tidak memenuhi aturan data").
-- Solusi  : baris audit user yang sudah dihapus boleh actor_user_id NULL selama actor_label (username)
--           tetap ada — riwayat tetap terbaca, tidak ada baris audit yang dihapus.
-- Idempoten.
ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_user_check;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_user_check
  CHECK (actor_tipe <> 'user' OR actor_user_id IS NOT NULL OR actor_label IS NOT NULL);
