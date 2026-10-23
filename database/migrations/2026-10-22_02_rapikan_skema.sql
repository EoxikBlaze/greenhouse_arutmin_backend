-- ============================================================================
-- MIGRASI — Rapikan skema & siapkan untuk dikembangkan (skema V3, aditif)
-- Tanggal : 2026-10-22
-- Jalankan: npm run migrate   (atau psql "$DATABASE_URL" -f <file ini>)
-- Sifat   : AMAN & IDEMPOTEN. Tidak ada DROP TABLE / DROP COLUMN / hapus data.
--           Semua rute backend yang ada tetap jalan tanpa perubahan.
-- Isi     :
--   A. Skema `legacy` — tabel sisa Laravel yang tidak dipakai dipindah (tidak dihapus).
--   B. Katalog `perangkat` (ESP32 / kamera / modul) — dasar kunci per perangkat.
--   C. Katalog `jenis_alert` — 7 jenis alert dokumen FINAL + severity + LOCK + cooldown.
--   D. Fungsi `set_updated_at()` + trigger di tabel master & tahap tanam.
--   E. Indeks: buang duplikat, tambah indeks FK yang belum ada.
--   F. View berpenamaan rapi untuk endpoint/laporan baru.
--   G. Kamus data (COMMENT ON) + tandai kolom water_level sebagai usang.
-- ============================================================================

BEGIN;

-- ── A. legacy: tabel sisa Laravel (tidak dibaca backend Node) ────────────────
CREATE SCHEMA IF NOT EXISTS legacy;
COMMENT ON SCHEMA legacy IS 'Tabel sisa Laravel yang tidak dipakai backend Node. Disimpan, bukan dihapus.';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cache','cache_locks','failed_jobs','job_batches','jobs',
                           'migrations','password_reset_tokens','sessions']
  LOOP
    IF to_regclass('public.' || t) IS NOT NULL AND to_regclass('legacy.' || t) IS NULL THEN
      EXECUTE format('ALTER TABLE public.%I SET SCHEMA legacy', t);
    END IF;
  END LOOP;
END $$;

