-- ============================================================================
-- MIGRASI — konfigurasi fisik meja/penampung + state per penampung + kolom
--            monitorings/alert_logs/sensor_thresholds
-- Tanggal : 2026-10-19
-- Sumber  : Perancangan_Sistem_IoT_Hidroponik_FINAL.docx
--           seksi 1.2 (konfigurasi meja & penampung), Tabel 1 (data meja),
--           seksi 1.1 (setpoint/counter/LOCK per penampung),
--           seksi 2.2 par.48 (operasional pakai EC mS/cm),
--           seksi 4.1 par.60 + seksi 9 par.209 (sanity check sensor),
--           seksi 5 Aturan 9 par.151-152 (jenis alert + LOCK + INFO dini),
--           seksi 5 Aturan 13 par.168-172 (mode pemeliharaan dari aplikasi),
--           seksi 9 par.197-210 (fail-safe), seksi 2.3/Tabel 13 (deadband).
-- Jalankan: psql "$DATABASE_URL" -f database/migrations/2026-10-19_perancangan_meja_state.sql
-- Idempoten: ADD COLUMN IF NOT EXISTS, CREATE TABLE/INDEX IF NOT EXISTS,
--            DROP CONSTRAINT IF EXISTS + ADD, UPDATE dijaga kondisi IS NULL
--            (tidak menimpa nilai yang sudah diedit lewat aplikasi).
-- Forward-only: tidak ada DROP kolom/tabel, tidak merusak data lama
--            (kolom baru NULL untuk 12 baris monitorings & 51 baris alert_logs).
-- Catatan  : TIDAK mengubah nilai min/max sensor_thresholds (batas aman EC masih
--            "MENUNGGU riset petani + tim web" — Lampiran B par.251 → keputusan user).
-- ============================================================================

BEGIN;

-- ── A. mejas — kolom konfigurasi fisik (seksi 1.2 + Tabel 1) ────────────────
-- Tabel 1: Meja 1/2/3 NFT penampung ±70 L, Meja 4 DFT 75 L;
--          talang 12/8/10/10, lubang per talang 26/26/52/18,
--          panjang talang 8,1 m (Meja 4: 4 m), laju 1 L/menit per talang
--          (Meja 4 "…diisi sendiri" → NULL, seksi 1.2 par.17).
ALTER TABLE mejas ADD COLUMN IF NOT EXISTS jenis_talang varchar(20);
ALTER TABLE mejas ADD COLUMN IF NOT EXISTS kapasitas_penampung_l numeric(6,2);
ALTER TABLE mejas ADD COLUMN IF NOT EXISTS jumlah_talang integer;
ALTER TABLE mejas ADD COLUMN IF NOT EXISTS lubang_per_talang integer;
ALTER TABLE mejas ADD COLUMN IF NOT EXISTS panjang_talang_m numeric(4,2);
ALTER TABLE mejas ADD COLUMN IF NOT EXISTS laju_per_talang_lpm numeric(5,2);
ALTER TABLE mejas ADD COLUMN IF NOT EXISTS kenaikan_air_cm integer DEFAULT 40;

COMMENT ON COLUMN mejas.jenis_talang       IS 'Perancangan FINAL seksi 1.2: NFT (Meja 1-3) / DFT (Meja 4)';
COMMENT ON COLUMN mejas.kapasitas_penampung_l IS 'Perancangan FINAL Tabel 1: 70 L (Meja 1-3), 75 L (Meja 4)';
COMMENT ON COLUMN mejas.jumlah_talang      IS 'Perancangan FINAL Tabel 1: 12/8/10/10 talang';
COMMENT ON COLUMN mejas.lubang_per_talang  IS 'Perancangan FINAL Tabel 1: 26/26/52/18 lubang per talang';
COMMENT ON COLUMN mejas.panjang_talang_m   IS 'Perancangan FINAL Tabel 1: 8,1 m (Meja 4: 4 m)';
COMMENT ON COLUMN mejas.laju_per_talang_lpm IS 'Perancangan FINAL Tabel 1: 1 L/menit per talang; Meja 4 diisi pengguna (NULL)';
COMMENT ON COLUMN mejas.kenaikan_air_cm    IS 'Perancangan FINAL Tabel 1: kenaikan penampung -> meja = 40 cm';

ALTER TABLE mejas DROP CONSTRAINT IF EXISTS mejas_jenis_talang_check;
ALTER TABLE mejas
  ADD CONSTRAINT mejas_jenis_talang_check
  CHECK (jenis_talang IS NULL OR jenis_talang IN ('NFT', 'DFT'));

ALTER TABLE mejas DROP CONSTRAINT IF EXISTS mejas_kapasitas_penampung_l_check;
ALTER TABLE mejas
  ADD CONSTRAINT mejas_kapasitas_penampung_l_check
  CHECK (kapasitas_penampung_l IS NULL OR kapasitas_penampung_l > 0);

