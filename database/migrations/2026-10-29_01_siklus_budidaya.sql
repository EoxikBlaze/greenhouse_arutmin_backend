-- MIGRASI — model siklus budidaya baru + preset bersversi (Fase 3A, docs/DESAIN_FASE2.md §4)
-- Tanggal : 2026-10-29
-- Sifat   : ADITIF. Tidak ada DROP/RENAME/UPDATE pada tabel lama (semais, peremajaans, pendewasaans,
--           panens, sikluses, target_nutrisi, tanamen). Data lama disalin oleh scripts/migrasi-siklus.js.
-- Data lama yang tidak memenuhi aturan baru (docs/FASE3_PEMERIKSAAN.md §5) disalin APA ADANYA dengan
-- asal='MIGRASI' + perlu_tinjau; aturan ketat (jumlah cocok, tanaman wajib) hanya untuk asal='BARU'.
BEGIN;

-- ── preset bersversi ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS preset_nutrisi (
  id             bigserial PRIMARY KEY,
  id_tanaman     bigint NOT NULL REFERENCES tanamen(id_tanaman) ON DELETE RESTRICT,
  nama           varchar(100) NOT NULL,
  aktif_versi_id bigint,
  dibuat_pada    timestamptz NOT NULL DEFAULT now(),
  dibuat_oleh    bigint REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT preset_nutrisi_tanaman_unik UNIQUE (id_tanaman, nama)
);

-- Versi TIDAK pernah di-UPDATE/DELETE oleh API: perubahan = versi baru. Trigger di bawah menjaga ini.
CREATE TABLE IF NOT EXISTS preset_versi (
  id              bigserial PRIMARY KEY,
  id_preset       bigint NOT NULL REFERENCES preset_nutrisi(id) ON DELETE RESTRICT,
  versi           integer NOT NULL CHECK (versi >= 1),
  parameter       jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(parameter) = 'object'),
  status_validasi varchar(20) NOT NULL DEFAULT 'BELUM_TERVALIDASI'
                  CHECK (status_validasi IN ('BELUM_TERVALIDASI', 'TERVALIDASI')),
  divalidasi_oleh bigint REFERENCES users(id) ON DELETE SET NULL,
  divalidasi_pada timestamptz,
  catatan         text,
  sumber          varchar(200),
  dibuat_pada     timestamptz NOT NULL DEFAULT now(),
  dibuat_oleh     bigint REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT preset_versi_unik UNIQUE (id_preset, versi),
  CONSTRAINT preset_versi_validasi_cek CHECK (status_validasi = 'BELUM_TERVALIDASI' OR divalidasi_pada IS NOT NULL)
);

