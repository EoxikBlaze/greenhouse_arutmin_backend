-- ============================================================================
-- SEED DATA — GARAP (PostgreSQL 17)
-- Pakai   : psql "$DATABASE_URL" -f database/seed.sql
-- Aman diulang: ON CONFLICT DO NOTHING — tidak menimpa data yang sudah ada.
-- ============================================================================

BEGIN;

-- 1. AKUN — admin · petani · demo (password di-hash bcrypt cost 12, format $2y$)
--    Jangan pernah menaruh kata sandi mentah di file ini.
--    admin  -> level admin | petani -> level petani | demo -> is_demo=true
INSERT INTO users (id, username, email, password, level, is_demo, created_at, updated_at) VALUES
    (1, 'admin', 'admin@politala.ac.id', '$2y$12$iw2XEuLEcvsussbCTJgm9u8XDYOWRgwM3xx7zpKjnUod1X7oSVya.', 'admin', FALSE, now(), now()),
    (2, 'demo', 'demo@vertonik.local', '$2y$12$EzhiHCvLimRt1k.I4K5cd.p6OPhNaCJ1elQUWQjxAuSILsVvbO7xa', 'user', TRUE, now(), now()),
    (3, 'petani', 'petani@vertonik.local', '$2y$12$VWM1BJh5vmne7rsbmt1ZgudwVvntdalEb.oSspKsuFTUb3wUoyhlu', 'petani', FALSE, now(), now())
ON CONFLICT (id) DO NOTHING;

-- 2. AMBANG SENSOR — dipakai ESP32 (GET /api/get-thresholds)
INSERT INTO sensor_thresholds (id, sensor, min, max, updated_at) VALUES
    (1, 'waterTemp',   5,   40, now()),
    (2, 'ph',          5,    7, now()),
    (3, 'tds',        50, 1000, now()),
    (4, 'airTemp',    20,   40, now()),
    (5, 'humidity',   50,   90, now())
ON CONFLICT (id) DO NOTHING;

-- 3. STATE KATUP — 1 baris dominan (GET /watercontrol/status)
INSERT INTO water_controls (id, command, mode, valve_state, updated_at) VALUES
    (1, 'AUTO', 'MANUAL', 'OFF', now())
ON CONFLICT (id) DO NOTHING;

-- 4. PENGATURAN WHATSAPP — api_key DIISI LEWAT APLIKASI, bukan lewat SQL,
--    karena nilainya di-enskripsi dengan APP_KEY mesin masing-masing.
INSERT INTO wa_settings (id, aktif, api_key, target, created_at, updated_at) VALUES
    (1, FALSE, NULL, '', now(), now())
ON CONFLICT (id) DO NOTHING;

-- 5. WAJIB: samakan sequence dengan max(id) — mencegah semua INSERT balas 500
--    (penyebab bug yang sudah kita temukan; script ini juga ada di scripts/fix-sequences.sql)
DO $$
DECLARE r record; mx bigint;
BEGIN
  FOR r IN SELECT table_name, column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND column_default LIKE 'nextval(%'
  LOOP
    EXECUTE format('SELECT max(%I) FROM %I', r.column_name, r.table_name) INTO mx;
    IF mx IS NOT NULL THEN
      PERFORM setval(pg_get_serial_sequence(r.table_name, r.column_name), mx);
    END IF;
  END LOOP;
END $$;

COMMIT;
