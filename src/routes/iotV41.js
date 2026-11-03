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
 *  - POST /iot-v41/pemeliharaan        aktifkan/matikan mode pemeliharaan, mulai kuras, konfirmasi air diganti
 *  - POST /iot-v41/kalibrasi-pompa     catat laju pompa (a, b, ph_up, ph_down) dari hasil takar gelas ukur
 *  - POST /iot-v41/kalibrasi-dua-titik catat kalibrasi 2 titik EC (1413 & 12880 µS/cm) / pH (4,0 & 7,0)
 *                                      atau balik ke kalibrasi sebelumnya
 *  - POST /iot-v41/pulihkan            kirim paket pemulihan parameter + 6 arsip kalibrasi ke papan BARU
 */
const express = require('express');
const { q, one, pool } = require('../db');
const { EKSEKUSI_DIIZINKAN } = require('../gerbangDosis');
const aktuator = require('../aktuator');
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
router.use(requireAuth, requireRole(['admin', 'demo']));

const writeGuard = [requireRole(['admin']), demoGuard('iot_v41.write')];

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
  const ambil = (kunciDb, kunciBawaan, bulat = false) => {
    const v = peta[kunciDb];
    const pakai = Number.isFinite(v) ? v : BAWAAN_V41[kunciBawaan];
    return bulat ? Math.round(pakai) : pakai;
  };

  const volume_l = ambil('volume_efektif_l', 'volume_l', true);
  const talang_jumlah = ambil('jumlah_talang', 'talang_jumlah', true);
  const talang_debit = ambil('debit_per_talang_lpm', 'talang_debit', false);
  const ph_maks_ml = ambil('ph_maks_ml', 'ph_maks_ml', true);
  const sirkulasi = hitungSirkulasi({ volume_l, talang_jumlah, talang_debit });

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
    saklar_ab: ambil('saklar_ab', 'saklar_ab', true) ? 1 : 0,
    saklar_ph_up: ambil('saklar_ph_up', 'saklar_ph_up', true) ? 1 : 0,
    saklar_ph_down: ambil('saklar_ph_down', 'saklar_ph_down', true) ? 1 : 0,
    saklar_pengenceran: ambil('saklar_pengenceran', 'saklar_pengenceran', true) ? 1 : 0,
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
  };
}

