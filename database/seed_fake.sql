-- ============================================================================
-- DATA PALSU UNTUK DEBUGGING — GARAP
-- Jalankan : psql "$DATABASE_URL" -f database/seed_fake.sql
-- Hapus    : psql "$DATABASE_URL" -f database/hapus_fake.sql
-- Aman diulang: bila data palsu sudah ada, skrip berhenti tanpa menambah apa pun.
-- Penanda  : nama berawalan "DEMO", keterangan "FAKE-DEBUG", alert berawalan "[FAKE]".
-- Isi      : 4 meja (3 NFT + 1 DFT, sesuai rancangan), 2 tanaman, siklus tanam
--            lengkap (semai→panen), 288 bacaan sensor 24 jam terakhir per meja (ada yang
--            di luar ambang), 14 alert, state penampung (normal/LOCK/pemeliharaan/
--            hampir habis jatah), dan 4 kamera CCTV (hidup, putus, nonaktif).
-- CATATAN  : bacaan terbaru dibuat "baru saja" → status IoT ONLINE selama ±2 menit
--            (batas 120 dtk). Agar tetap online, jalankan `npm run sim:sensor`.
-- ============================================================================

-- tabel CCTV (idempoten; sama dengan migrasi 2026-10-22_01_cctv_kamera.sql)
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

