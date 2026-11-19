'use strict';
/**
 * Rute IoT Hidroponik 1 Penampung v4.1 — mount: app.use('/iot-v41', iotV41).
 *
 * Menyatukan fitur dari rancangan IoT Engineering v4.1 (Perancangan_Sistem_v4.1.md,
 * Wiring_Sistem_v2.0.md, Kontrak_MQTT_Hidro_Control.docx) ke dalam arsitektur Vertonik:
 *  - GET  /iot-v41/state               status saklar, mode isi, float bawah/atas, hitungan harian,
 *                                      pengaturan alat, sirkulasi (T_putar), laju pompa, uji lab,
 *                                      mode pemeliharaan, kestabilan 5 bacaan terakhir, & arsip
 *  - PUT  /iot-v41/saklar              ubah 4 saklar izin tindakan + mode isi air (manual/otomatis)
 *  - PUT  /iot-v41/pengaturan          ubah volume, talang, debit, waktu kerja, persen dosing, batas aman
 *  - POST /iot-v41/ujilab              hitung & simpan hasil Uji Lab EC (ppm_per_ml) / pH (mL/pH/L)
 *  - POST /iot-v41/pemeliharaan        aktifkan/matikan mode pemeliharaan (halaman Kuras sudah dihapus)
 *  - POST /iot-v41/kalibrasi-pompa     catat laju pompa (a, b, ph_up, ph_down) dari hasil takar gelas ukur
 *  - POST /iot-v41/kalibrasi-dua-titik catat kalibrasi 2 titik EC (1413 & 12880 µS/cm) / pH (4,0 & 7,0)
 *                                      atau balik ke kalibrasi sebelumnya
 *  - POST /iot-v41/pulihkan            kirim paket pemulihan parameter + 6 arsip kalibrasi ke papan BARU
 *  - POST /iot-v41/jadwal-alat         kirim jadwal operasi (timing_operasi) ke ESP32 → disimpan di NVS (bukan aktuasi)
 */
const express = require('express');
const { q, one, pool } = require('../db');
const aktuator = require('../aktuator');
const config = require('../config');
const teganganPh = require('../teganganPh');
const saklarSvc = require('../saklar');
const { SENSOR_BASI_DETIK } = require('../sanitySensor');
const { requireAuth, requireRole, demoGuard, json } = require('../auth');
const {
  BAWAAN_V41,
  hitungSirkulasi,
  hitungBatasMlPh,
  hitungUjiLabEc,
  hitungUjiLabPh,
  hitungLajuPompa,
  hitungPratinjauDosis,
  cekStabilitasSensor,
  deteksiAirDiganti,
} = require('../iotV41');

const router = express.Router();

/** Baca status setup penampung — boleh dibaca semua peran login agar gerbang pasca-login seragam. */
router.get('/setup-status', requireAuth, requireRole('all'), async (req, res, next) => {
  try {
    const rawId = req.query.id_meja;
    const idMeja = rawId != null && /^[0-9]{1,12}$/.test(String(rawId))
      ? Number(rawId)
      : (await one('SELECT id_meja FROM mejas ORDER BY id_meja LIMIT 1'))?.id_meja ?? 1;
    const row = await one(
      'SELECT id_meja, setup_selesai, setup_selesai_pada, setup_progres, updated_at FROM penampung_states WHERE id_meja = $1',
      [idMeja],
    ).catch((e) => {
      if (e && e.code === '42703') return null; // kolom belum dimigrasi
      throw e;
    });
    return res.json({
      id_meja: idMeja,
      setup_selesai: Boolean(row?.setup_selesai),
      setup_selesai_pada: row?.setup_selesai_pada ?? null,
      setup_progres: row?.setup_progres && typeof row.setup_progres === 'object' ? row.setup_progres : {},
      updated_at: row?.updated_at ?? null,
      sumber: row ? 'penampung_states' : 'default',
    });
  } catch (e) { next(e); }
});

router.use(requireAuth, requireRole(['admin', 'demo']));

const writeGuard = [requireRole(['admin']), demoGuard('iot_v41.write')];

/** Simpan progres atau penyelesaian setup wizard penampung (admin only, lintas perangkat). */
router.put('/setup-status', ...writeGuard, async (req, res, next) => {
  try {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const idMeja = Number.isInteger(Number(b.id_meja)) && Number(b.id_meja) >= 1
      ? Number(b.id_meja)
      : (await one('SELECT id_meja FROM mejas ORDER BY id_meja LIMIT 1'))?.id_meja ?? 1;
    const selesai = Boolean(b.setup_selesai);
    const progres = b.setup_progres && typeof b.setup_progres === 'object' && !Array.isArray(b.setup_progres)
      ? b.setup_progres
      : {};
    await q('INSERT INTO penampung_states (id_meja) VALUES ($1) ON CONFLICT (id_meja) DO NOTHING', [idMeja]);
    const row = await one(
      `UPDATE penampung_states
          SET setup_selesai = $2,
              setup_selesai_pada = CASE WHEN $2 THEN COALESCE(setup_selesai_pada, now()) ELSE setup_selesai_pada END,
              setup_progres = $3::jsonb,
              updated_at = now()
        WHERE id_meja = $1
        RETURNING id_meja, setup_selesai, setup_selesai_pada, setup_progres, updated_at`,
      [idMeja, selesai, JSON.stringify(progres)],
    );
    return res.json({ status: true, ...row });
  } catch (e) { next(e); }
});

/** Simpan atau perbarui satu baris parameter di konfigurasi_dosis / timing_operasi. */
async function simpanParam(runner, tabel, param, nilai, satuan, keterangan) {
  await runner(
    `INSERT INTO ${tabel} (param, nilai, satuan, keterangan, sumber, diubah_pada)
     VALUES ($1, $2, $3, $4, 'Aplikasi Web v4.1', CURRENT_TIMESTAMP)
     ON CONFLICT (param) DO UPDATE
       SET nilai = EXCLUDED.nilai, diubah_pada = CURRENT_TIMESTAMP`,
    [param, nilai, satuan, keterangan],
  );
}