router.get('/state', async (_req, res, next) => {
  try {
    const [rawParams, states, bacaan5, perangkatRows, arsipKal, wc] = await Promise.all([
      muatKonfigV41(q),
      q('SELECT * FROM penampung_states ORDER BY id_meja LIMIT 5').catch(() => []),
      q('SELECT ph, tds, ec_ms_cm, water_temp, air_temp, humidity, created_at FROM monitorings ORDER BY created_at DESC LIMIT 5').catch(() => []),
      q('SELECT kode, nama, peran, versi_firmware, terakhir_terlihat, estop_aktif FROM perangkat ORDER BY kode').catch(() => []),
      q('SELECT id, sensor, dilakukan_pada, nilai_ref, bacaan_sebelum, bacaan_sesudah, lulus, konstanta_lama, konstanta_baru, catatan, oleh_label FROM kalibrasi_log ORDER BY dilakukan_pada DESC, id DESC LIMIT 12').catch(() => []),
      one('SELECT * FROM water_controls ORDER BY id LIMIT 1').catch(() => null),
    ]);

    const { _pemeliharaan_param, _hit_ec_param, _vol_ph_param, ...params } = rawParams;
    const stUtama = states[0] || {};
    const pemeliharaan = states.length > 0 ? states.some((s) => s.mode_pemeliharaan === true) : Boolean(_pemeliharaan_param);
    const terkunci = states.some((s) => s.status_lock === true);
    const alasanKunci = states.find((s) => s.lock_alasan)?.lock_alasan || null;

    const targetEc = Number(stUtama.target_ec_ppm) || 0;
    const targetPh = Number(stUtama.target_ph) || 6.0;

    const terbaru = bacaan5[0] || null;
    const terlama = bacaan5[bacaan5.length - 1] || null;
    const ecSekarang = terbaru?.tds != null ? Math.round(Number(terbaru.tds)) : 0;
    const ecMsSekarang = terbaru?.ec_ms_cm != null
      ? Number(terbaru.ec_ms_cm)
      : ecSekarang > 0 ? Math.round((ecSekarang / 500) * 100) / 100 : 0;
    const ecUsSekarang = Math.round(ecMsSekarang * 1000);
    const phSekarang = terbaru?.ph != null ? Number(terbaru.ph) : 0;

    const daftarEcPpm = bacaan5.map((b) => (b.tds != null ? Number(b.tds) : NaN));
    const daftarEcUs = bacaan5.map((b) => (b.ec_ms_cm != null ? Number(b.ec_ms_cm) * 1000 : b.tds != null ? Number(b.tds) * 2 : NaN));
    const daftarPh = bacaan5.map((b) => (b.ph != null ? Number(b.ph) : NaN));

    const stabilEc = cekStabilitasSensor(daftarEcPpm, 'ec_ppm');
    const stabilEcUs = cekStabilitasSensor(daftarEcUs, 'ec_us');
    const stabilPh = cekStabilitasSensor(daftarPh, 'ph');

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
      ec_sekarang: ecSekarang,
      ec_setpoint: targetEc,
      persen_dosing: params.persen_dosing,
      max_ppm_dosing: params.max_ppm_dosing,
      volume_l: params.volume_l,
      ppm_per_ml: params.ppm_per_ml,
      laju_a: params.laju_a,
      laju_b: params.laju_b,
    });

    const papanUtama = perangkatRows.find((p) => p.peran === 'aktuator') || perangkatRows[0] || null;
    const online = papanUtama?.terakhir_terlihat
      ? Date.now() - new Date(papanUtama.terakhir_terlihat).getTime() < 120_000
      : false;
    const statusPapan = !papanUtama
      ? 'offline'
      : !papanUtama.versi_firmware && !papanUtama.terakhir_terlihat
        ? 'BARU'
        : online ? 'online' : 'offline';

    const arsipUjiLab = arsipKal.filter((a) => a.catatan && a.catatan.startsWith('[UJI LAB'));

    res.json({
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
        float_bawah: wc?.valve_state === 'OPEN' ? 0 : 1,
        float_atas: 0,
        ec_ppm: ecSekarang,
        ec_ms: ecMsSekarang,
        ec_us: ecUsSekarang,
        ph: phSekarang,
        suhu_air: terbaru?.water_temp ?? null,
        suhu_ruang: terbaru?.air_temp ?? null,
        rh: terbaru?.humidity ?? null,
        hit_ec: hitEc,
        hit_encer: hitEncer,
        hit_ph: hitPh,
        hit_isi: 0,
        updated_at: terbaru?.created_at ?? null,
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
    });
  } catch (e) { next(e); }
});