DO $$
DECLARE
  m1 bigint; m2 bigint; m3 bigint; m4 bigint;
  t_pak bigint; t_bw bigint;
  s_pak_semai bigint; s_pak_prem bigint; s_pak_dewasa bigint;
  s_bw_semai bigint; s_bw_prem bigint; s_bw_dewasa bigint;
  sm_a bigint; sm_b bigint; sm_c bigint; sm_d bigint; sm_e bigint;
  pr_a bigint; pr_b bigint; pd_a bigint; pd_b bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM mejas WHERE meja LIKE 'DEMO Meja%') THEN
    RAISE NOTICE 'Data palsu sudah ada — dilewati. Jalankan hapus_fake.sql dulu bila ingin membuat ulang.';
    RETURN;
  END IF;

  -- ── meja (Tabel 1 rancangan FINAL) ─────────────────────────────────────
  INSERT INTO mejas (meja, jumlah_lubang, jenis_talang, kapasitas_penampung_l, jumlah_talang,
                     lubang_per_talang, panjang_talang_m, laju_per_talang_lpm, created_at, updated_at)
  VALUES ('DEMO Meja 1', 312, 'NFT', 70, 12, 26, 8.1, 1, now(), now()) RETURNING id_meja INTO m1;
  INSERT INTO mejas (meja, jumlah_lubang, jenis_talang, kapasitas_penampung_l, jumlah_talang,
                     lubang_per_talang, panjang_talang_m, laju_per_talang_lpm, created_at, updated_at)
  VALUES ('DEMO Meja 2', 208, 'NFT', 70, 8, 26, 8.1, 1, now(), now()) RETURNING id_meja INTO m2;
  INSERT INTO mejas (meja, jumlah_lubang, jenis_talang, kapasitas_penampung_l, jumlah_talang,
                     lubang_per_talang, panjang_talang_m, laju_per_talang_lpm, created_at, updated_at)
  VALUES ('DEMO Meja 3', 520, 'NFT', 70, 10, 52, 8.1, 1, now(), now()) RETURNING id_meja INTO m3;
  INSERT INTO mejas (meja, jumlah_lubang, jenis_talang, kapasitas_penampung_l, jumlah_talang,
                     lubang_per_talang, panjang_talang_m, laju_per_talang_lpm, created_at, updated_at)
  VALUES ('DEMO Meja 4', 180, 'DFT', 75, 10, 18, 4, NULL, now(), now()) RETURNING id_meja INTO m4;

  -- ── tanaman + siklus ───────────────────────────────────────────────────
  INSERT INTO tanamen (nama_tanaman, id_meja, created_at, updated_at) VALUES ('DEMO Pakcoy', m1, now(), now()) RETURNING id_tanaman INTO t_pak;
  INSERT INTO tanamen (nama_tanaman, id_meja, created_at, updated_at) VALUES ('DEMO Daun Bawang', m3, now(), now()) RETURNING id_tanaman INTO t_bw;
  INSERT INTO sikluses (id_tanaman, nama_siklus, waktu_siklus, created_at, updated_at) VALUES (t_pak, 'Semai', 7, now(), now()) RETURNING id_siklus INTO s_pak_semai;
  INSERT INTO sikluses (id_tanaman, nama_siklus, waktu_siklus, created_at, updated_at) VALUES (t_pak, 'Peremajaan', 14, now(), now()) RETURNING id_siklus INTO s_pak_prem;
  INSERT INTO sikluses (id_tanaman, nama_siklus, waktu_siklus, created_at, updated_at) VALUES (t_pak, 'Pendewasaan', 21, now(), now()) RETURNING id_siklus INTO s_pak_dewasa;
  INSERT INTO sikluses (id_tanaman, nama_siklus, waktu_siklus, created_at, updated_at) VALUES (t_bw, 'Semai', 10, now(), now()) RETURNING id_siklus INTO s_bw_semai;
  INSERT INTO sikluses (id_tanaman, nama_siklus, waktu_siklus, created_at, updated_at) VALUES (t_bw, 'Peremajaan', 18, now(), now()) RETURNING id_siklus INTO s_bw_prem;
  INSERT INTO sikluses (id_tanaman, nama_siklus, waktu_siklus, created_at, updated_at) VALUES (t_bw, 'Pendewasaan', 30, now(), now()) RETURNING id_siklus INTO s_bw_dewasa;

  -- ── semai: 2 selesai (lanjut ke tahap berikut), 2 proses, 1 gagal ─────────
  INSERT INTO semais (id_tanaman, id_siklus, id_meja, jumlah_benih, tgl_awal_semai, tgl_akhir_semai, status, keterangan, benih_berhasil, benih_gagal, created_at, updated_at)
  VALUES (t_pak, s_pak_semai, m1, 300, current_date-40, current_date-33, 'selesai', 'FAKE-DEBUG', 280, 20, now(), now()) RETURNING id_semai INTO sm_a;
  INSERT INTO semais (id_tanaman, id_siklus, id_meja, jumlah_benih, tgl_awal_semai, tgl_akhir_semai, status, keterangan, benih_berhasil, benih_gagal, created_at, updated_at)
  VALUES (t_bw, s_bw_semai, m3, 500, current_date-30, current_date-20, 'selesai', 'FAKE-DEBUG', 470, 30, now(), now()) RETURNING id_semai INTO sm_b;
  INSERT INTO semais (id_tanaman, id_siklus, id_meja, jumlah_benih, tgl_awal_semai, tgl_akhir_semai, status, keterangan, benih_berhasil, benih_gagal, created_at, updated_at)
  VALUES (t_pak, s_pak_semai, m2, 200, current_date-5, current_date+2, 'proses', 'FAKE-DEBUG', 0, 0, now(), now()) RETURNING id_semai INTO sm_c;
  INSERT INTO semais (id_tanaman, id_siklus, id_meja, jumlah_benih, tgl_awal_semai, tgl_akhir_semai, status, keterangan, benih_berhasil, benih_gagal, created_at, updated_at)
  VALUES (t_bw, s_bw_semai, m4, 150, current_date-2, current_date+8, 'proses', 'FAKE-DEBUG', 0, 0, now(), now()) RETURNING id_semai INTO sm_d;
  INSERT INTO semais (id_tanaman, id_siklus, id_meja, jumlah_benih, tgl_awal_semai, tgl_akhir_semai, status, keterangan, benih_berhasil, benih_gagal, created_at, updated_at)
  VALUES (t_pak, s_pak_semai, m2, 100, current_date-15, current_date-8, 'gagal', 'FAKE-DEBUG: benih busuk', 0, 100, now(), now()) RETURNING id_semai INTO sm_e;

  -- ── peremajaan → pendewasaan → panen ────────────────────────────────────
  INSERT INTO peremajaans (id_semai, id_meja, benih_berhasil, benih_gagal, tgl_awal_peremajaan, tgl_akhir_peremajaan, keterangan, jumlah_masuk, created_at, updated_at)
  VALUES (sm_a, m1, 270, 10, current_date-33, current_date-19, 'FAKE-DEBUG', 280, now(), now()) RETURNING id_peremajaan INTO pr_a;
  INSERT INTO peremajaans (id_semai, id_meja, benih_berhasil, benih_gagal, tgl_awal_peremajaan, tgl_akhir_peremajaan, keterangan, jumlah_masuk, created_at, updated_at)
  VALUES (sm_b, m3, 0, 0, current_date-20, current_date-2, 'FAKE-DEBUG', 470, now(), now()) RETURNING id_peremajaan INTO pr_b;
  INSERT INTO pendewasaans (id_peremajaan, id_meja, tanaman_berhasil, tanaman_gagal, tgl_awal_pendewasaan, tgl_akhir_pendewasaan, keterangan, jumlah_masuk, created_at, updated_at)
  VALUES (pr_a, m1, 255, 15, current_date-19, current_date-1, 'FAKE-DEBUG', 270, now(), now()) RETURNING id_pendewasaan INTO pd_a;
  INSERT INTO pendewasaans (id_peremajaan, id_meja, tanaman_berhasil, tanaman_gagal, tgl_awal_pendewasaan, tgl_akhir_pendewasaan, keterangan, jumlah_masuk, created_at, updated_at)
  VALUES (pr_b, m3, 0, 0, current_date-2, current_date+28, 'FAKE-DEBUG', 440, now(), now()) RETURNING id_pendewasaan INTO pd_b;
  INSERT INTO panens (id_pendewasaan, panen_berhasil, panen_gagal, tgl_panen, keterangan, created_at, updated_at)
  VALUES (pd_a, 250, 5, current_date-1, 'FAKE-DEBUG', now(), now());
  INSERT INTO panens (id_pendewasaan, panen_berhasil, panen_gagal, tgl_panen, keterangan, created_at, updated_at)
  VALUES (pd_a, 4, 1, current_date, 'FAKE-DEBUG: sisa panen', now(), now());

  -- ── bacaan sensor 24 jam per meja DEMO (tiap 5 menit, deterministik) ────
  -- Tiap meja punya geseran nilai kecil (k) agar tabel per meja tidak kembar;
  -- lonjakan/anomali (pH 7.4/4.7, TDS 1320/380, suhu udara 37) hanya di Meja 1.
  PERFORM setseed(0.42);
  INSERT INTO monitorings ("waterTemp", ph, tds, "airTemp", humidity, id_meja, ec_ms_cm, created_at, updated_at)
  SELECT
    round((25.5 + mj.k*0.3 + 2.0*sin(n/40.0) + (random()-0.5)*0.6)::numeric, 1),
    round((CASE WHEN mj.k = 0 AND n % 97 = 5 THEN 7.4 WHEN mj.k = 0 AND n % 131 = 9 THEN 4.7
                ELSE 6.1 + mj.k*0.08 + 0.25*sin(n/30.0 + mj.k) + (random()-0.5)*0.12 END)::numeric, 2),
    round((CASE WHEN mj.k = 0 AND n BETWEEN 3 AND 9 THEN 1320 WHEN mj.k = 0 AND n % 173 = 11 THEN 380
                ELSE 900 + mj.k*25 + 120*sin(n/55.0 + mj.k) + (random()-0.5)*40 END)::numeric, 0),
    round((CASE WHEN mj.k = 0 AND n BETWEEN 100 AND 130 THEN 37 ELSE 29 + mj.k*0.4 + 4*sin(n/50.0) + (random()-0.5)*0.8 END)::numeric, 1),
    round((68 - mj.k*2 + 10*sin(n/45.0 + 1) + (random()-0.5)*2)::numeric, 0),
    mj.id,
    round((CASE WHEN mj.k = 0 AND n BETWEEN 3 AND 9 THEN 1320 ELSE 900 + mj.k*25 + 120*sin(n/55.0 + mj.k) END / 500.0)::numeric, 2),
    now() - (n * interval '5 minutes') - (10 + mj.k) * interval '1 second',
    now() - (n * interval '5 minutes') - (10 + mj.k) * interval '1 second'
  FROM generate_series(0, 287) AS n
  CROSS JOIN (VALUES (m1, 0), (m2, 1), (m3, 2), (m4, 3)) AS mj(id, k);

  -- ── alert (campur severity / LOCK / sudah dibaca) ───────────────────────
  INSERT INTO alert_logs (type, value, severity, locked, acknowledged, acknowledged_at, id_meja, created_at, updated_at) VALUES
    ('di_luar_batas',            '[FAKE] pH 7.4 di atas ambang 7.0',                'warning',  false, false, NULL,                     m1, now()-interval '20 minutes', now()),
    ('di_luar_batas',           '[FAKE] TDS 1320 ppm di atas ambang',              'warning',  false, false, NULL,                     m1, now()-interval '55 minutes', now()),
    ('retry_habis',   '[FAKE] Retry EC habis (5x) — penampung LOCK',     'critical', true,  false, NULL,                     m2, now()-interval '2 hours',    now()),
    ('timeout_isi_air','[FAKE] Float tidak naik 15 menit — cek tandon',  'critical', true,  false, NULL,                     m3, now()-interval '3 hours',    now()),
    ('sensor',        '[FAKE] Sensor pH tidak stabil lewat timeout',     'warning',  false, true,  now()-interval '2 hours', m3, now()-interval '5 hours',    now()),
    ('solenoid',      '[FAKE] Solenoid cabang 4 terbuka lebih dari 60 dtk','warning', false, true,  now()-interval '8 hours', m4, now()-interval '9 hours',    now()),
    ('batas_dosis',   '[FAKE] Jatah 8 kejadian dosing hampir habis',     'info',     false, false, NULL,                     m4, now()-interval '30 minutes', now()),
    ('wifi',          '[FAKE] WiFi putus 4 menit lalu tersambung lagi',  'info',     false, true,  now()-interval '10 hours',NULL, now()-interval '11 hours', now()),
    ('di_luar_batas',          '[FAKE] Suhu udara 37 °C di atas ambang',          'warning',  false, true,  now()-interval '20 hours',NULL, now()-interval '21 hours', now()),
    ('di_luar_batas',            '[FAKE] pH 4.7 di bawah ambang 5.0',               'critical', false, false, NULL,                     m1, now()-interval '23 hours',   now()),
    ('di_luar_batas',           '[FAKE] TDS 380 ppm di bawah ambang',              'warning',  false, true,  now()-interval '1 day',   m2, now()-interval '1 day 2 hours', now()),
    ('estop',         '[FAKE] E-STOP ditekan petani',                    'critical', false, true,  now()-interval '2 days',  NULL, now()-interval '2 days',   now()),
    ('reset',         '[FAKE] Sistem direset oleh petani',               'info',     false, true,  now()-interval '2 days',  NULL, now()-interval '2 days',   now()),
    ('timeout_botol', '[FAKE] Botol sampel tidak penuh dalam 60 detik',  'warning',  false, false, NULL,                     m1, now()-interval '3 days',     now());

  -- ── state penampung (skema V2) ──────────────────────────────────────────
  INSERT INTO penampung_states (id_meja, status_lock, lock_alasan, lock_sejak, mode_pemeliharaan,
                                kejadian_dosis_hari, volume_ab_hari_ml, volume_ph_hari_ml, target_ec_ppm, target_ph, reset_harian_pada)
  VALUES
    (m1, false, NULL, NULL, false, 2, 180, 0,   900, 6.0, date_trunc('day', now())),
    (m2, true,  'Retry EC habis (5x)', now()-interval '2 hours', false, 5, 410, 20, 800, 6.0, date_trunc('day', now())),
    (m3, false, NULL, NULL, true,  0, 0,   0,   1000, 6.2, date_trunc('day', now())),
    (m4, false, NULL, NULL, false, 7, 470, 90,  850, 6.0, date_trunc('day', now()))
  ON CONFLICT (id_meja) DO NOTHING;

  RAISE NOTICE 'Data palsu dibuat: meja %,%,%,%', m1, m2, m3, m4;
END $$;

-- ── CCTV: 2 snapshot hidup (foto acak), 1 putus, 1 nonaktif ──────────────────
INSERT INTO cctv_kameras (nama, lokasi, tipe, url, interval_detik, aktif)
SELECT * FROM (VALUES
  ('DEMO Greenhouse A', 'Greenhouse', 'snapshot', 'https://picsum.photos/seed/garap-gh/640/360', 5, true),
  ('DEMO Nursery',      'Nursery',    'snapshot', 'https://picsum.photos/seed/garap-nursery/640/360', 10, true),
  ('DEMO Tandon (putus)','Tandon',    'mjpeg',    'http://127.0.0.1:9/stream', 5, true),
  ('DEMO Pintu (mati)', 'Pintu',      'snapshot', 'https://picsum.photos/seed/garap-pintu/640/360', 5, false)
) v(nama, lokasi, tipe, url, interval_detik, aktif)
WHERE NOT EXISTS (SELECT 1 FROM cctv_kameras WHERE nama LIKE 'DEMO %');
