-- ============================================================================
-- Bersihkan data pengembangan dari database yang BARU diimpor dari vertonik.sql
-- Dijalankan otomatis oleh deploy-pi/pasang-server.sh HANYA pada instalasi baru
-- (database kosong → impor dump → migrasi → skrip ini).
--
-- Dihapus : alert uji, bacaan sensor lama, sesi & cache lama, pengaturan WhatsApp (fitur sudah dihapus)
-- Direset : water_controls → AUTO / AUTO / katup OFF
-- TETAP   : meja, tanaman, siklus, tahap tanam, ambang, konfigurasi dosis/timing/fail-safe, akun
--
-- PENGAMAN: menolak jalan bila sudah ada bacaan sensor setelah dump dibuat (2026-10-22) —
-- artinya database ini sudah dipakai sungguhan dan datanya tidak boleh dihapus.
-- Jalankan manual: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/bersihkan_instalasi_baru.sql
-- ============================================================================
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM monitorings WHERE created_at >= '2026-10-22') THEN
    RAISE EXCEPTION 'Database ini sudah berisi bacaan sensor sesudah 2026-10-22 — bukan instalasi baru. Pembersihan DIBATALKAN, tidak ada yang dihapus.';
  END IF;
END $$;

DELETE FROM alert_logs;      -- dump hanya berisi 51 alert uji (tipe 'uji' & 'ON (uji node)')
DELETE FROM monitorings;     -- bacaan pengembangan 15–21 Okt 2026
DELETE FROM wa_settings;     -- token WhatsApp terenkripsi + nomor; fitur sudah dihapus
UPDATE water_controls SET command = 'AUTO', mode = 'AUTO', valve_state = 'OFF', updated_at = now();

-- sesi & cache Laravel: di `public` sebelum migrasi 2026-10-22_02, di `legacy` sesudahnya
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.sessions', 'legacy.sessions', 'public.cache', 'legacy.cache',
                           'public.cache_locks', 'legacy.cache_locks']
  LOOP
    IF to_regclass(t) IS NOT NULL THEN EXECUTE format('DELETE FROM %s', t); END IF;
  END LOOP;
END $$;

COMMIT;