router.put('/saklar', ...writeGuard, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const saklar_ab = b.saklar_ab ? 1 : 0;
    const saklar_ph_up = b.saklar_ph_up ? 1 : 0;
    const saklar_ph_down = b.saklar_ph_down ? 1 : 0;
    const saklar_pengenceran = b.saklar_pengenceran ? 1 : 0;
    const mode_isi = b.mode_isi === 'manual' || b.mode_isi_otomatis === false || b.mode_isi_otomatis === 0 ? 'manual' : 'otomatis';
    const modeAngka = mode_isi === 'otomatis' ? 1 : 0;

    await client.query('BEGIN');
    const run = (t, p) => client.query(t, p);
    await simpanParam(run, 'konfigurasi_dosis', 'saklar_ab', saklar_ab, 'status', 'Saklar izin dosing nutrisi A + B');
    await simpanParam(run, 'konfigurasi_dosis', 'saklar_ph_up', saklar_ph_up, 'status', 'Saklar izin koreksi pH Up');
    await simpanParam(run, 'konfigurasi_dosis', 'saklar_ph_down', saklar_ph_down, 'status', 'Saklar izin koreksi pH Down');
    await simpanParam(run, 'konfigurasi_dosis', 'saklar_pengenceran', saklar_pengenceran, 'status', 'Saklar izin pengenceran air');
    await simpanParam(run, 'konfigurasi_dosis', 'mode_isi_otomatis', modeAngka, 'status', 'Mode pengisian air otomatis');
    await client.query('COMMIT');

    const params = await muatKonfigV41(q);
    res.json({
      status: true,
      message: 'Saklar tindakan dan mode pengisian air disimpan.',
      data: params,
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
    const angka = (k, min, max, bulat = false) => {
      const v = Number(b[k]);
      if (!Number.isFinite(v) || v < min || v > max || (bulat && !Number.isInteger(v))) {
        err[k] = [`Nilai ${k} harus angka ${bulat ? 'bulat ' : ''}${min}–${max}.`];
        return null;
      }
      return v;
    };

    const volume_l = angka('volume_l', 0, 50000, true);
    const talang_jumlah = angka('talang_jumlah', 0, 500, true);
    const talang_debit = angka('talang_debit', 0, 100, false);
    const monitoring_menit = angka('monitoring_menit', 10, 120, true);
    const jeda_ab_menit = angka('jeda_ab_menit', 1, 10, true);
    const jeda_ec_menit = angka('jeda_ec_menit', 1, 240, true);
    const persen_dosing = angka('persen_dosing', 50, 90, true);
    const max_ppm_dosing = angka('max_ppm_dosing', 50, 300, true);
    const batas_ec_bawah = angka('batas_ec_bawah', 0, 5000, true);
    const batas_ec_atas = angka('batas_ec_atas', 0, 5000, true);
    const batas_ph_bawah = angka('batas_ph_bawah', 3, 9, false);
    const batas_ph_atas = angka('batas_ph_atas', 3, 9, false);
    const ph_maks_ml = angka('ph_maks_ml', 0, 200, true);
    const pemeliharaan_maks_menit = angka('pemeliharaan_maks_menit', 5, 360, true);

    if (batas_ec_bawah != null && batas_ec_atas != null && batas_ec_atas > 0 && batas_ec_bawah > batas_ec_atas) {
      err.batas_ec_bawah = ['Batas aman EC bawah tidak boleh melebihi batas atas.'];
    }
    if (batas_ph_bawah != null && batas_ph_atas != null && batas_ph_bawah >= batas_ph_atas) {
      err.batas_ph_bawah = ['Batas pH bawah harus lebih kecil dari batas pH atas.'];
    }
    if (Object.keys(err).length) {
      return json(res, 422, { message: 'Data tidak valid.', errors: err });
    }

    await client.query('BEGIN');
    const run = (t, p) => client.query(t, p);
    await simpanParam(run, 'konfigurasi_dosis', 'volume_efektif_l', volume_l, 'L', 'Volume efektif penampung portable');
    await simpanParam(run, 'konfigurasi_dosis', 'jumlah_talang', talang_jumlah, 'talang', 'Jumlah talang meja');
    await simpanParam(run, 'konfigurasi_dosis', 'debit_per_talang_lpm', talang_debit, 'L/menit', 'Debit aliran per talang');
    await simpanParam(run, 'konfigurasi_dosis', 'persen_ronde_dosis', persen_dosing, '%', 'Dosis per ronde = persen dari kekurangan');
    await simpanParam(run, 'konfigurasi_dosis', 'maks_ppm_per_suntikan', max_ppm_dosing, 'ppm', 'Batas kenaikan EC per suntikan');
    await simpanParam(run, 'konfigurasi_dosis', 'batas_ec_bawah_ppm', batas_ec_bawah, 'ppm', 'Batas aman EC bawah');
    await simpanParam(run, 'konfigurasi_dosis', 'batas_ec_atas_ppm', batas_ec_atas, 'ppm', 'Batas aman EC atas');
    await simpanParam(run, 'konfigurasi_dosis', 'batas_ph_bawah', batas_ph_bawah, 'pH', 'Batas aman pH bawah');
    await simpanParam(run, 'konfigurasi_dosis', 'batas_ph_atas', batas_ph_atas, 'pH', 'Batas aman pH atas');
    await simpanParam(run, 'konfigurasi_dosis', 'ph_maks_ml', ph_maks_ml, 'mL', 'Batas mL per koreksi pH');

    await simpanParam(run, 'timing_operasi', 'monitoring_menit', monitoring_menit, 'menit', 'Waktu tunggu larutan berputar merata sebelum baca ulang');
    await simpanParam(run, 'timing_operasi', 'jeda_ab_menit', jeda_ab_menit, 'menit', 'Jeda aman antara suntikan Pompa A dan Pompa B');
    await simpanParam(run, 'timing_operasi', 'jeda_ec_menit', jeda_ec_menit, 'menit', 'Jeda tenang antar tindakan penjagaan EC');
    await simpanParam(run, 'timing_operasi', 'pemeliharaan_maks_menit', pemeliharaan_maks_menit, 'menit', 'Batas waktu otomatis mode pemeliharaan');
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

    if (jenis === 'ec') {
      const hasil = hitungUjiLabEc(b);
      if (!hasil.ok) return json(res, 422, { message: 'Data uji lab EC tidak valid.', errors: hasil.errors });

      await client.query('BEGIN');
      const run = (t, p) => client.query(t, p);
      await simpanParam(run, 'konfigurasi_dosis', 'ppm_per_ml', hasil.ppm_per_ml, 'ppm/mL', 'Kenaikan EC per mL hasil Uji Lab EC');
      const catatan = `[UJI LAB EC] Air ${hasil.volume} L, awal ${hasil.awal} -> akhir ${hasil.akhir} ppm (A ${hasil.ml_a} mL + B ${hasil.ml_b} mL) = ${hasil.ppm_per_ml} ppm/mL`;
      await client.query(
        `INSERT INTO kalibrasi_log (sensor, nilai_ref, bacaan_sebelum, bacaan_sesudah, lulus, konstanta_baru, catatan, oleh_user_id, oleh_label)
         VALUES ('ec', $1, $2, $3, true, $4, $5, $6, $7)`,
        [hasil.ppm_per_ml, hasil.awal, hasil.akhir, JSON.stringify({ PPM_PER_ML: hasil.ppm_per_ml }), catatan, Number(req.user.sub) || null, req.user.username || null],
      ).catch(() => {});
      await client.query('COMMIT');

      return res.status(201).json({
        status: true,
        message: `Hasil Uji Lab EC disimpan: ${String(hasil.ppm_per_ml).replace('.', ',')} ppm/mL.`,
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
        hasil.param,
        hasil.ml_per_ph_l,
        'mL/pH/L',
        `Takaran pH ${hasil.arah} per 1 pH per 1 L hasil Uji Lab pH`,
      );
      const catatan = `[UJI LAB PH ${hasil.arah.toUpperCase()}] Air ${hasil.volume} L, delta pH ${hasil.delta_ph}, larutan ${hasil.ml} mL = ${hasil.ml_per_ph_l} mL/pH/L`;
      await client.query(
        `INSERT INTO kalibrasi_log (sensor, nilai_ref, bacaan_sesudah, lulus, konstanta_baru, catatan, oleh_user_id, oleh_label)
         VALUES ('ph', $1, $2, true, $3, $4, $5, $6)`,
        [hasil.delta_ph, hasil.ml_per_ph_l, JSON.stringify({ [hasil.param.toUpperCase()]: hasil.ml_per_ph_l }), catatan, Number(req.user.sub) || null, req.user.username || null],
      ).catch(() => {});
      await client.query('COMMIT');

      return res.status(201).json({
        status: true,
        message: `Hasil Uji Lab pH ${hasil.arah} disimpan: ${String(hasil.ml_per_ph_l).replace('.', ',')} mL per 1 pH per 1 L.`,
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
    if (aksi === 'kuras_mulai') {
      await client.query('UPDATE penampung_states SET mode_pemeliharaan = true, updated_at = CURRENT_TIMESTAMP');
      await simpanParam(run, 'konfigurasi_dosis', 'mode_pemeliharaan_v41', 1, 'bool', 'Status mode pemeliharaan v4.1');
      await client.query('COMMIT');
      return res.json({
        status: true,
        pemeliharaan: true,
        message: 'Kuras dimulai: mode pemeliharaan AKTIF, semua tindakan dijeda dan hitungan dibekukan.',
      });
    }

    if (aksi === 'air_diganti' || aksi === 'selesai') {
      await client.query(
        `UPDATE penampung_states
            SET mode_pemeliharaan = false,
                status_lock = false,
                lock_alasan = NULL,
                lock_sejak = NULL,
                kejadian_dosis_hari = 0,
                volume_ab_hari_ml = 0,
                volume_ph_hari_ml = 0,
                reset_harian_pada = (now() AT TIME ZONE 'Asia/Makassar'),  -- jam WITA (kolom tanpa zona; dibandingkan dgn tanggal WITA)
                updated_at = CURRENT_TIMESTAMP`,
      );
      await simpanParam(run, 'konfigurasi_dosis', 'mode_pemeliharaan_v41', 0, 'bool', 'Status mode pemeliharaan v4.1');
      await simpanParam(run, 'konfigurasi_dosis', 'hit_ec_hari_v41', 0, 'kali', 'Hitungan dosing EC harian v4.1');
      await simpanParam(run, 'konfigurasi_dosis', 'vol_ph_hari_v41', 0, 'mL', 'Total volume koreksi pH harian v4.1');
      await client.query('COMMIT');
      return res.json({
        status: true,
        pemeliharaan: false,
        message: 'Air baru dikonfirmasi di server: mode pemeliharaan dimatikan, penahanan dibuka, dan hitungan harian dimulai dari nol. Alat belum diberi tahu (jalur perintah ke alat belum tersedia).',
      });
    }

    const aktif = Boolean(b.aktif);
    await client.query('UPDATE penampung_states SET mode_pemeliharaan = $1, updated_at = CURRENT_TIMESTAMP', [aktif]);
    await simpanParam(run, 'konfigurasi_dosis', 'mode_pemeliharaan_v41', aktif ? 1 : 0, 'bool', 'Status mode pemeliharaan v4.1');
    await client.query('COMMIT');
    return res.json({
      status: true,
      pemeliharaan: aktif,
      message: aktif
        ? 'Mode pemeliharaan AKTIF: semua tindakan OFF dan hitungan harian dibekukan.'
        : 'Mode pemeliharaan dimatikan. Alat menunggu tenang sebelum bertindak kembali.',
    });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    next(e);
  } finally {
    client.release();
  }
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

    return res.status(201).json({
      status: true,
      message: `Laju Pompa ${hasil.pompa.toUpperCase()} disimpan: ${hasil.ml} mL ÷ ${hasil.detik} detik = ${String(hasil.laju).replace('.', ',')} mL/detik.`,
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
      if (!logTerakhir || !logTerakhir.konstanta_lama) {
        await client.query('ROLLBACK');
        return json(res, 404, { message: 'Belum ada kalibrasi sebelumnya yang dapat dipulihkan.' });
      }
      await client.query(
        'UPDATE kalibrasi_sensor SET konstanta = $2, terakhir_dikalibrasi = CURRENT_TIMESTAMP WHERE sensor = $1',
        [sensor, logTerakhir.konstanta_lama],
      );
      await client.query(
        `INSERT INTO kalibrasi_log (sensor, konstanta_lama, konstanta_baru, lulus, catatan, oleh_user_id, oleh_label)
         VALUES ($1, $2, $3, true, 'Balik ke kalibrasi sebelumnya (balik_kalibrasi)', $4, $5)`,
        [sensor, baris?.konstanta ?? null, logTerakhir.konstanta_lama, Number(req.user.sub) || null, req.user.username || null],
      );
      await client.query('COMMIT');
      return res.json({
        status: true,
        message: `Kalibrasi ${sensor.toUpperCase()} dikembalikan ke nilai sebelumnya.`,
        data: logTerakhir.konstanta_lama,
      });
    }

    if (sensor === 'ec') {
      const baca1 = Number(b.baca1 ?? b.titik_1);
      const baca2 = Number(b.baca2 ?? b.titik_2);
      if (!Number.isFinite(baca1) || baca1 <= 0 || !Number.isFinite(baca2) || baca2 <= 0) {
        await client.query('ROLLBACK');
        return json(res, 422, { message: 'Kedua titik EC (1.413 µS/cm dan 12.880 µS/cm) wajib diisi.', errors: { baca1: ['Ambil titik 1.413 dan 12.880 µS/cm dulu.'] } });
      }
      const faktor1 = Math.round((1413 / baca1) * 10000) / 10000;
      const faktor2 = Math.round((12880 / baca2) * 10000) / 10000;
      const faktorGabung = Math.round(((faktor1 + faktor2) / 2) * 10000) / 10000;
      const konstantaLamaEc = baris?.konstanta || { TDS_FAKTOR_KOREKSI: 1.0, EC_TITIK_1413: 1413, EC_TITIK_12880: 12880 };
      const konstantaBaru = { TDS_FAKTOR_KOREKSI: faktorGabung, EC_TITIK_1413: baca1, EC_TITIK_12880: baca2 };
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
      await client.query('COMMIT');
      return res.status(201).json({
        status: true,
        message: 'Kalibrasi EC dua titik (1.413 & 12.880 µS/cm) disimpan di server. Belum dikirim ke alat (jalur perintah ke alat belum tersedia).',
        data: konstantaBaru,
      });
    }

    const baca4 = Number(b.baca4 ?? b.titik_1);
    const baca7 = Number(b.baca7 ?? b.titik_2);
    if (!Number.isFinite(baca4) || baca4 <= 0 || !Number.isFinite(baca7) || baca7 <= 0 || Math.abs(baca7 - baca4) < 0.3) {
      await client.query('ROLLBACK');
      return json(res, 422, { message: 'Kedua titik buffer pH (4,0 dan 7,0) wajib diambil dan berbeda minimal 0,3 pH.', errors: { baca4: ['Periksa bacaan buffer 4,0 dan 7,0.'] } });
    }
    const konstantaLamaPh = baris?.konstanta || { PH_BACA_4: 4.0, PH_BACA_7: 7.0, PH_SLOPE: 1.0 };
    const konstantaBaru = { PH_BACA_4: baca4, PH_BACA_7: baca7, PH_SLOPE: Math.round(((7.0 - 4.0) / (baca7 - baca4)) * 10000) / 10000 };
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
    await client.query('COMMIT');
    return res.status(201).json({
      status: true,
      message: 'Kalibrasi pH dua titik (buffer 4,0 & 7,0) disimpan di server. Belum dikirim ke alat (jalur perintah ke alat belum tersedia).',
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

/**
 * Dosing manual dari aplikasi.
 *  - `stop`: benar-benar mengantre perintah STOP lewat jalur aktuator yang sama (STOP lolos containment).
 *    Balasan 202 = diantre, BUKAN pompa sudah mati; konfirmasi datang dari aktuator.
 *  - `dosing_ab` / `dosis_ph`: DIKUNCI (423). Tidak ada hitungan harian yang berubah dan tidak ada perintah dibuat.
 *    Keputusan 3 Nov 2026: tahap awal hanya saran; pengaju tidak menyetujui sendiri; eksekusi lewat alur persetujuan 3C.
 */
router.post('/dosing-manual', ...writeGuard, async (req, res, next) => {
  try {
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const aksi = String(b.aksi || '').toLowerCase();

    if (aksi === 'stop') {
      let perintah;
      try {
        perintah = await aktuator.buatPerintah({
          tipe: 'STOP', parameter: {}, sumber: 'pengguna', userId: Number(req.user.sub) || null,
          alasan: 'STOP dari halaman Dosing Manual', ttlDetik: 120,
        });
      } catch (e) {
        if (e && e.status) return json(res, e.status, { message: e.message });
        throw e;
      }
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
    }

    if (aksi === 'dosing_ab' || aksi === 'dosis_ph') {
      return json(res, 423, {
        kode: 'eksekusi_diblokir',
        eksekusi_diizinkan: EKSEKUSI_DIIZINKAN,
        message: 'Dosing dari aplikasi dikunci. Aplikasi hanya memberi saran: tambahkan nutrisi atau pH secara manual, lalu catat. Tidak ada perintah yang dibuat dan hitungan harian tidak berubah.',
      });
    }

    return json(res, 422, { message: 'Aksi dosing manual tidak dikenal.', errors: { aksi: ['Pilih stop, dosing_ab, atau dosis_ph.'] } });
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