/** Baca peta parameter dari konfigurasi_dosis & timing_operasi dengan cadangan BAWAAN_V41. */
async function muatKonfigV41(runner = q) {
  const [dosisRows, timingRows] = await Promise.all([
    runner('SELECT param, nilai FROM konfigurasi_dosis', []).catch(() => []),
    runner('SELECT param, nilai FROM timing_operasi', []).catch(() => []),
  ]);
  const peta = {};
  // NULL = belum diputuskan: JANGAN dibaca sebagai 0 (dulu Number(null) = 0 menyamarkan parameter kosong).
  for (const r of dosisRows.rows ?? dosisRows) {
    if (r.nilai !== null && r.nilai !== undefined) peta[r.param] = Number(r.nilai);
  }
  for (const r of timingRows.rows ?? timingRows) {
    if (r.nilai !== null && r.nilai !== undefined) peta[r.param] = Number(r.nilai);
  }
  const belumDiatur = new Set();
  const ambil = (kunciDb, kunciBawaan, bulat = false) => {
    const v = peta[kunciDb];
    if (!Number.isFinite(v)) belumDiatur.add(kunciBawaan);
    const pakai = Number.isFinite(v) ? v : BAWAAN_V41[kunciBawaan];
    return bulat ? Math.round(pakai) : pakai;
  };

  const volume_l = ambil('volume_efektif_l', 'volume_l', true);
  const talang_jumlah = ambil('jumlah_talang', 'talang_jumlah', true);
  const talang_debit = ambil('debit_per_talang_lpm', 'talang_debit', false);
  const ph_maks_ml = ambil('ph_maks_ml', 'ph_maks_ml', true);
  const sirkulasi = hitungSirkulasi({ volume_l, talang_jumlah, talang_debit });
  const peta_saklar = Object.fromEntries((await saklarSvc.daftar(runner)).map((r) => [r.kode, r.aktif]));

  return {
    volume_l,
    talang_jumlah,
    talang_debit,
    putaran_menit: sirkulasi.putaran_menit,
    saran_monitoring_menit: sirkulasi.saran_monitoring_menit,
    saran_jeda_ab_menit: sirkulasi.saran_jeda_ab_menit,
    monitoring_menit: ambil('monitoring_menit', 'monitoring_menit', true),
    jeda_ab_menit: ambil('jeda_ab_menit', 'jeda_ab_menit', true),
    jeda_ec_menit: ambil('jeda_ec_menit', 'jeda_ec_menit', true),
    persen_dosing: ambil('persen_ronde_dosis', 'persen_dosing', true),
    max_ppm_dosing: ambil('maks_ppm_per_suntikan', 'max_ppm_dosing', true),
    batas_ec_bawah: ambil('batas_ec_bawah_ppm', 'batas_ec_bawah', true),
    batas_ec_atas: ambil('batas_ec_atas_ppm', 'batas_ec_atas', true),
    batas_ph_bawah: ambil('batas_ph_bawah', 'batas_ph_bawah', false),
    batas_ph_atas: ambil('batas_ph_atas', 'batas_ph_atas', false),
    ph_maks_ml,
    batas_ml_ph_efektif: hitungBatasMlPh({ ph_maks_ml, volume_l }),
    pemeliharaan_maks_menit: ambil('pemeliharaan_maks_menit', 'pemeliharaan_maks_menit', true),
    // sumber kebenaran saklar = tabel saklar_aktuator (bukan konfigurasi_dosis)
    saklar_ab: peta_saklar.nutrisi_ab ? 1 : 0,
    saklar_ph_up: peta_saklar.ph_up ? 1 : 0,
    saklar_ph_down: peta_saklar.ph_down ? 1 : 0,
    saklar_pengenceran: peta_saklar.pengenceran ? 1 : 0,
    mode_isi: ambil('mode_isi_otomatis', 'mode_isi_otomatis', true) ? 'otomatis' : 'manual',
    ppm_per_ml: ambil('ppm_per_ml', 'ppm_per_ml', false),
    ph_up_ml: ambil('ph_up_ml_per_ph_l', 'ph_up_ml', false),
    ph_down_ml: ambil('ph_down_ml_per_ph_l', 'ph_down_ml', false),
    laju_a: ambil('laju_pompa_a_mls', 'laju_a', false),
    laju_b: ambil('laju_pompa_b_mls', 'laju_b', false),
    laju_ph_up: ambil('laju_pompa_ph_up_mls', 'laju_ph_up', false),
    laju_ph_down: ambil('laju_pompa_ph_down_mls', 'laju_ph_down', false),
    maks_ec_hari: ambil('maks_penjagaan_ec_hari', 'maks_ec_hari', true),
    maks_encer_hari: ambil('maks_pengenceran_hari', 'maks_encer_hari', true),
    maks_ph_hari: ambil('maks_koreksi_ph_hari', 'maks_ph_hari', true),
    _pemeliharaan_param: peta.mode_pemeliharaan_v41 === 1,
    _hit_ec_param: Number.isFinite(peta.hit_ec_hari_v41) ? Math.round(peta.hit_ec_hari_v41) : 0,
    _vol_ph_param: Number.isFinite(peta.vol_ph_hari_v41) ? Number(peta.vol_ph_hari_v41) : 0,
    // kunci yang TIDAK ada di database → nilainya bawaan kode, bukan pengaturan tersimpan (ditandai di web)
    _belum_diatur: [...belumDiatur],
  };
}