-- ── B. penampung_states — state runtime per penampung/meja ─────────────────
-- Alasan (seksi 1.1 par.14): "penampung terpisah ±70 liter per meja dengan
-- setpoint, counter dosis, dan status LOCK sendiri". Saat ini tidak ada tabel
-- yang menyimpan LOCK, counter harian, maupun mode pemeliharaan — padahal
-- Aturan 13 par.168 menyebut mode pemeliharaan "Diaktifkan dari aplikasi/
-- website" dan Aturan 9 par.152 reset LOCK "hanya oleh petani" (via aplikasi).
-- Kolom counter di-reset 00:00 (Aturan 11 par.159), LOCK TIDAK ikut direset.
CREATE TABLE IF NOT EXISTS penampung_states (
    id_meja              bigint NOT NULL,
    status_lock          boolean DEFAULT false NOT NULL,
    lock_alasan          varchar(100),
    lock_sejak           timestamp without time zone,
    mode_pemeliharaan    boolean DEFAULT false NOT NULL,
    kejadian_dosis_hari  integer DEFAULT 0 NOT NULL,
    volume_ab_hari_ml    numeric(8,2) DEFAULT 0 NOT NULL,
    volume_ph_hari_ml    numeric(8,2) DEFAULT 0 NOT NULL,
    target_ec_ppm        numeric(8,2),
    target_ph            numeric(4,2),
    reset_harian_pada    timestamp without time zone,
    updated_at           timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT penampung_states_pkey PRIMARY KEY (id_meja),
    CONSTRAINT penampung_states_id_meja_foreign
        FOREIGN KEY (id_meja) REFERENCES mejas (id_meja) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_penampung_states_lock
    ON penampung_states (status_lock) WHERE status_lock;

COMMENT ON TABLE penampung_states IS
    'State per penampung (1 baris per meja): LOCK, counter harian, mode pemeliharaan, setpoint aktif — Perancangan FINAL seksi 1.1, Aturan 9/11/13';
COMMENT ON COLUMN penampung_states.kejadian_dosis_hari IS
    'Perancangan FINAL seksi 1.6: maks 8 kejadian dosing/hari, reset 00:00';
COMMENT ON COLUMN penampung_states.volume_ab_hari_ml IS
    'Perancangan FINAL seksi 1.6/Tabel 13: maks 500 mL AB mix/hari (semua suntikan termasuk retry)';
COMMENT ON COLUMN penampung_states.mode_pemeliharaan IS
    'Perancangan FINAL Aturan 13: sampling & dosing dijeda, jatah dibekukan, isi air tetap jalan';

-- Isi baris untuk meja yang sudah ada (idempoten; meja baru menyusul di-upsert
-- oleh aplikasi saat CREATE meja — lihat butir API di laporan).
INSERT INTO penampung_states (id_meja)
SELECT m.id_meja FROM mejas m
ON CONFLICT (id_meja) DO NOTHING;

-- ── C. monitorings —EC asli + penampung asal bacaan ────────────────────────
-- seksi 2.2 par.48: "pembacaan operasional HARUS memakai sensor EC langsung
-- (mS/cm), ppm hanya untuk uji manual" — kolom tds (ppm) saja tidak cukup.
-- seksi 1.4/4.1: sistem membaca 4 penampung bergiliran → bacaan harus
-- menyebut penampung/meja asal (kolom id_meja; NULL untuk data lama).
ALTER TABLE monitorings ADD COLUMN IF NOT EXISTS id_meja bigint
    REFERENCES mejas (id_meja) ON DELETE SET NULL;
ALTER TABLE monitorings ADD COLUMN IF NOT EXISTS ec_ms_cm double precision;

CREATE INDEX IF NOT EXISTS idx_monitorings_id_meja_created
    ON monitorings (id_meja, created_at DESC);

COMMENT ON COLUMN monitorings.id_meja   IS 'Penampung/meja asal bacaan (Perancangan FINAL seksi 1.4 — sampling bergiliran 1->4); NULL = data lama';
COMMENT ON COLUMN monitorings.ec_ms_cm  IS 'EC sensor langsung mS/cm — Perancangan FINAL seksi 2.2 par.48 (ppm = EC x 500)';

-- ── D. alert_logs — penampung, tingkat, LOCK, pengakuan ────────────────────
-- Aturan 9 par.151: 7 pemicu alert; par.152: LOCK otomatis untuk alert
-- (3) retry habis, (4) jatah habis, (6) EC tinggi + level aman; reset oleh petani.
ALTER TABLE alert_logs ADD COLUMN IF NOT EXISTS id_meja bigint
    REFERENCES mejas (id_meja) ON DELETE SET NULL;
ALTER TABLE alert_logs ADD COLUMN IF NOT EXISTS severity varchar(20) DEFAULT 'info' NOT NULL;
ALTER TABLE alert_logs ADD COLUMN IF NOT EXISTS locked boolean DEFAULT false NOT NULL;
ALTER TABLE alert_logs ADD COLUMN IF NOT EXISTS acknowledged boolean DEFAULT false NOT NULL;
ALTER TABLE alert_logs ADD COLUMN IF NOT EXISTS acknowledged_at timestamp without time zone;

ALTER TABLE alert_logs DROP CONSTRAINT IF EXISTS alert_logs_severity_check;
ALTER TABLE alert_logs
    ADD CONSTRAINT alert_logs_severity_check
    CHECK (severity IN ('info', 'warning', 'critical'));

CREATE INDEX IF NOT EXISTS idx_alertlogs_meja_created
    ON alert_logs (id_meja, created_at DESC);

COMMENT ON COLUMN alert_logs.severity IS 'info | warning | critical — Perancangan FINAL Aturan 9 (INFO dini vs ALERT vs LOCK)';
COMMENT ON COLUMN alert_logs.locked    IS 'TRUE bila alert memicu LOCK dosing penampung (Aturan 9 par.152: alert 3, 4, 6)';
COMMENT ON COLUMN alert_logs.acknowledged IS 'Ditandai dibaca petani (reset LOCK dilakukan petani — Aturan 9 par.152)';

-- ── E. sensor_thresholds — deadband + rentang sanity (min/max TIDAK diubah) ─
-- Tabel 13: Deadband EC ±100 ppm (±0,1 mS/cm) ; pH ±0,2
-- seksi 4.1 par.60 / seksi 9 par.209 sanity: EC 0,1–5 mS/cm (=50–2500 ppm,
-- konversi par.38 "ppm = EC × 500"), pH 3–9, suhu air 5–45 °C.
ALTER TABLE sensor_thresholds ADD COLUMN IF NOT EXISTS satuan varchar(20);
ALTER TABLE sensor_thresholds ADD COLUMN IF NOT EXISTS deadband double precision;
ALTER TABLE sensor_thresholds ADD COLUMN IF NOT EXISTS sanity_min double precision;
ALTER TABLE sensor_thresholds ADD COLUMN IF NOT EXISTS sanity_max double precision;
ALTER TABLE sensor_thresholds ADD COLUMN IF NOT EXISTS keterangan text;

COMMENT ON COLUMN sensor_thresholds.deadband   IS 'Lebar pita mati — Perancangan FINAL Tabel 13 (EC ±100 ppm, pH ±0,2)';
COMMENT ON COLUMN sensor_thresholds.sanity_min IS 'Batas bacaan mustahil (dibuang) — Perancangan FINAL seksi 4.1 par.60 / seksi 9 par.209';
COMMENT ON COLUMN sensor_thresholds.sanity_max IS 'Batas bacaan mustahil (dibuang) — Perancangan FINAL seksi 4.1 par.60 / seksi 9 par.209';

UPDATE sensor_thresholds SET
    satuan = 'ppm', deadband = 100, sanity_min = 50, sanity_max = 2500,
    keterangan = 'Batas aman default 400-1.250 ppm MENUNGGU riset petani+tim web (Lampiran B par.251); sanity 50-2500 ppm = EC 0,1-5 mS/cm x 500'
WHERE sensor = 'tds' AND deadband IS NULL;

UPDATE sensor_thresholds SET
    satuan = 'pH', deadband = 0.2, sanity_min = 3, sanity_max = 9,
    keterangan = 'Batas aman pH 5,0-7,0 (Tabel 13); sanity pH 3-9 (seksi 9 par.209)'
WHERE sensor = 'ph' AND deadband IS NULL;

UPDATE sensor_thresholds SET
    satuan = 'C', sanity_min = 5, sanity_max = 45,
    keterangan = 'Batas aman suhu air 18-30 C (Tabel 13); sanity 5-45 C (seksi 9 par.209)'
WHERE sensor = 'waterTemp' AND sanity_min IS NULL;

UPDATE sensor_thresholds SET
    satuan = 'C',
    keterangan = 'Batas aman suhu udara 15-33 C (Tabel 13) — min/max live masih 20-40, menunggu keputusan user'
WHERE sensor = 'airTemp' AND keterangan IS NULL;

UPDATE sensor_thresholds SET
    satuan = '%',
    keterangan = 'Batas aman kelembaban 50-85 % (Tabel 13) — max live masih 90, menunggu keputusan user'
WHERE sensor = 'humidity' AND keterangan IS NULL;

COMMIT;

-- Verifikasi (jalankan paska-migrasi):
--   SELECT id_meja, jenis_talang, kapasitas_penampung_l, jumlah_talang,
--          lubang_per_talang, laju_per_talang_lpm FROM mejas ORDER BY id_meja;
--   SELECT * FROM penampung_states ORDER BY id_meja;
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name IN ('monitorings','alert_logs','sensor_thresholds')
--      AND column_name IN ('id_meja','ec_ms_cm','severity','locked','acknowledged',
--                          'deadband','sanity_min','sanity_max','satuan');
--   SELECT sensor, min, max, deadband, sanity_min, sanity_max FROM sensor_thresholds ORDER BY id;