DO $$ BEGIN
  ALTER TABLE preset_nutrisi ADD CONSTRAINT preset_nutrisi_aktif_versi_fk
    FOREIGN KEY (aktif_versi_id) REFERENCES preset_versi(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Isi parameter versi beku; hanya kolom validasi yang boleh diisi (sekali, BELUM → TERVALIDASI).
CREATE OR REPLACE FUNCTION preset_versi_beku() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- satu-satunya pengecualian: rollback migrasi (scripts/migrasi-siklus.js --balik) di dalam transaksinya
    IF current_setting('garap.rollback_migrasi', true) = 'on' AND OLD.sumber LIKE 'migrasi:%' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'preset_versi tidak boleh dihapus (id %)', OLD.id;
  END IF;
  IF NEW.parameter IS DISTINCT FROM OLD.parameter OR NEW.versi <> OLD.versi OR NEW.id_preset <> OLD.id_preset
     OR NEW.dibuat_pada <> OLD.dibuat_pada OR NEW.sumber IS DISTINCT FROM OLD.sumber THEN
    RAISE EXCEPTION 'preset_versi beku: buat versi baru (id %)', OLD.id;
  END IF;
  IF OLD.status_validasi = 'TERVALIDASI' AND NEW.status_validasi <> 'TERVALIDASI' THEN
    RAISE EXCEPTION 'validasi preset_versi tidak bisa dicabut (id %)', OLD.id;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS preset_versi_beku ON preset_versi;
CREATE TRIGGER preset_versi_beku BEFORE UPDATE OR DELETE ON preset_versi
  FOR EACH ROW EXECUTE FUNCTION preset_versi_beku();

-- ── siklus budidaya ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS siklus_budidaya (
  id                        bigserial PRIMARY KEY,
  id_tanaman                bigint REFERENCES tanamen(id_tanaman) ON DELETE RESTRICT,
  id_meja_semai             bigint REFERENCES mejas(id_meja) ON DELETE RESTRICT,
  id_preset_versi           bigint REFERENCES preset_versi(id) ON DELETE RESTRICT,
  mode_target               varchar(10) NOT NULL DEFAULT 'PRESET' CHECK (mode_target IN ('PRESET', 'MANUAL')),
  target                    jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(target) = 'object'),
  ph_awal                   numeric(4,2) CHECK (ph_awal IS NULL OR ph_awal BETWEEN 0 AND 14),
  tds_awal_ppm              numeric(8,2) CHECK (tds_awal_ppm IS NULL OR tds_awal_ppm BETWEEN 0 AND 10000),
  jumlah_benih              integer NOT NULL CHECK (jumlah_benih >= 0),
  benih_berhasil            integer CHECK (benih_berhasil IS NULL OR benih_berhasil >= 0),
  benih_gagal               integer CHECK (benih_gagal IS NULL OR benih_gagal >= 0),
  status                    varchar(40) NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
                              'DRAFT', 'TANK_PREPARATION', 'WAITING_TANK_CONFIRMATION', 'SEEDING',
                              'WAITING_REJUVENATION_CONFIRMATION', 'WAITING_SEED_COUNT_CONFIRMATION',
                              'GROWTH', 'COMPLETED', 'CANCELLED')),
  hasil                     varchar(20) CHECK (hasil IS NULL OR hasil IN ('PANEN', 'GAGAL_SEMAI', 'DIBATALKAN')),
  semai_mulai_pada          timestamptz,
  waktu_presisi             varchar(10) NOT NULL DEFAULT 'DETIK' CHECK (waktu_presisi IN ('DETIK', 'TANGGAL')),
  jadwal_konfirmasi_berikut timestamptz,
  keterangan                text,
  dibuat_pada               timestamptz NOT NULL DEFAULT now(),
  dibuat_oleh               bigint REFERENCES users(id) ON DELETE SET NULL,
  diperbarui_pada           timestamptz NOT NULL DEFAULT now(),
  selesai_pada              timestamptz,
  expires_at                timestamp(0) without time zone,
  asal                      varchar(10) NOT NULL DEFAULT 'BARU' CHECK (asal IN ('BARU', 'MIGRASI')),
  perlu_tinjau              boolean NOT NULL DEFAULT false,
  alasan_tinjau             text[] NOT NULL DEFAULT '{}',
  legacy_semai_id           bigint UNIQUE,
  legacy_pendewasaan_yatim  bigint UNIQUE,
  -- aturan ketat hanya untuk data baru (keputusan pengguna 29 Okt 2026)
  CONSTRAINT siklus_tanaman_wajib CHECK (asal = 'MIGRASI' OR id_tanaman IS NOT NULL),
  CONSTRAINT siklus_meja_wajib CHECK (asal = 'MIGRASI' OR id_meja_semai IS NOT NULL),
  CONSTRAINT siklus_benih_positif CHECK (asal = 'MIGRASI' OR jumlah_benih > 0),
  CONSTRAINT siklus_benih_cocok CHECK (
    asal = 'MIGRASI'
    OR (benih_berhasil IS NULL AND benih_gagal IS NULL)
    OR (benih_berhasil IS NOT NULL AND benih_gagal IS NOT NULL AND benih_berhasil + benih_gagal = jumlah_benih)),
  CONSTRAINT siklus_semai_waktu CHECK (
    asal = 'MIGRASI' OR status IN ('DRAFT', 'TANK_PREPARATION', 'WAITING_TANK_CONFIRMATION', 'CANCELLED')
    OR semai_mulai_pada IS NOT NULL),
  CONSTRAINT siklus_preset_cek CHECK (asal = 'MIGRASI' OR mode_target = 'MANUAL' OR id_preset_versi IS NOT NULL),
  CONSTRAINT siklus_selesai_cek CHECK (status NOT IN ('COMPLETED', 'CANCELLED') OR selesai_pada IS NOT NULL),
  CONSTRAINT siklus_legacy_cek CHECK (asal = 'MIGRASI' OR (legacy_semai_id IS NULL AND legacy_pendewasaan_yatim IS NULL)),
  CONSTRAINT siklus_tinjau_cek CHECK (perlu_tinjau = (cardinality(alasan_tinjau) > 0))
);