router.get('/state', async (_req, res, next) => {
  try {
    const [rawParams, states, bacaan5, perangkatRows, arsipKal, wc, jadwalAlat] = await Promise.all([
      muatKonfigV41(q),
      q('SELECT * FROM penampung_states ORDER BY id_meja LIMIT 5').catch(() => []),
      // Kolom monitorings bernama "waterTemp"/"airTemp" — dulu query memakai water_temp/air_temp, gagal, lalu .catch
      // menelannya sehingga EC/pH di halaman v4.1 selalu 0. Galat kini tidak disembunyikan.
      q(`SELECT ph, tds, ec_ms_cm, "waterTemp" AS water_temp, "airTemp" AS air_temp, humidity, created_at,
                COALESCE(updated_at, created_at) AS dikonfirmasi_pada
           FROM monitorings ORDER BY created_at DESC, id DESC LIMIT 5`),
      q(`SELECT kode, nama, peran, versi_firmware, terakhir_terlihat, estop_aktif,
                float_bawah_rendah, float_atas_penuh, level_diperbarui_pada
           FROM perangkat ORDER BY kode`),
      q('SELECT id, sensor, dilakukan_pada, nilai_ref, bacaan_sebelum, bacaan_sesudah, lulus, konstanta_lama, konstanta_baru, catatan, oleh_label FROM kalibrasi_log ORDER BY dilakukan_pada DESC, id DESC LIMIT 12').catch(() => []),
      one('SELECT * FROM water_controls ORDER BY id LIMIT 1').catch(() => null),
      one(`SELECT id, status, parameter, hasil, dibuat_pada, selesai_pada FROM perintah_aktuator
            WHERE tipe = 'JADWAL' ORDER BY dibuat_pada DESC, id DESC LIMIT 1`),
    ]);

    const { _pemeliharaan_param, _hit_ec_param, _vol_ph_param, _belum_diatur, ...params } = rawParams;
    const stUtama = states[0] || {};
    const pemeliharaan = states.length > 0 ? states.some((s) => s.mode_pemeliharaan === true) : Boolean(_pemeliharaan_param);
    const terkunci = states.some((s) => s.status_lock === true);
    const alasanKunci = states.find((s) => s.lock_alasan)?.lock_alasan || null;

    const targetEc = Number(stUtama.target_ec_ppm) || 0;
    const targetPh = Number(stUtama.target_ph) || 6.0;

    const terbaru = bacaan5[0] || null;
    const terlama = bacaan5[bacaan5.length - 1] || null;
    // Bacaan basi (> SENSOR_BASI_DETIK) atau tidak dikirim = null, BUKAN 0: angka nol akan terbaca sebagai larutan kosong.
    const umurDetik = terbaru ? Math.round((Date.now() - new Date(terbaru.dikonfirmasi_pada).getTime()) / 1000) : null;
    const segar = umurDetik != null && umurDetik <= SENSOR_BASI_DETIK;
    const ecSekarang = segar && terbaru.tds != null ? Math.round(Number(terbaru.tds)) : null;
    // ESP32 hanya mengirim TDS (ppm, skala 500). EC mS/cm dihitung dari TDS kecuali kolom ec_ms_cm terisi.
    const ecMsSekarang = !segar ? null
      : terbaru.ec_ms_cm != null ? Number(terbaru.ec_ms_cm)
        : ecSekarang != null ? Math.round((ecSekarang / 500) * 100) / 100 : null;
    const ecUsSekarang = ecMsSekarang != null ? Math.round(ecMsSekarang * 1000) : null;
    const phSekarang = segar && terbaru.ph != null ? Number(terbaru.ph) : null;

    const daftarEcPpm = bacaan5.map((b) => (b.tds != null ? Number(b.tds) : NaN));
    const daftarEcUs = bacaan5.map((b) => (b.ec_ms_cm != null ? Number(b.ec_ms_cm) * 1000 : b.tds != null ? Number(b.tds) * 2 : NaN));
    const daftarPh = bacaan5.map((b) => (b.ph != null ? Number(b.ph) : NaN));

    // Data basi tidak boleh tampil "stabil — siap diambil": kestabilan hanya dinilai dari bacaan segar.
    const kosong5 = bacaan5.map(() => NaN);
    const stabilEc = cekStabilitasSensor(segar ? daftarEcPpm : kosong5, 'ec_ppm');
    const stabilEcUs = cekStabilitasSensor(segar ? daftarEcUs : kosong5, 'ec_us');
    const stabilPh = cekStabilitasSensor(segar ? daftarPh : kosong5, 'ph');

    const cekGantiAir = deteksiAirDiganti({
      ec_lama_ppm: terlama?.tds,
      ec_baru_ppm: terbaru?.tds,
      sedang_isi_atau_encer: wc?.valve_state === 'OPEN',
    });

    const hitEc = states.length > 0
      ? states.reduce((a, s) => a + (Number(s.kejadian_dosis_hari) || 0), 0)
      : _hit_ec_param;
    const hitEncer = 0;
    const volPhHari = states.length > 0
      ? states.reduce((a, s) => a + (Number(s.volume_ph_hari_ml) || 0), 0)
      : _vol_ph_param;
    const hitPh = volPhHari > 0 ? Math.min(5, Math.ceil(volPhHari / Math.max(1, params.batas_ml_ph_efektif))) : 0;

    const pratinjau = hitungPratinjauDosis({
      ec_sekarang: ecSekarang ?? 0,
      ec_setpoint: targetEc,
      persen_dosing: params.persen_dosing,
      max_ppm_dosing: params.max_ppm_dosing,
      volume_l: params.volume_l,
      ppm_per_ml: params.ppm_per_ml,
      laju_a: params.laju_a,
      laju_b: params.laju_b,
    });

    const papanUtama = perangkatRows.find((p) => p.peran === 'aktuator' || p.peran === 'gabungan') || perangkatRows[0] || null;
    const online = papanUtama?.terakhir_terlihat
      ? Date.now() - new Date(papanUtama.terakhir_terlihat).getTime() < 120_000
      : false;
    const statusPapan = !papanUtama
      ? 'offline'
      : !papanUtama.versi_firmware && !papanUtama.terakhir_terlihat
        ? 'BARU'
        : online ? 'online' : 'offline';

    const arsipUjiLab = arsipKal.filter((a) => a.catatan && a.catatan.startsWith('[UJI LAB'));
    const takaranBuah = Object.fromEntries((await q(
      "SELECT param, nilai FROM konfigurasi_dosis WHERE param IN ('ppm_per_ml_buah','ph_up_ml_per_ph_l_buah','ph_down_ml_per_ph_l_buah')", []))
      .map((r) => [r.param, r.nilai === null ? null : Number(r.nilai)]));

    // izin otomasi yang DILAPORKAN alat (bukti saklar sampai ke alat); null = alat belum melapor
    const { keadaanAlat: keadaanV6 } = await require('../keadaanAlat').bacaKeadaanAlat(null);
    res.json({
      otomasi_alat: keadaanV6.otomasi,
      params_belum_diatur: _belum_diatur,
      // Bukti jadwal di NVS ESP32 = perintah JADWAL terakhir berstatus 'selesai' (laporan alat), bukan isi database.
      jadwal_alat: jadwalAlat ?? null,
      params: {
        ...params,
        ec_setpoint: targetEc,
        ph_setpoint: targetPh,
        pemeliharaan,
        tahan_dosing: terkunci || cekGantiAir.terdeteksi,
        tahan_alasan: alasanKunci || (cekGantiAir.terdeteksi
          ? `Terdeteksi EC turun ${cekGantiAir.turun_ppm} ppm (${cekGantiAir.turun_persen}%). Konfirmasi bila air baru diganti.`
          : null),
      },
      kondisi: {
        status: pemeliharaan ? 'PEMELIHARAAN' : terkunci ? 'PERINGATAN' : targetEc === 0 ? 'TIDUR' : 'NORMAL',
        // Pelampung dari laporan ESP32 (perangkat.float_*); null = belum pernah dilaporkan. Dulu ditebak dari katup.
        float_bawah: papanUtama?.float_bawah_rendah == null ? null : (papanUtama.float_bawah_rendah ? 0 : 1),
        float_atas: papanUtama?.float_atas_penuh == null ? null : (papanUtama.float_atas_penuh ? 1 : 0),
        level_diperbarui_pada: papanUtama?.level_diperbarui_pada ?? null,
        ec_ppm: ecSekarang,
        ec_ms: ecMsSekarang,
        ec_us: ecUsSekarang,
        ph: phSekarang,
        ph_volt: teganganPh.terbaru(),
        suhu_air: segar ? terbaru.water_temp ?? null : null,
        suhu_ruang: segar ? terbaru.air_temp ?? null : null,
        rh: segar ? terbaru.humidity ?? null : null,
        umur_detik: umurDetik,
        basi: !segar,
        hit_ec: hitEc,
        hit_encer: hitEncer,
        hit_ph: hitPh,
        hit_isi: 0,
        updated_at: terbaru?.dikonfirmasi_pada ?? null,
      },
      stabilitas: {
        ec: { ...stabilEc, sebaran_us: stabilEcUs.sebaran },
        ph: stabilPh,
      },
      pratinjau_dosis: pratinjau,
      papan: {
        kode: papanUtama?.kode ?? 'HIDRO-01',
        nama: papanUtama?.nama ?? 'Kontroler Utama 1-Penampung',
        versi: papanUtama?.versi_firmware ?? 'v4.1',
        terakhir_terlihat: papanUtama?.terakhir_terlihat ?? null,
        status: statusPapan,
      },
      arsip_kalibrasi: arsipKal,
      arsip_ujilab: arsipUjiLab,
      takaran_buah: {
        ppm_per_ml: takaranBuah.ppm_per_ml_buah ?? null,
        ph_up_ml: takaranBuah.ph_up_ml_per_ph_l_buah ?? null,
        ph_down_ml: takaranBuah.ph_down_ml_per_ph_l_buah ?? null,
      },
    });
  } catch (e) { next(e); }
});

router.put('/saklar', ...writeGuard, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const mode_isi = b.mode_isi === 'manual' || b.mode_isi_otomatis === false || b.mode_isi_otomatis === 0 ? 'manual' : 'otomatis';
    const modeAngka = mode_isi === 'otomatis' ? 1 : 0;

    await client.query('BEGIN');
    const run = (t, p) => client.query(t, p);
    const uid = Number(req.user.sub) || null;
    const sebelum = {};
    const sesudah = {};
    // hanya kunci yang dikirim yang diubah (body parsial tidak mematikan saklar lain)
    const diminta = [['nutrisi_ab', b.saklar_ab], ['ph_up', b.saklar_ph_up], ['ph_down', b.saklar_ph_down], ['pengenceran', b.saklar_pengenceran]]
      .filter(([, v]) => v !== undefined);
    if (b.mode_isi !== undefined || b.mode_isi_otomatis !== undefined) diminta.push(['isi_air', modeAngka]);
    for (const [kode, nilai] of diminta) {
      const aktif = Boolean(nilai);
      const r = await saklarSvc.ubah(kode, aktif, uid, run);
      if (r) { sebelum[kode] = r.sebelum.aktif; sesudah[kode] = r.sesudah.aktif; }
    }
    if (b.mode_isi !== undefined || b.mode_isi_otomatis !== undefined) await simpanParam(run, 'konfigurasi_dosis', 'mode_isi_otomatis', modeAngka, 'status', 'Mode pengisian air otomatis');
    req.audit = { aksi: 'config_change', tabel: 'saklar_aktuator', row_id: 'semua', before: sebelum, after: { ...sesudah, mode_isi }, meta: { dari: sebelum, ke: sesudah } };
    await client.query('COMMIT');

    const params = await muatKonfigV41(q);
    // saklar ke alat: alat berhenti/mulai menyalakan aktuator itu sendiri (firmware v6 perintah OTOMASI)
    const S = require('../sinkronAlat');
    const kirim = await S.diam(S.kirimOtomasi, uid);
    res.json({
      status: true,
      message: kirim.dikirim
        ? 'Saklar disimpan dan dikirim ke alat; tunggu alat menjawab.'
        : 'Saklar disimpan di sistem, tetapi belum bisa dikirim ke alat (belum ada alat terdaftar / perintah sebelumnya masih menunggu).',
      data: params,
      kirim_alat: { dikirim: Boolean(kirim.dikirim), ket: kirim.ket ?? null },
    });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    next(e);
  } finally {
    client.release();
  }
});

