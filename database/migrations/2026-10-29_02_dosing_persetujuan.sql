-- MIGRASI — persetujuan dosing per siklus, percobaan, rekomendasi, anomali, notifikasi (Fase 3A, DESAIN_FASE2 §4)
-- Tanggal : 2026-10-29
-- Sifat   : ADITIF. dosing_events/dosing_rounds/perintah_aktuator hanya DITAMBAH kolom (nullable/berdefault);
--           semua CHECK lama dipertahankan. penampung_states.mode_operasi default 'MANUAL' → tidak ada
--           permintaan otomatis sampai admin mengubahnya.
-- Parameter keselamatan baru yang BELUM diputuskan disimpan NULL → fitur yang memakainya wajib menolak
-- berjalan sampai diisi (tidak ada angka karangan). Hanya maks_gagal_berturut = 4 (keputusan pengguna).
BEGIN;

-- ── rekomendasi (append-only; angka dari rumus deterministik, AI hanya teks) ──
CREATE TABLE IF NOT EXISTS rekomendasi_dosing (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_meja            bigint NOT NULL REFERENCES mejas(id_meja) ON DELETE RESTRICT,
  id_siklus_budidaya bigint REFERENCES siklus_budidaya(id) ON DELETE RESTRICT,
  input              jsonb NOT NULL CHECK (jsonb_typeof(input) = 'object'),
  aksi               varchar(5) NOT NULL CHECK (aksi IN ('DOSE', 'WAIT')),
  pompa              varchar(10) CHECK (pompa IS NULL OR pompa IN ('AB', 'PH_UP', 'PH_DOWN')),
  estimasi_ml        numeric(8,1) CHECK (estimasi_ml IS NULL OR estimasi_ml > 0),
  target_ec_ppm      numeric(8,2),
  target_ph          numeric(4,2),
  alasan_rumus       text NOT NULL,
  penjelasan_ai      text,
  ai_status          varchar(20) NOT NULL DEFAULT 'TIDAK_TERSEDIA'
                     CHECK (ai_status IN ('OK', 'FALLBACK', 'TIDAK_TERSEDIA', 'DITOLAK_VALIDASI', 'MENUNGGU')),
  ai_model           varchar(60),
  valid              boolean NOT NULL,
  galat_validasi     jsonb,
  dibuat_pada        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rekomendasi_dose_cek CHECK (aksi = 'WAIT' OR (pompa IS NOT NULL AND estimasi_ml IS NOT NULL)),
  CONSTRAINT rekomendasi_valid_cek CHECK (valid OR galat_validasi IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS rekomendasi_dosing_meja_idx ON rekomendasi_dosing (id_meja, dibuat_pada DESC);

-- ── dosing_events = siklus dosing ───────────────────────────────────────────
ALTER TABLE dosing_events ADD COLUMN IF NOT EXISTS status varchar(20);
ALTER TABLE dosing_events ADD COLUMN IF NOT EXISTS mode varchar(10);
ALTER TABLE dosing_events ADD COLUMN IF NOT EXISTS id_rekomendasi uuid REFERENCES rekomendasi_dosing(id) ON DELETE RESTRICT;
ALTER TABLE dosing_events ADD COLUMN IF NOT EXISTS id_siklus_budidaya bigint REFERENCES siklus_budidaya(id) ON DELETE RESTRICT;
ALTER TABLE dosing_events ADD COLUMN IF NOT EXISTS gagal_berturut integer NOT NULL DEFAULT 0;
ALTER TABLE dosing_events ADD COLUMN IF NOT EXISTS berlaku_sampai timestamptz;
ALTER TABLE dosing_events ADD COLUMN IF NOT EXISTS alasan_akhir text;

ALTER TABLE dosing_events DROP CONSTRAINT IF EXISTS dosing_events_status_cek;
-- status NULL = kejadian gaya lama (dibuat aktuator.buatPerintah sebelum alur persetujuan)
ALTER TABLE dosing_events ADD CONSTRAINT dosing_events_status_cek CHECK (status IS NULL OR status IN (
  'WAITING_APPROVAL', 'APPROVED', 'RUNNING', 'MIXING', 'VERIFYING',
  'SUCCESS', 'EXHAUSTED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'FAULT'));
ALTER TABLE dosing_events DROP CONSTRAINT IF EXISTS dosing_events_mode_cek;
ALTER TABLE dosing_events ADD CONSTRAINT dosing_events_mode_cek CHECK (mode IS NULL OR mode IN ('OTOMATIS', 'MANUAL'));
ALTER TABLE dosing_events DROP CONSTRAINT IF EXISTS dosing_events_gagal_cek;
ALTER TABLE dosing_events ADD CONSTRAINT dosing_events_gagal_cek CHECK (gagal_berturut >= 0);
ALTER TABLE dosing_events DROP CONSTRAINT IF EXISTS dosing_events_alur_baru_cek;
ALTER TABLE dosing_events ADD CONSTRAINT dosing_events_alur_baru_cek CHECK (status IS NULL OR mode IS NOT NULL);

-- maksimal satu siklus dosing aktif per penampung
CREATE UNIQUE INDEX IF NOT EXISTS dosing_events_aktif_unik ON dosing_events (id_meja)
  WHERE status IN ('WAITING_APPROVAL', 'APPROVED', 'RUNNING', 'MIXING', 'VERIFYING');

-- ── persetujuan (1:1 dengan siklus dosing; tidak bisa dipakai siklus lain) ──
CREATE TABLE IF NOT EXISTS persetujuan_dosing (
  id                    bigserial PRIMARY KEY,
  id_kejadian           bigint NOT NULL UNIQUE REFERENCES dosing_events(id) ON DELETE RESTRICT,
  keputusan             varchar(6) NOT NULL CHECK (keputusan IN ('SETUJU', 'TOLAK')),
  oleh                  bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  pada                  timestamptz NOT NULL DEFAULT now(),
  target_ec_ppm         numeric(8,2),
  target_ph             numeric(4,2),
  pompa_diizinkan       text[] NOT NULL DEFAULT '{}',
  maks_ml_per_percobaan numeric(8,1),
  maks_ml_total         numeric(8,1),
  maks_percobaan        integer,
  berlaku_sampai        timestamptz,
  kondisi_henti         jsonb,
  alasan                text,
  idempotency_key       uuid NOT NULL UNIQUE,
  dicabut_pada          timestamptz,
  dicabut_oleh          bigint REFERENCES users(id) ON DELETE RESTRICT,
  alasan_cabut          text,
  CONSTRAINT persetujuan_cakupan_cek CHECK (keputusan = 'TOLAK' OR (
    cardinality(pompa_diizinkan) > 0
    AND pompa_diizinkan <@ ARRAY['AB', 'PH_UP', 'PH_DOWN']::text[]
    AND maks_ml_per_percobaan > 0 AND maks_ml_total >= maks_ml_per_percobaan
    AND maks_percobaan BETWEEN 1 AND 4
    AND berlaku_sampai > pada)),
  CONSTRAINT persetujuan_cabut_cek CHECK ((dicabut_pada IS NULL) = (dicabut_oleh IS NULL))
);

-- Hanya kolom pencabutan yang boleh berubah, dan hanya sekali.
CREATE OR REPLACE FUNCTION persetujuan_dosing_beku() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'persetujuan_dosing tidak boleh dihapus (id %)', OLD.id; END IF;
  IF OLD.dicabut_pada IS NOT NULL THEN RAISE EXCEPTION 'persetujuan sudah dicabut (id %)', OLD.id; END IF;
  IF (to_jsonb(NEW) - 'dicabut_pada' - 'dicabut_oleh' - 'alasan_cabut')
     IS DISTINCT FROM (to_jsonb(OLD) - 'dicabut_pada' - 'dicabut_oleh' - 'alasan_cabut') THEN
    RAISE EXCEPTION 'persetujuan_dosing beku: hanya pencabutan yang diizinkan (id %)', OLD.id;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS persetujuan_dosing_beku ON persetujuan_dosing;
CREATE TRIGGER persetujuan_dosing_beku BEFORE UPDATE OR DELETE ON persetujuan_dosing
  FOR EACH ROW EXECUTE FUNCTION persetujuan_dosing_beku();

-- ── dosing_rounds = percobaan ───────────────────────────────────────────────
ALTER TABLE dosing_rounds ADD COLUMN IF NOT EXISTS id_perintah bigint REFERENCES perintah_aktuator(id) ON DELETE RESTRICT;
ALTER TABLE dosing_rounds ADD COLUMN IF NOT EXISTS sensor_sebelum jsonb;
ALTER TABLE dosing_rounds ADD COLUMN IF NOT EXISTS sensor_sesudah jsonb;
ALTER TABLE dosing_rounds ADD COLUMN IF NOT EXISTS delta_harapan_ppm numeric(8,2);
ALTER TABLE dosing_rounds ADD COLUMN IF NOT EXISTS progres numeric(8,4);
ALTER TABLE dosing_rounds ADD COLUMN IF NOT EXISTS ml_nyata numeric(8,1);
ALTER TABLE dosing_rounds ADD COLUMN IF NOT EXISTS durasi_ms integer;
ALTER TABLE dosing_rounds ADD COLUMN IF NOT EXISTS evaluasi varchar(10);
ALTER TABLE dosing_rounds ADD COLUMN IF NOT EXISTS status varchar(10);
CREATE UNIQUE INDEX IF NOT EXISTS dosing_rounds_perintah_unik ON dosing_rounds (id_perintah) WHERE id_perintah IS NOT NULL;
ALTER TABLE dosing_rounds DROP CONSTRAINT IF EXISTS dosing_rounds_evaluasi_cek;
ALTER TABLE dosing_rounds ADD CONSTRAINT dosing_rounds_evaluasi_cek
  CHECK (evaluasi IS NULL OR evaluasi IN ('OK', 'KURANG', 'GAGAL', 'KELEBIHAN'));
ALTER TABLE dosing_rounds DROP CONSTRAINT IF EXISTS dosing_rounds_status_cek;
ALTER TABLE dosing_rounds ADD CONSTRAINT dosing_rounds_status_cek
  CHECK (status IS NULL OR status IN ('RUNNING', 'MIXING', 'VERIFYING', 'SELESAI'));
-- jenis: nilai lama (A, B, PH_UP, PH_DOWN) + AB (satu pompa campuran, seperti perintah DOSIS)
ALTER TABLE dosing_rounds DROP CONSTRAINT IF EXISTS dosing_rounds_jenis_check;
ALTER TABLE dosing_rounds ADD CONSTRAINT dosing_rounds_jenis_check
  CHECK (jenis IN ('A', 'B', 'AB', 'PH_UP', 'PH_DOWN'));

-- ── perintah_aktuator: jejak ke siklus & percobaan, anti-ganda ──────────────
ALTER TABLE perintah_aktuator ADD COLUMN IF NOT EXISTS id_kejadian bigint REFERENCES dosing_events(id) ON DELETE RESTRICT;
ALTER TABLE perintah_aktuator ADD COLUMN IF NOT EXISTS id_percobaan bigint REFERENCES dosing_rounds(id) ON DELETE RESTRICT;
ALTER TABLE perintah_aktuator ADD COLUMN IF NOT EXISTS idempotency_key uuid;
CREATE UNIQUE INDEX IF NOT EXISTS perintah_aktuator_percobaan_unik ON perintah_aktuator (id_percobaan) WHERE id_percobaan IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS perintah_aktuator_idem_unik ON perintah_aktuator (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS perintah_aktuator_kejadian_idx ON perintah_aktuator (id_kejadian) WHERE id_kejadian IS NOT NULL;

-- ── penampung: mode operasi (≠ target_mode) & siklus budidaya aktif ─────────
ALTER TABLE penampung_states ADD COLUMN IF NOT EXISTS mode_operasi varchar(10) NOT NULL DEFAULT 'MANUAL';
ALTER TABLE penampung_states DROP CONSTRAINT IF EXISTS penampung_mode_operasi_cek;
ALTER TABLE penampung_states ADD CONSTRAINT penampung_mode_operasi_cek CHECK (mode_operasi IN ('OTOMATIS', 'MANUAL'));
ALTER TABLE penampung_states ADD COLUMN IF NOT EXISTS id_siklus_budidaya_aktif bigint
  REFERENCES siklus_budidaya(id) ON DELETE SET NULL;

-- ── anomali & penanganan ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS anomali (
  id                   bigserial PRIMARY KEY,
  id_alert             bigint REFERENCES alert_logs(id) ON DELETE SET NULL,
  id_meja              bigint REFERENCES mejas(id_meja) ON DELETE SET NULL,
  id_kejadian          bigint REFERENCES dosing_events(id) ON DELETE SET NULL,
  jenis                varchar(40) NOT NULL,
  severity             varchar(10) NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  sensor               varchar(20),
  pesan                text NOT NULL,
  tindakan_keselamatan varchar(10) NOT NULL DEFAULT 'NONE' CHECK (tindakan_keselamatan IN ('NONE', 'STOP', 'LOCK', 'ESTOP')),
  status_pemulihan     varchar(10) NOT NULL DEFAULT 'TERBUKA' CHECK (status_pemulihan IN ('TERBUKA', 'DITANGANI', 'PULIH')),
  terjadi_pada         timestamptz NOT NULL DEFAULT now(),
  pulih_pada           timestamptz,
  CONSTRAINT anomali_pulih_cek CHECK ((status_pemulihan = 'PULIH') = (pulih_pada IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS anomali_status_idx ON anomali (status_pemulihan, terjadi_pada DESC);
CREATE UNIQUE INDEX IF NOT EXISTS anomali_alert_unik ON anomali (id_alert) WHERE id_alert IS NOT NULL;

CREATE TABLE IF NOT EXISTS anomali_tindakan (
  id          bigserial PRIMARY KEY,
  id_anomali  bigint NOT NULL REFERENCES anomali(id) ON DELETE RESTRICT,
  status_baru varchar(10) NOT NULL CHECK (status_baru IN ('TERBUKA', 'DITANGANI', 'PULIH')),
  catatan     text NOT NULL CHECK (length(btrim(catatan)) >= 5),
  oleh        bigint REFERENCES users(id) ON DELETE SET NULL,
  aktor_tipe  varchar(10) NOT NULL DEFAULT 'user' CHECK (aktor_tipe IN ('user', 'system')),
  pada        timestamptz NOT NULL DEFAULT now(),
  idempotency_key uuid UNIQUE,
  CONSTRAINT anomali_tindakan_aktor_cek CHECK (aktor_tipe = 'system' OR oleh IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS anomali_tindakan_idx ON anomali_tindakan (id_anomali, pada);

-- ── notifikasi (polling; id = kursor) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifikasi (
  id            bigserial PRIMARY KEY,
  untuk_user_id bigint REFERENCES users(id) ON DELETE CASCADE,
  untuk_role    varchar(10) CHECK (untuk_role IS NULL OR untuk_role IN ('admin', 'petani')),
  jenis         varchar(40) NOT NULL,
  severity      varchar(10) NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical')),
  judul         varchar(150) NOT NULL,
  isi           text NOT NULL,
  tautan        jsonb,
  dedup_key     varchar(150) UNIQUE,
  dibuat_pada   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifikasi_user_idx ON notifikasi (untuk_user_id, id);
CREATE INDEX IF NOT EXISTS notifikasi_role_idx ON notifikasi (untuk_role, id);

CREATE TABLE IF NOT EXISTS notifikasi_baca (
  id_notifikasi bigint NOT NULL REFERENCES notifikasi(id) ON DELETE CASCADE,
  id_user       bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dibaca_pada   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id_notifikasi, id_user)
);

-- ── parameter keselamatan baru ──────────────────────────────────────────────
-- konfigurasi_dosis.nilai harus boleh NULL agar "belum diputuskan" tidak terisi angka karangan
ALTER TABLE konfigurasi_dosis ALTER COLUMN nilai DROP NOT NULL;
INSERT INTO konfigurasi_dosis (param, nilai, satuan, keterangan, sumber, diubah_pada) VALUES
  ('maks_gagal_berturut', 4, 'percobaan', 'Percobaan gagal berturut dalam satu siklus dosing → FAULT + LOCK', 'Keputusan pengguna 2026-10-28', now()),
  ('maks_masa_persetujuan_menit', NULL, 'menit', 'Masa berlaku maksimal persetujuan dosing. NULL = belum diputuskan → persetujuan ditolak', 'DESAIN_FASE2 J.2 (terbuka)', now()),
  ('min_progres_persen', NULL, '%', 'Progres minimal (terhadap delta harapan) agar percobaan tidak dihitung GAGAL. NULL = belum diputuskan', 'DESAIN_FASE2 J.2 (terbuka)', now()),
  ('maks_lampau_persen', NULL, '%', 'Lampauan target maksimal sebelum FAULT (KELEBIHAN). NULL = belum diputuskan', 'DESAIN_FASE2 J.2 (terbuka)', now()),
  ('wajib_firmware_v03', 0, 'saklar', '1 = DOSIS hanya dikirim ke aktuator firmware ≥ 0.3 (cek exp & NVS)', 'DESAIN_FASE2 §6', now())
ON CONFLICT (param) DO NOTHING;

INSERT INTO timing_operasi (param, nilai, satuan, keterangan, sumber, diubah_pada) VALUES
  ('stabil_menit', NULL, 'menit', 'Jendela bacaan stabil sebelum minta konfirmasi tandon. NULL = belum diputuskan', 'DESAIN_FASE2 J.2 (terbuka)', now()),
  ('stabil_n_bacaan', NULL, 'bacaan', 'Jumlah bacaan valid dalam pita untuk dianggap stabil. NULL = belum diputuskan', 'DESAIN_FASE2 J.2 (terbuka)', now()),
  ('konfirmasi_tandon_jam', NULL, 'jam', 'Batas jawab konfirmasi tandon siap. NULL = belum diputuskan', 'DESAIN_FASE2 J.2 (terbuka)', now()),
  ('konfirmasi_peremajaan_jam_ke', 96, 'jam', 'Konfirmasi peremajaan dimulai 96 jam (H+4) sejak semai_mulai_pada', 'Keputusan pengguna (spesifikasi Fase 3)', now()),
  ('konfirmasi_peremajaan_batas_jam', 24, 'jam', 'Batas jawab konfirmasi peremajaan', 'Keputusan pengguna (spesifikasi)', now()),
  ('ulang_konfirmasi_jam', NULL, 'jam', 'Jeda konfirmasi ulang setelah BELUM SIAP / kedaluwarsa. NULL = belum diputuskan', 'DESAIN_FASE2 J.3 (terbuka)', now()),
  ('pengingat_konfirmasi_jam', NULL, 'jam', 'Pengingat dikirim N jam setelah permintaan dibuat. NULL = belum diputuskan', 'DESAIN_FASE2 J.3 (terbuka)', now())
ON CONFLICT (param) DO NOTHING;

COMMIT;
