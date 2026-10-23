-- Hapus SEMUA data palsu dari seed_fake.sql (data asli tidak disentuh).
-- Jalankan: psql "$DATABASE_URL" -f database/hapus_fake.sql
BEGIN;
DELETE FROM cctv_kameras WHERE nama LIKE 'DEMO %';
DELETE FROM alert_logs WHERE value LIKE '[FAKE]%';
DELETE FROM monitorings WHERE id_meja IN (SELECT id_meja FROM mejas WHERE meja LIKE 'DEMO Meja%');
DELETE FROM panens WHERE keterangan LIKE 'FAKE-DEBUG%';
DELETE FROM pendewasaans WHERE keterangan LIKE 'FAKE-DEBUG%';
DELETE FROM peremajaans WHERE keterangan LIKE 'FAKE-DEBUG%';
DELETE FROM semais WHERE keterangan LIKE 'FAKE-DEBUG%';
DELETE FROM penampung_states WHERE id_meja IN (SELECT id_meja FROM mejas WHERE meja LIKE 'DEMO Meja%');
DELETE FROM sikluses WHERE id_tanaman IN (SELECT id_tanaman FROM tanamen WHERE nama_tanaman LIKE 'DEMO %');
DELETE FROM tanamen WHERE nama_tanaman LIKE 'DEMO %';
DELETE FROM mejas WHERE meja LIKE 'DEMO Meja%';
COMMIT;