router.put('/pengaturan', ...writeGuard, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const err = {};
    // Sebagian (PATCH-gaya): hanya kunci yang dikirim divalidasi & disimpan. Web kini hanya mengirim penampung &
    // waktu kerja (batas aman/dosis dipindah ke Parameter & Keamanan); klien lama yang mengirim semua tetap sah.
    const KOLOM = [
      ['volume_l', 0, 50000, true, 'konfigurasi_dosis', 'volume_efektif_l', 'L', 'Volume efektif penampung portable'],
      ['talang_jumlah', 0, 500, true, 'konfigurasi_dosis', 'jumlah_talang', 'talang', 'Jumlah talang meja'],
      ['talang_debit', 0, 100, false, 'konfigurasi_dosis', 'debit_per_talang_lpm', 'L/menit', 'Debit aliran per talang'],
      ['persen_dosing', 50, 90, true, 'konfigurasi_dosis', 'persen_ronde_dosis', '%', 'Dosis per ronde = persen dari kekurangan'],
      ['max_ppm_dosing', 50, 300, true, 'konfigurasi_dosis', 'maks_ppm_per_suntikan', 'ppm', 'Batas kenaikan EC per suntikan'],
      ['batas_ec_bawah', 0, 5000, true, 'konfigurasi_dosis', 'batas_ec_bawah_ppm', 'ppm', 'Batas aman EC bawah'],
      ['batas_ec_atas', 0, 5000, true, 'konfigurasi_dosis', 'batas_ec_atas_ppm', 'ppm', 'Batas aman EC atas'],
      ['batas_ph_bawah', 3, 9, false, 'konfigurasi_dosis', 'batas_ph_bawah', 'pH', 'Batas aman pH bawah'],
      ['batas_ph_atas', 3, 9, false, 'konfigurasi_dosis', 'batas_ph_atas', 'pH', 'Batas aman pH atas'],
      ['ph_maks_ml', 0, 200, true, 'konfigurasi_dosis', 'ph_maks_ml', 'mL', 'Batas mL per koreksi pH'],
      ['monitoring_menit', 10, 120, true, 'timing_operasi', 'monitoring_menit', 'menit', 'Waktu tunggu larutan berputar merata sebelum baca ulang'],
      ['jeda_ab_menit', 1, 10, true, 'timing_operasi', 'jeda_ab_menit', 'menit', 'Jeda aman antara suntikan Pompa A dan Pompa B'],
      ['jeda_ec_menit', 1, 240, true, 'timing_operasi', 'jeda_ec_menit', 'menit', 'Jeda tenang antar tindakan penjagaan EC'],
      ['pemeliharaan_maks_menit', 5, 360, true, 'timing_operasi', 'pemeliharaan_maks_menit', 'menit', 'Batas waktu otomatis mode pemeliharaan'],
    ];
    const nilai = {};
    for (const [k, min, max, bulat] of KOLOM) {
      if (b[k] === undefined) continue;
      const v = Number(b[k]);
      if (b[k] === null || b[k] === '' || !Number.isFinite(v) || v < min || v > max || (bulat && !Number.isInteger(v))) {
        err[k] = [`Nilai ${k} harus angka ${bulat ? 'bulat ' : ''}${min}–${max}.`];
      } else nilai[k] = v;
    }
    if (!Object.keys(nilai).length && !Object.keys(err).length) err.pengaturan = ['Tidak ada pengaturan yang dikirim.'];
    if (nilai.batas_ec_bawah != null && nilai.batas_ec_atas != null && nilai.batas_ec_atas > 0 && nilai.batas_ec_bawah > nilai.batas_ec_atas) {
      err.batas_ec_bawah = ['Batas aman EC bawah tidak boleh melebihi batas atas.'];
    }
    if (nilai.batas_ph_bawah != null && nilai.batas_ph_atas != null && nilai.batas_ph_bawah >= nilai.batas_ph_atas) {
      err.batas_ph_bawah = ['Batas pH bawah harus lebih kecil dari batas pH atas.'];
    }
    if (Object.keys(err).length) {
      return json(res, 422, { message: 'Data tidak valid.', errors: err });
    }

    await client.query('BEGIN');
    const run = (t, p) => client.query(t, p);
    for (const [k, , , , tabel, param, satuan, ket] of KOLOM) {
      if (k in nilai) await simpanParam(run, tabel, param, nilai[k], satuan, ket);
    }
    await client.query('COMMIT');

    const params = await muatKonfigV41(q);
    res.json({
      status: true,
      message: 'Pengaturan alat disimpan dan disinkronkan.',
      data: params,
    });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    next(e);
  } finally {
    client.release();
  }
});