-- lot = kelompok tanaman per meja per tahap; menggantikan peremajaan/pendewasaan/panen; cabang lewat induk
CREATE TABLE IF NOT EXISTS siklus_lot (
  id            bigserial PRIMARY KEY,
  id_siklus     bigint NOT NULL REFERENCES siklus_budidaya(id) ON DELETE RESTRICT,
  id_lot_induk  bigint REFERENCES siklus_lot(id) ON DELETE RESTRICT,
  tahap         varchar(12) NOT NULL CHECK (tahap IN ('PEREMAJAAN', 'PENDEWASAAN', 'PANEN')),
  id_meja       bigint REFERENCES mejas(id_meja) ON DELETE RESTRICT,
  jumlah_masuk  integer CHECK (jumlah_masuk IS NULL OR jumlah_masuk >= 0),
  berhasil      integer CHECK (berhasil IS NULL OR berhasil >= 0),
  gagal         integer CHECK (gagal IS NULL OR gagal >= 0),
  status        varchar(8) NOT NULL DEFAULT 'PROSES' CHECK (status IN ('PROSES', 'SELESAI', 'GAGAL')),
  mulai_pada    timestamptz,
  selesai_pada  timestamptz,
  waktu_presisi varchar(10) NOT NULL DEFAULT 'DETIK' CHECK (waktu_presisi IN ('DETIK', 'TANGGAL')),
  keterangan    text,
  dibuat_pada   timestamptz NOT NULL DEFAULT now(),
  dibuat_oleh   bigint REFERENCES users(id) ON DELETE SET NULL,
  expires_at    timestamp(0) without time zone,
  perlu_tinjau  boolean NOT NULL DEFAULT false,
  alasan_tinjau text[] NOT NULL DEFAULT '{}',
  legacy_tabel  varchar(20) CHECK (legacy_tabel IS NULL OR legacy_tabel IN ('peremajaans', 'pendewasaans', 'panens')),
  legacy_id     bigint,
  CONSTRAINT siklus_lot_legacy_unik UNIQUE (legacy_tabel, legacy_id),
  CONSTRAINT siklus_lot_legacy_pasang CHECK ((legacy_tabel IS NULL) = (legacy_id IS NULL)),
  CONSTRAINT siklus_lot_bukan_induk_sendiri CHECK (id_lot_induk IS NULL OR id_lot_induk <> id),
  -- data baru: jumlah wajib ada & berhasil+gagal = masuk bila sudah diisi
  CONSTRAINT siklus_lot_jumlah_cek CHECK (
    legacy_tabel IS NOT NULL
    OR (jumlah_masuk IS NOT NULL AND (
        (berhasil IS NULL AND gagal IS NULL)
        OR (berhasil IS NOT NULL AND gagal IS NOT NULL AND berhasil + gagal = jumlah_masuk)))),
  CONSTRAINT siklus_lot_selesai_cek CHECK (legacy_tabel IS NOT NULL OR status = 'PROSES' OR selesai_pada IS NOT NULL),
  CONSTRAINT siklus_lot_tinjau_cek CHECK (perlu_tinjau = (cardinality(alasan_tinjau) > 0))
);