-- ── B. perangkat ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS perangkat (
    id                bigserial PRIMARY KEY,
    kode              varchar(32)  NOT NULL UNIQUE,          -- dipakai sbg device_id (mis. 'esp32-a')
    nama              varchar(100) NOT NULL,
    jenis             varchar(20)  NOT NULL DEFAULT 'ESP32'
                      CHECK (jenis IN ('ESP32', 'ESP32-CAM', 'KAMERA_IP', 'MODUL', 'LAINNYA')),
    id_meja           bigint REFERENCES mejas(id_meja) ON DELETE SET NULL,  -- NULL = melayani semua meja
    api_key_hash      varchar(128),                          -- SHA-256 hex kunci per perangkat (rencana)
    aktif             boolean      NOT NULL DEFAULT true,
    versi_firmware    varchar(32),
    terakhir_terlihat timestamp(0) without time zone,
    keterangan        text,
    created_at        timestamp(0) without time zone NOT NULL DEFAULT now(),
    updated_at        timestamp(0) without time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_perangkat_meja ON perangkat (id_meja);

-- Daftarkan semua device_id yang sudah muncul di bacaan + pengendali utama.
INSERT INTO perangkat (kode, nama, jenis, keterangan)
VALUES ('esp32-a', 'Pengendali utama (ESP32)', 'ESP32', 'Satu ESP32 merawat 4 penampung bergiliran (dokumen FINAL, Lampiran A).')
ON CONFLICT (kode) DO NOTHING;

DO $$
BEGIN
  IF to_regclass('public.sensor_readings') IS NOT NULL THEN
    INSERT INTO perangkat (kode, nama, jenis)
    SELECT DISTINCT r.device_id, 'Perangkat ' || r.device_id, 'ESP32'
    FROM sensor_readings r
    ON CONFLICT (kode) DO NOTHING;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sensor_readings_device_fk') THEN
      ALTER TABLE sensor_readings
        ADD CONSTRAINT sensor_readings_device_fk
        FOREIGN KEY (device_id) REFERENCES perangkat(kode) ON UPDATE CASCADE;
    END IF;
  END IF;
END $$;

-- ── C. jenis_alert ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS jenis_alert (
    kode             varchar(50)  PRIMARY KEY,               -- = alert_logs.type
    nama             varchar(100) NOT NULL,
    severity_default varchar(20)  NOT NULL DEFAULT 'warning'
                     CHECK (severity_default IN ('info', 'warning', 'critical')),
    memicu_lock      boolean      NOT NULL DEFAULT false,    -- Aturan 9: alert 3, 4, 6 → LOCK
    cooldown_detik   integer      NOT NULL DEFAULT 600 CHECK (cooldown_detik >= 0),
    aturan_dokumen   varchar(40),
    keterangan       text
);

INSERT INTO jenis_alert (kode, nama, severity_default, memicu_lock, cooldown_detik, aturan_dokumen, keterangan) VALUES
  ('di_luar_batas',   'EC/pH/suhu di luar batas aman',      'warning',  false, 600, 'Aturan 9 (1)', NULL),
  ('sensor',          'Sensor tidak merespons/tidak stabil', 'warning',  false, 600, 'Aturan 9 (2)', '3x invalid berturut-turut → LOCK (Bab 9)'),
  ('retry_habis',     'Retry dosing habis',                  'critical', true,  600, 'Aturan 9 (3)', 'EC 5x, pH 3x'),
  ('batas_dosis',     'Batas dosis/volume harian habis',     'critical', true,  600, 'Aturan 9 (4)', '8 kejadian atau 500 mL per hari'),
  ('timeout_isi_air', 'Timeout isi air',                     'critical', false, 600, 'Aturan 9 (5)', 'Float tidak naik dalam 15 menit'),
  ('ec_tinggi',       'EC tinggi meski level aman',          'critical', true,  600, 'Aturan 9 (6)', NULL),
  ('timeout_botol',   'Timeout isi botol sampel',            'warning',  false, 600, 'Aturan 9 (7)', '60 detik'),
  ('info_dini',       'Peringatan dini: 3 kejadian dosing',  'info',     false, 3600,'Aturan 9',     'Cek kebocoran talang, sensor, kebutuhan tanaman'),
  ('estop',           'E-STOP ditekan',                      'critical', false, 0,   'Aturan 12',    NULL),
  ('reset',           'Sistem direset petani',               'info',     false, 0,   'Aturan 12',    NULL),
  ('wifi',            'WiFi putus/tersambung',               'info',     false, 300, 'Aturan 14',    NULL),
  ('listrik',         'Sistem menyala setelah mati listrik', 'info',     false, 0,   'Aturan 10',    NULL),
  ('solenoid',        'Solenoid (kompatibilitas lama)',      'warning',  false, 60,  NULL,           'Tipe lama dari firmware CI4')
ON CONFLICT (kode) DO NOTHING;

-- ── D. updated_at otomatis ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DO $$
DECLARE t text;
BEGIN
  -- Hanya tabel master/tahap (tabel konfigurasi V2 sengaja tidak — uji net-zero PUT).
  FOREACH t IN ARRAY ARRAY['users','mejas','tanamen','sikluses','semais','peremajaans',
                           'pendewasaans','panens','cctv_kameras','perangkat']
  LOOP
    IF to_regclass('public.' || t) IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_' || t || '_updated_at') THEN
      EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I
                      FOR EACH ROW EXECUTE FUNCTION set_updated_at()', 'trg_' || t || '_updated_at', t);
    END IF;
  END LOOP;
END $$;

-- ── E. indeks ────────────────────────────────────────────────────────────────
-- Duplikat (audit performa 19 Okt): buang hanya bila pasangan penggantinya ada.
DO $$
BEGIN
  IF to_regclass('public.idx_monitorings_created') IS NOT NULL THEN
    DROP INDEX IF EXISTS public.monitorings_created_at_index;
  END IF;
  IF to_regclass('public.idx_alertlogs_created') IS NOT NULL THEN
    DROP INDEX IF EXISTS public.alert_logs_created_at_index;
  END IF;
  IF to_regclass('public.idx_alertlogs_type_value') IS NOT NULL THEN
    DROP INDEX IF EXISTS public.alert_logs_type_index;
  END IF;
END $$;

-- FK yang belum berindeks.
CREATE INDEX IF NOT EXISTS idx_tanamen_id_meja        ON tanamen (id_meja);
CREATE INDEX IF NOT EXISTS idx_sikluses_id_tanaman    ON sikluses (id_tanaman);
CREATE INDEX IF NOT EXISTS idx_semais_status          ON semais (status);
CREATE INDEX IF NOT EXISTS idx_alertlogs_terbuka      ON alert_logs (created_at DESC) WHERE acknowledged = false;

-- ── F. view rapi ─────────────────────────────────────────────────────────────
-- Bacaan terbaru per meja (sumber aktif: monitorings; nanti diganti sensor_readings_latest).
CREATE OR REPLACE VIEW v_bacaan_terbaru AS
SELECT DISTINCT ON (m.id_meja)
       m.id_meja, m.ph, m.tds AS tds_ppm, m.ec_ms_cm,
       m."waterTemp" AS suhu_air_c, m."airTemp" AS suhu_udara_c, m.humidity AS kelembapan_pct,
       m.created_at AS dibaca_pada
FROM monitorings m
WHERE m.id_meja IS NOT NULL
ORDER BY m.id_meja, m.created_at DESC;

-- Alert yang belum dibaca, lengkap dengan nama jenis & meja.
CREATE OR REPLACE VIEW v_alert_terbuka AS
SELECT a.id, a.type AS kode_jenis, coalesce(j.nama, a.type) AS jenis,
       a.severity, a.locked, a.value AS pesan, a.id_meja, mj.meja, a.created_at
FROM alert_logs a
LEFT JOIN jenis_alert j ON j.kode = a.type
LEFT JOIN mejas mj      ON mj.id_meja = a.id_meja
WHERE a.acknowledged = false;

-- Ringkasan status tiap meja/penampung — satu baris per meja.
CREATE OR REPLACE VIEW v_status_penampung AS
SELECT mj.id_meja, mj.meja, mj.jenis_talang, mj.kapasitas_penampung_l,
       coalesce(ps.status_lock, false)       AS status_lock,
       ps.lock_alasan,
       coalesce(ps.mode_pemeliharaan, false) AS mode_pemeliharaan,
       coalesce(ps.kejadian_dosis_hari, 0)   AS kejadian_dosis_hari,
       coalesce(ps.volume_ab_hari_ml, 0)     AS volume_ab_hari_ml,
       ps.target_ec_ppm, ps.target_ph,
       b.ph, b.tds_ppm, b.suhu_air_c, b.dibaca_pada,
       (SELECT count(*) FROM alert_logs a WHERE a.id_meja = mj.id_meja AND a.acknowledged = false) AS alert_terbuka
FROM mejas mj
LEFT JOIN penampung_states ps ON ps.id_meja = mj.id_meja
LEFT JOIN v_bacaan_terbaru b  ON b.id_meja = mj.id_meja
WHERE mj.expires_at IS NULL;

-- Satu baris per batch tanam yang masih berjalan (semai → pendewasaan).
CREATE OR REPLACE VIEW v_tanam_berjalan AS
SELECT 'semai'::text AS tahap, s.id_semai AS id, t.nama_tanaman, m.meja,
       s.tgl_awal_semai AS mulai, s.tgl_akhir_semai AS rencana_selesai, s.jumlah_benih AS jumlah
FROM semais s
LEFT JOIN tanamen t ON t.id_tanaman = s.id_tanaman
LEFT JOIN mejas m   ON m.id_meja = s.id_meja
WHERE s.status = 'proses'
UNION ALL
SELECT 'peremajaan', p.id_peremajaan, t.nama_tanaman, m.meja,
       p.tgl_awal_peremajaan, p.tgl_akhir_peremajaan, p.jumlah_masuk
FROM peremajaans p
LEFT JOIN semais s  ON s.id_semai = p.id_semai
LEFT JOIN tanamen t ON t.id_tanaman = s.id_tanaman
LEFT JOIN mejas m   ON m.id_meja = p.id_meja
WHERE p.tgl_akhir_peremajaan >= current_date
UNION ALL
SELECT 'pendewasaan', d.id_pendewasaan, t.nama_tanaman, m.meja,
       d.tgl_awal_pendewasaan, d.tgl_akhir_pendewasaan, d.jumlah_masuk
FROM pendewasaans d
LEFT JOIN peremajaans p ON p.id_peremajaan = d.id_peremajaan
LEFT JOIN semais s      ON s.id_semai = p.id_semai
LEFT JOIN tanamen t     ON t.id_tanaman = s.id_tanaman
LEFT JOIN mejas m       ON m.id_meja = d.id_meja
WHERE d.tgl_akhir_pendewasaan >= current_date;

-- ── G. kamus data ────────────────────────────────────────────────────────────
COMMENT ON TABLE users            IS 'Akun aplikasi. level: admin | petani | user; is_demo = akun demo baca-saja.';
COMMENT ON TABLE mejas            IS 'Meja hidroponik + penampungnya (dokumen FINAL Tabel 1: 3 NFT + 1 DFT).';
COMMENT ON TABLE tanamen          IS 'Jenis tanaman (nama tabel warisan Laravel = "tanaman").';
COMMENT ON TABLE sikluses         IS 'Durasi tiap tahap per jenis tanaman, dalam hari (warisan Laravel = "siklus").';
COMMENT ON TABLE semais           IS 'Batch semai. status: proses | selesai | gagal.';
COMMENT ON TABLE peremajaans      IS 'Tahap peremajaan dari satu batch semai.';
COMMENT ON TABLE pendewasaans     IS 'Tahap pendewasaan dari satu peremajaan.';
COMMENT ON TABLE panens           IS 'Catatan panen dari satu pendewasaan.';
COMMENT ON TABLE monitorings      IS 'Bacaan sensor AKTIF yang dibaca backend saat ini. Rencana: digantikan sensor_readings (partisi bulanan).';
COMMENT ON TABLE alert_logs       IS 'Riwayat alert. type merujuk jenis_alert.kode (tanpa FK agar tipe lama tetap diterima).';
COMMENT ON TABLE water_controls   IS 'Satu baris status katup pengisian: mode AUTO/MANUAL, command, valve_state.';
COMMENT ON TABLE penampung_states IS 'State runtime per penampung: LOCK, mode pemeliharaan, counter dosis harian, target.';
COMMENT ON TABLE perangkat        IS 'Katalog perangkat keras (ESP32, kamera). kode = device_id di bacaan sensor.';
COMMENT ON TABLE jenis_alert      IS 'Katalog jenis alert dokumen FINAL Aturan 9/10/12/14: severity, LOCK, cooldown.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'monitorings' AND column_name = 'water_level') THEN
    EXECUTE 'COMMENT ON COLUMN monitorings.water_level IS ''USANG sejak 2026-10-22 — rancangan FINAL hanya memakai float switch. Tidak ditulis/dibaca backend.''';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sensor_readings' AND column_name = 'water_level') THEN
    EXECUTE 'COMMENT ON COLUMN sensor_readings.water_level IS ''USANG sejak 2026-10-22 — tidak dipakai.''';
  END IF;
END $$;

COMMIT;