router.post('/ujilab', ...writeGuard, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const jenis = String(b.aksi || b.jenis || 'ec').toLowerCase();
    // takaran dipisah per kategori: 'tanaman' (bawaan, kunci lama) dan 'buah' (kunci berakhiran _buah)
    const buah = String(b.kategori || 'tanaman').toLowerCase() === 'buah';
    const sfx = buah ? '_buah' : '';
    const tag = buah ? ' BUAH' : '';

    if (jenis === 'ec') {
      const hasil = hitungUjiLabEc(b);
      if (!hasil.ok) return json(res, 422, { message: 'Data uji lab EC tidak valid.', errors: hasil.errors });

      await client.query('BEGIN');
      const run = (t, p) => client.query(t, p);
      await simpanParam(run, 'konfigurasi_dosis', `ppm_per_ml${sfx}`, hasil.ppm_per_ml, 'ppm/mL', `Kenaikan EC per mL hasil Uji Lab EC${tag.toLowerCase()}`);
      const catatan = `[UJI LAB EC${tag}] Air ${hasil.volume} L, awal ${hasil.awal} -> akhir ${hasil.akhir} ppm (A ${hasil.ml_a} mL + B ${hasil.ml_b} mL) = ${hasil.ppm_per_ml} ppm/mL`;
      await client.query(
        `INSERT INTO kalibrasi_log (sensor, nilai_ref, bacaan_sebelum, bacaan_sesudah, lulus, konstanta_baru, catatan, oleh_user_id, oleh_label)
         VALUES ('ec', $1, $2, $3, true, $4, $5, $6, $7)`,
        [hasil.ppm_per_ml, hasil.awal, hasil.akhir, JSON.stringify({ PPM_PER_ML: hasil.ppm_per_ml }), catatan, Number(req.user.sub) || null, req.user.username || null],
      ).catch(() => {});
      await client.query('COMMIT');

      return res.status(201).json({
        status: true,
        message: `Hasil Uji Lab EC${tag.toLowerCase()} disimpan: ${String(hasil.ppm_per_ml).replace('.', ',')} ppm/mL.`,
        data: hasil,
      });
    }

    if (jenis === 'ph') {
      const hasil = hitungUjiLabPh(b);
      if (!hasil.ok) return json(res, 422, { message: 'Data uji lab pH tidak valid.', errors: hasil.errors });

      await client.query('BEGIN');
      const run = (t, p) => client.query(t, p);
      await simpanParam(
        run,
        'konfigurasi_dosis',
        `${hasil.param}${sfx}`,
        hasil.ml_per_ph_l,
        'mL/pH/L',
        `Takaran pH ${hasil.arah} per 1 pH per 1 L hasil Uji Lab pH${tag.toLowerCase()}`,
      );
      const catatan = `[UJI LAB PH ${hasil.arah.toUpperCase()}${tag}] Air ${hasil.volume} L, delta pH ${hasil.delta_ph}, larutan ${hasil.ml} mL = ${hasil.ml_per_ph_l} mL/pH/L`;
      await client.query(
        `INSERT INTO kalibrasi_log (sensor, nilai_ref, bacaan_sesudah, lulus, konstanta_baru, catatan, oleh_user_id, oleh_label)
         VALUES ('ph', $1, $2, true, $3, $4, $5, $6)`,
        [hasil.delta_ph, hasil.ml_per_ph_l, JSON.stringify({ [hasil.param.toUpperCase()]: hasil.ml_per_ph_l }), catatan, Number(req.user.sub) || null, req.user.username || null],
      ).catch(() => {});
      await client.query('COMMIT');

      return res.status(201).json({
        status: true,
        message: `Hasil Uji Lab pH ${hasil.arah}${tag.toLowerCase()} disimpan: ${String(hasil.ml_per_ph_l).replace('.', ',')} mL per 1 pH per 1 L.`,
        data: hasil,
      });
    }

    return json(res, 422, { message: 'Jenis uji lab harus ec atau ph.', errors: { jenis: ['Pilih ec atau ph.'] } });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    next(e);
  } finally {
    client.release();
  }
});

router.post('/pemeliharaan', ...writeGuard, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const aksi = String(b.aksi || 'pemeliharaan').toLowerCase();

    await client.query('BEGIN');
    const run = (t, p) => client.query(t, p);
    await client.query('INSERT INTO penampung_states (id_meja) SELECT id_meja FROM mejas ORDER BY id_meja LIMIT 1 ON CONFLICT (id_meja) DO NOTHING');
    if (aksi !== 'pemeliharaan') {
      await client.query('ROLLBACK');
      return json(res, 422, { message: 'Aksi tidak dikenal.', errors: { aksi: ['Hanya aksi pemeliharaan (aktif true/false) yang tersedia.'] } });
    }

    const aktif = Boolean(b.aktif);
    await client.query('UPDATE penampung_states SET mode_pemeliharaan = $1, updated_at = CURRENT_TIMESTAMP', [aktif]);
    await simpanParam(run, 'konfigurasi_dosis', 'mode_pemeliharaan_v41', aktif ? 1 : 0, 'bool', 'Status mode pemeliharaan v4.1');
    await client.query('COMMIT');
    const alat = await kirimKeAlat(req, {
      tipe: 'PEMELIHARAAN',
      parameter: { aksi: aktif ? 'MULAI' : 'SELESAI' },
      alasan: aktif ? 'Aktifkan mode pemeliharaan dari web' : 'Matikan mode pemeliharaan dari web',
    });
    return res.json({
      status: true,
      pemeliharaan: aktif,
      id_perintah: alat.id,
      message: aktif
        ? `Mode pemeliharaan disimpan di server; perintah PEMELIHARAAN (MULAI) ${alat.ket}.`
        : `Mode pemeliharaan dimatikan di server; perintah PEMELIHARAAN (SELESAI) ${alat.ket}.`,
    });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    next(e);
  } finally {
    client.release();
  }
});

/** Antre perintah kalibrasi ke alat (disimpan di NVS ESP32). Gagal antre tidak membatalkan simpanan server. */
async function kirimKeAlat(req, perintah) {
  try {
    const p = await aktuator.buatPerintah({ ...perintah, sumber: 'pengguna', userId: Number(req.user.sub) || null, ttlDetik: 600 });
    return { id: p.id, ket: 'dikirim ke alat, menunggu konfirmasi alat' };
  } catch (e) {
    if (!(e && e.status)) throw e;
    return { id: null, ket: `BELUM dikirim ke alat (${e.message})` };
  }
}

/**
 * Uji pompa untuk kalibrasi laju: pompa SUNGGUHAN menyala `detik` detik. Bukan DOSIS (gerbang dosis tidak disentuh).
 * Pagar: UJI_POMPA_DIIZINKAN=1 di .env, admin, mode pemeliharaan aktif, satu uji pada satu waktu, E-STOP menolak.
 * Balasan 202 = diantre, BUKAN pompa sudah jalan; hasil datang dari alat (GET /api/aktuator/perintah).
 */
/** Riwayat lengkap kalibrasi pH, EC, dan laju pompa (terbaru dulu). */
router.get('/riwayat-kalibrasi', async (_req, res, next) => {
  try {
    res.json(await q(
      `SELECT id, sensor, dilakukan_pada, nilai_ref, bacaan_sebelum, bacaan_sesudah, lulus, konstanta_baru, catatan, oleh_label
         FROM kalibrasi_log WHERE sensor = ANY($1::text[]) ORDER BY dilakukan_pada DESC, id DESC LIMIT 200`,
      [['ph', 'ec', 'pulsa_peristaltik']]));
  } catch (e) { next(e); }
});

/** Mode pemeliharaan aktif menurut alat (v6) atau penampung (lama). */
async function pemeliharaanAktif() {
  const { keadaanAlat } = await require('../keadaanAlat').bacaKeadaanAlat(null);
  if (keadaanAlat.pemeliharaan === true) return true;
  return (await q('SELECT 1 FROM penampung_states WHERE mode_pemeliharaan LIMIT 1', [])).length > 0;
}

/**
 * Kalibrasi pH/EC firmware v6 (Kontrak MQTT: KAL_SENSOR). Alat mengukur tegangan probe sendiri (UKUR), lalu menyimpannya (SIMPAN)
 * dengan acuan bawaan (pH 4,01 / 6,86; EC 1,413 / 12,88 mS/cm dengan kompensasi suhu). Titik 1 lalu titik 2.
 * Balasan 202 = diantre; hasil (tegangan, acuan) datang dari alat lewat /api/aktuator/perintah.
 */
router.post('/kal-sensor', ...writeGuard, async (req, res, next) => {
  try {
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    if (String(b.aksi).toUpperCase() !== 'BATAL' && !(await pemeliharaanAktif())) {
      return json(res, 409, { kode: 'bukan_pemeliharaan', message: 'Aktifkan mode pemeliharaan dulu sebelum kalibrasi sensor.' });
    }
    const alat = await kirimKeAlat(req, {
      tipe: 'KAL_SENSOR', parameter: { sensor: b.sensor, titik: b.titik, aksi: b.aksi }, alasan: `Kalibrasi ${String(b.sensor).toUpperCase()} titik ${b.titik} ${String(b.aksi).toUpperCase()}`,
    });
    if (!alat.id) return json(res, 422, { message: alat.ket });
    return res.status(202).json({ status: true, antre: true, dikonfirmasi: false, id_perintah: alat.id, message: `Perintah kalibrasi ${alat.ket}.` });
  } catch (e) { next(e); }
});