-- riwayat transisi: append-only
CREATE TABLE IF NOT EXISTS siklus_transisi (
  id            bigserial PRIMARY KEY,
  id_siklus     bigint NOT NULL REFERENCES siklus_budidaya(id) ON DELETE RESTRICT,
  dari          varchar(40),
  ke            varchar(40) NOT NULL,
  aktor_tipe    varchar(10) NOT NULL CHECK (aktor_tipe IN ('user', 'system')),
  aktor_user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  alasan        text,
  data          jsonb,
  terjadi_pada  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT siklus_transisi_aktor_cek CHECK (aktor_tipe = 'system' OR aktor_user_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS permintaan_konfirmasi (
  id                 bigserial PRIMARY KEY,
  id_siklus          bigint NOT NULL REFERENCES siklus_budidaya(id) ON DELETE RESTRICT,
  jenis              varchar(15) NOT NULL CHECK (jenis IN ('TANK_READY', 'REJUVENATION')),
  percobaan_ke       integer NOT NULL DEFAULT 1 CHECK (percobaan_ke >= 1),
  dibuat_pada        timestamptz NOT NULL DEFAULT now(),
  kedaluwarsa_pada   timestamptz,
  pengingat_pada     timestamptz,
  pengingat_terkirim boolean NOT NULL DEFAULT false,
  status             varchar(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN (
                       'PENDING', 'ANSWERED_READY', 'ANSWERED_NOT_READY', 'EXPIRED', 'CANCELLED')),
  dijawab_oleh       bigint REFERENCES users(id) ON DELETE SET NULL,
  dijawab_pada       timestamptz,
  idempotency_key    uuid UNIQUE,
  CONSTRAINT konfirmasi_jawab_cek CHECK (
    status NOT IN ('ANSWERED_READY', 'ANSWERED_NOT_READY') OR (dijawab_oleh IS NOT NULL AND dijawab_pada IS NOT NULL)),
  CONSTRAINT konfirmasi_waktu_cek CHECK (kedaluwarsa_pada IS NULL OR kedaluwarsa_pada > dibuat_pada)
);

-- ── indeks & pelindung operasi ganda ────────────────────────────────────────
CREATE INDEX IF NOT EXISTS siklus_budidaya_aktif_idx ON siklus_budidaya (status)
  WHERE status NOT IN ('COMPLETED', 'CANCELLED');
CREATE INDEX IF NOT EXISTS siklus_budidaya_jadwal_idx ON siklus_budidaya (jadwal_konfirmasi_berikut)
  WHERE status = 'SEEDING';
CREATE INDEX IF NOT EXISTS siklus_budidaya_tanaman_idx ON siklus_budidaya (id_tanaman);
-- satu siklus persiapan/semai per penampung
CREATE UNIQUE INDEX IF NOT EXISTS siklus_budidaya_meja_semai_unik ON siklus_budidaya (id_meja_semai)
  WHERE status IN ('TANK_PREPARATION', 'WAITING_TANK_CONFIRMATION', 'SEEDING',
                   'WAITING_REJUVENATION_CONFIRMATION', 'WAITING_SEED_COUNT_CONFIRMATION');
CREATE INDEX IF NOT EXISTS siklus_lot_siklus_idx ON siklus_lot (id_siklus);
CREATE INDEX IF NOT EXISTS siklus_lot_induk_idx ON siklus_lot (id_lot_induk);
CREATE INDEX IF NOT EXISTS siklus_lot_meja_proses_idx ON siklus_lot (id_meja) WHERE status = 'PROSES';
CREATE INDEX IF NOT EXISTS siklus_transisi_siklus_idx ON siklus_transisi (id_siklus, terjadi_pada);
CREATE INDEX IF NOT EXISTS permintaan_konfirmasi_jatuh_tempo_idx ON permintaan_konfirmasi (kedaluwarsa_pada)
  WHERE status = 'PENDING';
-- hanya satu permintaan terbuka per (siklus, jenis)
CREATE UNIQUE INDEX IF NOT EXISTS permintaan_konfirmasi_pending_unik ON permintaan_konfirmasi (id_siklus, jenis)
  WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS preset_versi_preset_idx ON preset_versi (id_preset, versi DESC);

-- ── audit: aksi baru untuk transisi/persetujuan (nilai lama dipertahankan) ──
ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_aksi_check;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_aksi_check CHECK (aksi IN (
  'create', 'update', 'delete', 'login', 'logout', 'login_failed', 'override_start', 'override_stop',
  'command', 'export', 'reset_lock', 'maintenance_on', 'maintenance_off', 'config_change', 'report_generate',
  'transition', 'confirm', 'approve', 'reject', 'revoke'));

COMMIT;