router.post('/uji-pompa', ...writeGuard, async (req, res, next) => {
  try {
    if (!config.ujiPompaDiizinkan) {
      return json(res, 423, { kode: 'uji_pompa_dikunci', message: 'Uji pompa dari aplikasi dikunci. Admin server harus mengisi UJI_POMPA_DIIZINKAN=1 di .env lalu memulai ulang layanan.' });
    }
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    if (!(await pemeliharaanAktif())) return json(res, 409, { kode: 'bukan_pemeliharaan', message: 'Aktifkan mode pemeliharaan sebelum menyalakan pompa uji.' });
    const jalan = await q("SELECT id FROM perintah_aktuator WHERE tipe = 'UJI_POMPA' AND status IN ('menunggu','dikirim') LIMIT 1", []);
    if (jalan.length) return json(res, 409, { kode: 'uji_pompa_berjalan', message: 'Masih ada uji pompa yang belum selesai. Tunggu atau tekan STOP.' });
    let perintah;
    try {
      perintah = await aktuator.buatPerintah({
        tipe: 'UJI_POMPA', parameter: { pompa: b.pompa, detik: b.detik }, sumber: 'pengguna',
        userId: Number(req.user.sub) || null, alasan: 'Uji pompa kalibrasi', ttlDetik: 60,
      });
    } catch (e) {
      if (e && e.status) return json(res, e.status, { message: e.message, ...(e.errors ? { errors: e.errors } : {}) });
      throw e;
    }
    await q(
      `INSERT INTO kalibrasi_log (sensor, lulus, catatan, oleh_user_id, oleh_label)
       VALUES ('pulsa_peristaltik', true, $1, $2, $3)`,
      [`[UJI POMPA] ${perintah.parameter.pompa} ${perintah.parameter.detik} detik diantre (id ${perintah.id})`, Number(req.user.sub) || null, req.user.username || null],
    ).catch(() => {});
    return res.status(202).json({
      status: true, antre: true, dikonfirmasi: false, id_perintah: perintah.id,
      message: `Uji pompa ${perintah.parameter.pompa} ${perintah.parameter.detik} detik masuk antrean. Pompa BELUM dipastikan jalan: tunggu laporan alat.`,
    });
  } catch (e) { next(e); }
});

router.post('/kalibrasi-pompa', ...writeGuard, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const hasil = hitungLajuPompa(req.body || {});
    if (!hasil.ok) return json(res, 422, { message: 'Data kalibrasi pompa tidak valid.', errors: hasil.errors });

    await client.query('BEGIN');
    const run = (t, p) => client.query(t, p);
    await simpanParam(
      run,
      'konfigurasi_dosis',
      hasil.param,
      hasil.laju,
      'mL/detik',
      `Laju Pompa ${hasil.pompa.toUpperCase()} (${hasil.ml} mL / ${hasil.detik} detik)`,
    );
    const catatan = `[KALIBRASI POMPA ${hasil.pompa.toUpperCase()}] Nyala ${hasil.detik} detik -> takar ${hasil.ml} mL = ${hasil.laju} mL/detik`;
    await client.query(
      `INSERT INTO kalibrasi_log (sensor, nilai_ref, bacaan_sebelum, bacaan_sesudah, lulus, konstanta_baru, catatan, oleh_user_id, oleh_label)
       VALUES ('pulsa_peristaltik', $1, $2, $3, true, $4, $5, $6, $7)`,
      [hasil.detik, hasil.ml, hasil.laju, JSON.stringify({ [hasil.param.toUpperCase()]: hasil.laju }), catatan, Number(req.user.sub) || null, req.user.username || null],
    ).catch(() => {});
    await client.query('COMMIT');

    const alat = await kirimKeAlat(req, { tipe: 'KALIBRASI', parameter: { [`laju_${hasil.pompa}`]: hasil.laju }, alasan: `Laju pompa ${hasil.pompa.toUpperCase()}` });

    return res.status(201).json({
      status: true,
      id_perintah: alat.id,
      message: `Laju Pompa ${hasil.pompa.toUpperCase()} disimpan di server: ${hasil.ml} mL ÷ ${hasil.detik} detik = ${String(hasil.laju).replace('.', ',')} mL/detik; ${alat.ket}.`,
      data: hasil,
    });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    next(e);
  } finally {
    client.release();
  }
});

router.post('/kalibrasi-dua-titik', ...writeGuard, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const sensor = String(b.sensor || '').toLowerCase();
    if (!['ec', 'ph'].includes(sensor)) {
      return json(res, 422, { message: 'Sensor harus ec atau ph.', errors: { sensor: ['Pilih ec atau ph.'] } });
    }

    await client.query('BEGIN');
    const baris = (await client.query('SELECT * FROM kalibrasi_sensor WHERE sensor = $1 FOR UPDATE', [sensor])).rows[0];

    if (b.aksi === 'balik') {
      const logTerakhir = (await client.query(
        'SELECT * FROM kalibrasi_log WHERE sensor = $1 AND konstanta_lama IS NOT NULL ORDER BY dilakukan_pada DESC, id DESC LIMIT 1',
        [sensor],
      )).rows[0];
      // Kalibrasi v6 (KAL_SENSOR) tersimpan di alat, bukan sebagai konstanta di server: alat yang punya cadangannya.
      // Konstanta server hanya dipulihkan bila ada (kalibrasi lama); selebihnya perintah tetap dikirim ke alat.
      if (logTerakhir?.konstanta_lama) {
        await client.query(
          'UPDATE kalibrasi_sensor SET konstanta = $2, terakhir_dikalibrasi = CURRENT_TIMESTAMP WHERE sensor = $1',
          [sensor, logTerakhir.konstanta_lama],
        );
      }
      await client.query(
        `INSERT INTO kalibrasi_log (sensor, konstanta_lama, konstanta_baru, lulus, catatan, oleh_user_id, oleh_label)
         VALUES ($1, $2, $3, true, 'Dikembalikan ke kalibrasi sebelumnya (balik_kalibrasi)', $4, $5)`,
        [sensor, baris?.konstanta ?? null, logTerakhir?.konstanta_lama ?? null, Number(req.user.sub) || null, req.user.username || null],
      );
      await client.query('COMMIT');
      // Alat hanya menyimpan SATU nilai lama per sensor; balik kedua kali berturut-turut tidak mundur lebih jauh di alat.
      const alat = await kirimKeAlat(req, {
        tipe: 'BALIK_KALIBRASI',
        parameter: { sensor },
        alasan: `Balik kalibrasi ${sensor.toUpperCase()}`,
      });
      return res.json({
        status: true,
        id_perintah: alat.id,
        message: `Perintah mengembalikan kalibrasi ${sensor.toUpperCase()} ke nilai sebelumnya: ${alat.ket}.`,
        data: logTerakhir?.konstanta_lama ?? null,
      });
    }

    let konstantaBaru;
    let pesanSimpan;
    let paramAlat = null;
    let alasanAlat = '';

    if (sensor === 'ec') {
      const baca1 = Number(b.baca1 ?? b.titik_1);
      const baca2 = Number(b.baca2 ?? b.titik_2);
      if (!Number.isFinite(baca1) || baca1 <= 0 || !Number.isFinite(baca2) || baca2 <= 0) {
        await client.query('ROLLBACK');
        return json(res, 422, { message: 'Kedua titik EC (1.413 µS/cm dan 12.880 µS/cm) wajib diisi.', errors: { baca1: ['Ambil titik 1.413 dan 12.880 µS/cm dulu.'] } });
      }
      // Kalikan faktor koreksi lama karena bacaan alat (ec_us) sudah memakai TDS_FAKTOR_KOREKSI aktif di NVS.
      const konstantaLamaEc = baris?.konstanta || { TDS_FAKTOR_KOREKSI: 1.0, EC_TITIK_1413: 1413, EC_TITIK_12880: 12880 };
      const faktorLamaRaw = Number(konstantaLamaEc.TDS_FAKTOR_KOREKSI);
      const faktorLama = Number.isFinite(faktorLamaRaw) && faktorLamaRaw > 0 ? faktorLamaRaw : 1.0;
      const faktor1 = 1413 / baca1;
      const faktor2 = 12880 / baca2;
      const faktorGabung = Math.round(faktorLama * ((faktor1 + faktor2) / 2) * 10000) / 10000;
      if (!Number.isFinite(faktorGabung) || faktorGabung <= 0.01 || faktorGabung > 20) {
        await client.query('ROLLBACK');
        return json(res, 422, {
          message: `Faktor koreksi EC hasil (${faktorGabung}) di luar batas aman firmware (0,01–20). Periksa probe dan larutan standar.`,
          errors: { baca1: ['Hasil rasio kalibrasi di luar rentang wajar.'] },
        });
      }
      konstantaBaru = { TDS_FAKTOR_KOREKSI: faktorGabung, EC_TITIK_1413: baca1, EC_TITIK_12880: baca2 };
      if (baris) {
        await client.query(
          'UPDATE kalibrasi_sensor SET terakhir_dikalibrasi = CURRENT_TIMESTAMP, hasil_ukur = $2, konstanta = $3 WHERE sensor = $1',
          ['ec', baca2, konstantaBaru],
        );
      }
      await client.query(
        `INSERT INTO kalibrasi_log (sensor, nilai_ref, bacaan_sebelum, bacaan_sesudah, lulus, konstanta_lama, konstanta_baru, catatan, oleh_user_id, oleh_label)
         VALUES ('ec', 12880, $1, $2, true, $3, $4, $5, $6, $7)`,
        [baca1, baca2, konstantaLamaEc, konstantaBaru, `Kalibrasi EC 2-titik (1413 µS/cm -> ${baca1}; 12880 µS/cm -> ${baca2})`, Number(req.user.sub) || null, req.user.username || null],
      );
      paramAlat = { tds_faktor: faktorGabung };
      alasanAlat = 'Kalibrasi EC dua titik';
      pesanSimpan = 'Kalibrasi EC dua titik (1.413 & 12.880 µS/cm) disimpan di server';
    } else {
      const baca4 = Number(b.baca4 ?? b.titik_1);
      const baca7 = Number(b.baca7 ?? b.titik_2);
      if (!Number.isFinite(baca4) || baca4 <= 0 || !Number.isFinite(baca7) || baca7 <= 0 || Math.abs(baca7 - baca4) < 0.3) {
        await client.query('ROLLBACK');
        return json(res, 422, { message: 'Kedua titik buffer pH (4,0 dan 7,0) wajib diambil dan berbeda minimal 0,3 pH.', errors: { baca4: ['Periksa bacaan buffer 4,0 dan 7,0.'] } });
      }
      const konstantaLamaPh = baris?.konstanta || { PH_BACA_4: 4.0, PH_BACA_7: 7.0, PH_SLOPE: 1.0 };
      // Tegangan probe di tiap buffer (dari alat, kondisi.ph_volt). Tanpa keduanya, kalibrasi hanya tercatat di server.
      const adaVolt = b.volt4 !== undefined && b.volt7 !== undefined;
      const volt4 = Number(b.volt4); const volt7 = Number(b.volt7);
      if (adaVolt && !(teganganPh.sah(volt4) && teganganPh.sah(volt7) && Math.abs(volt4 - volt7) >= 0.05)) {
        await client.query('ROLLBACK');
        return json(res, 422, { message: 'Tegangan probe pH tidak sah: kedua titik harus 0–5 V dan berselisih minimal 0,05 V. Periksa probe dan larutan buffer.', errors: { volt4: ['Periksa tegangan buffer 4,0 dan 7,0.'] } });
      }
      konstantaBaru = {
        PH_BACA_4: baca4, PH_BACA_7: baca7, PH_SLOPE: Math.round(((7.0 - 4.0) / (baca7 - baca4)) * 10000) / 10000,
        ...(adaVolt ? { PH_V4: volt4, PH_V7: volt7 } : {}),
      };
      if (baris) {
        await client.query(
          'UPDATE kalibrasi_sensor SET terakhir_dikalibrasi = CURRENT_TIMESTAMP, hasil_ukur = $2, konstanta = coalesce(konstanta, \'{}\'::jsonb) || $3::jsonb WHERE sensor = $1',
          ['ph', baca7, JSON.stringify(konstantaBaru)],
        );
      }
      await client.query(
        `INSERT INTO kalibrasi_log (sensor, nilai_ref, bacaan_sebelum, bacaan_sesudah, lulus, konstanta_lama, konstanta_baru, catatan, oleh_user_id, oleh_label)
         VALUES ('ph', 7.0, $1, $2, true, $3, $4, $5, $6, $7)`,
        [baca4, baca7, konstantaLamaPh, konstantaBaru, `Kalibrasi pH 2-titik (buffer 4,0 -> ${baca4}; buffer 7,0 -> ${baca7})`, Number(req.user.sub) || null, req.user.username || null],
      );
      paramAlat = adaVolt ? { ph_v7: volt7, ph_v4: volt4 } : null;
      alasanAlat = 'Kalibrasi pH dua titik';
      pesanSimpan = 'Kalibrasi pH dua titik (buffer 4,0 & 7,0) disimpan di server';
    }

    await client.query('COMMIT');
    const alat = paramAlat
      ? await kirimKeAlat(req, { tipe: 'KALIBRASI', parameter: paramAlat, alasan: alasanAlat })
      : { id: null, ket: 'BELUM dikirim ke alat (alat belum mengirim tegangan probe; perlu firmware yang mengirim ph_volt)' };
    return res.status(201).json({
      status: true,
      id_perintah: alat.id,
      message: `${pesanSimpan}; ${alat.ket}.`,
      data: konstantaBaru,
    });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    next(e);
  } finally {
    client.release();
  }
});

router.post('/pulihkan', ...writeGuard, async (req, res, next) => {
  try {
    const [params, kal] = await Promise.all([
      muatKonfigV41(q),
      q('SELECT sensor AS jenis, dilakukan_pada AS tanggal, konstanta_baru AS data, catatan FROM kalibrasi_log ORDER BY dilakukan_pada DESC, id DESC LIMIT 6').catch(() => []),
    ]);
    const paket = {
      cmd: 'pulihkan_kalibrasi',
      param: {
        volume_l: params.volume_l,
        persen_dosing: params.persen_dosing,
        monitoring_menit: params.monitoring_menit,
        jeda_ab_menit: params.jeda_ab_menit,
        jeda_ec_menit: params.jeda_ec_menit,
        ppm_per_ml: params.ppm_per_ml,
        ph_up_ml: params.ph_up_ml,
        ph_down_ml: params.ph_down_ml,
        laju: [params.laju_a, params.laju_b, params.laju_ph_up, params.laju_ph_down],
        mode_isi: params.mode_isi,
        saklar_ab: params.saklar_ab,
        saklar_ph_up: params.saklar_ph_up,
        saklar_ph_down: params.saklar_ph_down,
        saklar_pengenceran: params.saklar_pengenceran,
      },
      kalibrasi: kal,
      sumber: 'dipulihkan_dari_web',
      disiapkan_pada: new Date().toISOString(),
      terkirim: false,
    };
    await q(
      `INSERT INTO kalibrasi_log (sensor, lulus, konstanta_baru, catatan, oleh_user_id, oleh_label)
       VALUES ('ec', true, $1, 'Paket pemulihan parameter + 6 arsip kalibrasi DISIAPKAN di server (belum dikirim ke papan ESP32 pengganti)', $2, $3)`,
      [JSON.stringify(paket.param), Number(req.user.sub) || null, req.user.username || null],
    ).catch(() => {});

    res.json({
      status: true,
      terkirim: false,
      message: 'Paket pemulihan parameter dan 6 catatan kalibrasi terakhir disiapkan di server. BELUM dikirim ke papan pengganti (jalur perintah ke alat belum tersedia); salin manual atau tunggu jalur perintah.',
      data: paket,
    });
  } catch (e) { next(e); }
});

/** Sumber jadwal di timing_operasi → kunci perintah JADWAL (detik). interval sensor belum punya baris di timing_operasi. */
const SUMBER_JADWAL = [
  { param: 'jeda_ab_menit', kunci: 'jeda_ab_detik', kali: 60 },
  { param: 'isi_air_timeout_menit', kunci: 'isi_air_maks_detik', kali: 60 },
];

/**
 * POST /iot-v41/jadwal-alat — kirim jadwal operasi (timing_operasi) ke ESP32 untuk disimpan PERMANEN di NVS.
 * Bukan aktuasi: tidak menyalakan pompa dan tidak menyentuh gerbang dosing. Nilai di luar batas keras
 * firmware tidak dikirim diam-diam: dijepit ke batas itu dan dilaporkan di `dijepit`.
 */
router.post('/jadwal-alat', ...writeGuard, async (req, res, next) => {
  try {
    const rows = await q('SELECT param, nilai FROM timing_operasi WHERE param = ANY($1::text[])', [SUMBER_JADWAL.map((x) => x.param)]);
    const peta = Object.fromEntries(rows.map((r) => [r.param, r.nilai === null ? null : Number(r.nilai)]));
    const parameter = {};
    const dijepit = [];
    const belum = [];
    for (const { param, kunci, kali } of SUMBER_JADWAL) {
      const v = peta[param];
      if (!Number.isFinite(v)) { belum.push(param); continue; }
      const [min, maks] = aktuator.JADWAL_RENTANG[kunci];
      const detik = Math.round(v * kali);
      const pakai = Math.min(maks, Math.max(min, detik));
      if (pakai !== detik) dijepit.push({ param, diminta_detik: detik, dikirim_detik: pakai });
      parameter[kunci] = pakai;
    }
    if (!Object.keys(parameter).length) {
      return json(res, 422, { kode: 'jadwal_belum_diatur', message: `Jadwal belum diatur: isi ${belum.join(', ')} di Parameter & Keamanan → Jadwal operasi.` });
    }
    let perintah;
    try {
      perintah = await aktuator.buatPerintah({
        tipe: 'JADWAL', parameter, sumber: 'pengguna', userId: Number(req.user.sub) || null,
        alasan: 'Simpan jadwal operasi ke NVS ESP32', ttlDetik: 300,
      });
    } catch (e) {
      if (e && e.status) return json(res, e.status, { message: e.message, ...(e.errors ? { errors: e.errors } : {}) });
      throw e;
    }
    req.audit = { aksi: 'config_change', tabel: 'perintah_aktuator', row_id: String(perintah.id), after: parameter, meta: { dijepit, belum } };
    return res.status(202).json({
      status: true, antre: true, dikonfirmasi: false, id_perintah: perintah.id, parameter, dijepit, belum_diatur: belum,
      message: 'Jadwal masuk antrean. BELUM tersimpan di alat sampai ESP32 melapor "jadwal_disimpan_nvs".',
    });
  } catch (e) { next(e); }
});

/**
 * STOP semua pompa dari aplikasi: mengantre perintah STOP lewat jalur aktuator (STOP lolos containment).
 * Balasan 202 = diantre, BUKAN pompa sudah mati; konfirmasi datang dari aktuator.
 */
router.post('/stop', ...writeGuard, async (req, res, next) => {
  try {
    let perintah;
    try {
      perintah = await aktuator.buatPerintah({
        tipe: 'STOP', parameter: {}, sumber: 'pengguna', userId: Number(req.user.sub) || null,
        alasan: 'STOP dari aplikasi', ttlDetik: 120,
      });
    } catch (e) {
      if (e && e.status) return json(res, e.status, { message: e.message });
      throw e;
    }
    await q(
      `UPDATE dosing_events SET hasil = 'dibatalkan', selesai_pada = now(), alasan_akhir = 'dibatalkan_pengguna', updated_at = now()
        WHERE pemicu = 'USER_MANUAL' AND hasil = 'berjalan'`, []);
    await q(
      `INSERT INTO kalibrasi_log (sensor, lulus, catatan, oleh_user_id, oleh_label)
       VALUES ('pulsa_peristaltik', true, $1, $2, $3)`,
      [`[PERINTAH MANUAL] STOP diantre (id ${perintah && perintah.id ? perintah.id : '?'}); menunggu konfirmasi aktuator`, Number(req.user.sub) || null, req.user.username || null],
    ).catch(() => {});
    return res.status(202).json({
      status: true,
      antre: true,
      dikonfirmasi: false,
      id_perintah: perintah && perintah.id ? perintah.id : null,
      message: 'Perintah STOP masuk antrean. Pompa BELUM dipastikan mati: tunggu konfirmasi aktuator, dan gunakan tombol darurat fisik bila perlu.',
    });
  } catch (e) { next(e); }
});

router.post('/mqtt-uji', ...writeGuard, async (req, res, next) => {
  try {
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const topic = String(b.topic || 'garap/aktuator-01/perintah').trim();
    const pesan = String(b.pesan || '{"cmd":"status"}').trim();
    if (!topic || !pesan) {
      return json(res, 422, { message: 'Topik dan payload pesan wajib diisi.' });
    }
    // satu kontrak: hanya garap/<kode>/...; topik lain ditolak (keputusan 3 Nov 2026)
    if (!/^garap\/[a-z0-9-]{1,40}\/[a-z0-9_-]{1,40}$/.test(topic)) {
      return json(res, 422, { message: 'Topik harus berbentuk garap/<kode>/<jenis>.', errors: { topic: ['Hanya kontrak garap/ yang dipakai.'] } });
    }
    if (pesan.length > 500) return json(res, 422, { message: 'Payload maksimal 500 karakter.' });
    await q(
      `INSERT INTO kalibrasi_log (sensor, lulus, catatan, oleh_user_id, oleh_label)
       VALUES ('ec', true, $1, $2, $3)`,
      [`[MQTT UJI, hanya dicatat] ${topic} -> ${pesan}`, Number(req.user.sub) || null, req.user.username || null],
    ).catch(() => {});
    return res.json({
      status: true,
      terbit: false,
      topic,
      payload: pesan,
      message: `Pesan uji untuk ${topic} hanya DICATAT. Tidak diterbitkan ke broker.`,
    });
  } catch (e) { next(e); }
});

router.post('/reset-peringatan', ...writeGuard, async (req, res, next) => {
  try {
    await q(
      `INSERT INTO kalibrasi_log (sensor, lulus, catatan, oleh_user_id, oleh_label)
       VALUES ('ec', true, '[PERINGATAN] Permintaan RESET dicatat (belum dikirim ke alat)', $1, $2)`,
      [Number(req.user.sub) || null, req.user.username || null],
    ).catch(() => {});
    return res.json({
      status: true,
      terkirim: false,
      message: 'Permintaan reset peringatan dicatat di server. BELUM dikirim ke alat (jalur perintah ke alat belum tersedia); lampu pilot di alat tidak berubah.',
    });
  } catch (e) { next(e); }
});

module.exports = router;

