'use strict';
/**
 * Kalibrasi alat IoT — mount: app.use('/kalibrasi', kalibrasi).
 *   GET  /kalibrasi                 daftar + status jadwal (terlambat/segera/aman/belum/tanpa_jadwal) + perangkat   admin, demo
 *   GET  /kalibrasi/:sensor/riwayat riwayat kalibrasi (terbaru dulu)                                                admin, demo
 *   POST /kalibrasi/:sensor         catat kalibrasi; pH/EC: hitung konstanta firmware baru dari bacaan              admin
 *   PUT  /kalibrasi/:sensor         ubah jadwal, toleransi, larutan referensi, konstanta firmware saat ini           admin
 *
 * Konstanta firmware (deploy-pi/firmware/sensor/sensor.ino):
 *   pH  = 7 + (4,01 − 7)/(PH_V4 − PH_V7) · (v − PH_V7)        → dari dua bacaan buffer dihitung PH_V7 & PH_V4 baru
 *   TDS = rumus modul × 0,5 × TDS_FAKTOR_KOREKSI (ppm, faktor 500) → faktor baru = faktor lama × ppm_ref / ppm_baca
 */
const express = require('express');
const { q, one, pool } = require('../db');
const { requireAuth, requireRole, json } = require('../auth');

const router = express.Router();
router.use(requireAuth, requireRole(['admin', 'demo']));

function adminSungguhan(req, res, next) {
  if (req.user?.level === 'admin' && !req.user.demo) return next();
  return json(res, 403, { message: 'Hanya admin yang boleh mencatat atau mengubah kalibrasi.' });
}
const sensorOk = (s) => /^[a-z0-9_]{1,32}$/.test(String(s));
const angka = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
const bulat = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

/* ── perhitungan murni (diuji di test/kalibrasi.test.js) ─────────────── */

/**
 * Konstanta pH baru dari bacaan sistem saat probe dicelup dua buffer.
 * Bacaan pH dihitung firmware dengan konstanta LAMA → dibalik jadi tegangan, lalu garis lewat dua
 * titik (buffer1, v1)-(buffer2, v2) dievaluasi di pH 7,00 dan 4,01 (titik yang dipakai rumus firmware).
 */
function konstantaPh({ PH_V7, PH_V4 }, { buffer1, baca1, buffer2, baca2 }) {
  const slopeLama = (4.01 - 7) / (PH_V4 - PH_V7);
  const tegangan = (ph) => PH_V7 + (ph - 7) / slopeLama;
  const v1 = tegangan(baca1);
  const v2 = tegangan(baca2);
  const vDi = (ph) => v1 + ((ph - buffer1) * (v2 - v1)) / (buffer2 - buffer1);
  return { PH_V7: bulat(vDi(7), 4), PH_V4: bulat(vDi(4.01), 4) };
}

/** Faktor koreksi TDS baru: larutan standar µS/cm → ppm (faktor 500), dibanding bacaan ppm sistem. */
function konstantaEc({ TDS_FAKTOR_KOREKSI }, { ref_us_cm, baca_ppm }) {
  const refPpm = ref_us_cm * 0.5;
  return { TDS_FAKTOR_KOREKSI: bulat(TDS_FAKTOR_KOREKSI * (refPpm / baca_ppm), 4) };
}

/** Status jadwal kalibrasi. */
function statusJadwal(row, sekarang = new Date()) {
  const maks = row.periode_hari_max ?? row.periode_hari_min;
  if (!maks) return { status: 'tanpa_jadwal', jatuh_tempo: null };
  if (!row.terakhir_dikalibrasi) return { status: 'belum', jatuh_tempo: null };
  const t = new Date(row.terakhir_dikalibrasi).getTime();
  const tempo = new Date(t + maks * 86_400_000);
  const awal = new Date(t + (row.periode_hari_min ?? maks) * 86_400_000);
  const s = sekarang.getTime();
  return { status: s > tempo.getTime() ? 'terlambat' : s >= awal.getTime() ? 'segera' : 'aman', jatuh_tempo: tempo.toISOString() };
}

/* ── rute ─────────────────────────────────────────────────────────── */

const DAFTAR = `
  SELECT k.*, p.nama AS perangkat_nama, p.terakhir_terlihat,
         (p.terakhir_terlihat IS NOT NULL AND p.terakhir_terlihat > now() - interval '120 seconds') AS perangkat_online,
         (SELECT row_to_json(l) FROM (SELECT dilakukan_pada, lulus, oleh_label FROM kalibrasi_log WHERE sensor = k.sensor
            ORDER BY dilakukan_pada DESC, id DESC LIMIT 1) l) AS log_terakhir
    FROM kalibrasi_sensor k LEFT JOIN perangkat p ON p.kode = k.perangkat_kode`;

router.get('/', async (_req, res, next) => {
  try {
    const urut = { ph: 1, ec: 2, suhu_air: 3, suhu_udara: 4, pulsa_peristaltik: 5 };
    const rows = (await q(DAFTAR)).map((r) => ({ ...r, ...statusJadwal(r) }));
    rows.sort((a, b) => (urut[a.sensor] ?? 99) - (urut[b.sensor] ?? 99) || a.sensor.localeCompare(b.sensor));
    res.json(rows);
  } catch (e) { next(e); }
});

router.get('/:sensor/riwayat', async (req, res, next) => {
  try {
    if (!sensorOk(req.params.sensor)) return json(res, 404, { message: 'Alat tidak ditemukan.' });
    res.json(await q('SELECT * FROM kalibrasi_log WHERE sensor = $1 ORDER BY dilakukan_pada DESC, id DESC LIMIT 100', [req.params.sensor]));
  } catch (e) { next(e); }
});

router.post('/:sensor', adminSungguhan, async (req, res, next) => {
  const client = await pool.connect();
  try {
    if (!sensorOk(req.params.sensor)) return json(res, 404, { message: 'Alat tidak ditemukan.' });
    await client.query('BEGIN');
    const k = (await client.query('SELECT * FROM kalibrasi_sensor WHERE sensor = $1 FOR UPDATE', [req.params.sensor])).rows[0];
    if (!k) { await client.query('ROLLBACK'); return json(res, 404, { message: 'Alat tidak ditemukan.' }); }
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const err = {};
    const ambil = (key) => {
      const v = angka(b[key]);
      if (v !== null && !Number.isFinite(v)) err[key] = ['Harus berupa angka.'];
      return v;
    };
    const nilaiRef = ambil('nilai_ref'); const sebelum = ambil('bacaan_sebelum'); const sesudah = ambil('bacaan_sesudah');
    const catatan = typeof b.catatan === 'string' && b.catatan.trim() ? b.catatan.trim().slice(0, 1000) : null;

    let baru = null;
    if (k.sensor === 'ph' && (b.baca1 !== undefined || b.baca2 !== undefined)) {
      const p = { buffer1: ambil('buffer1') ?? 6.86, baca1: ambil('baca1'), buffer2: ambil('buffer2') ?? 4.0, baca2: ambil('baca2') };
      for (const key of ['baca1', 'baca2']) if (p[key] == null) err[key] = ['Isi bacaan pH sistem saat probe dicelup buffer.'];
      for (const key of ['buffer1', 'buffer2', 'baca1', 'baca2']) if (p[key] != null && (p[key] < 0 || p[key] > 14)) err[key] = ['pH harus 0–14.'];
      if (!Object.keys(err).length && Math.abs(p.buffer1 - p.buffer2) < 1) err.buffer2 = ['Dua buffer harus berbeda minimal 1 pH.'];
      if (!Object.keys(err).length && Math.abs(p.baca1 - p.baca2) < 0.3) err.baca2 = ['Dua bacaan hampir sama — probe mungkin tidak merespons. Periksa probe dulu.'];
      const lama = k.konstanta || {};
      if (!Number.isFinite(Number(lama.PH_V7)) || !Number.isFinite(Number(lama.PH_V4))) err.konstanta = ['Isi konstanta firmware saat ini (PH_V7 & PH_V4) dulu.'];
      if (!Object.keys(err).length) baru = konstantaPh({ PH_V7: Number(lama.PH_V7), PH_V4: Number(lama.PH_V4) }, p);
    }
    if (k.sensor === 'ec' && b.baca_ppm !== undefined) {
      const ref = ambil('ref_us_cm') ?? (k.nilai_ref != null ? Number(k.nilai_ref) : 1413);
      const baca = ambil('baca_ppm');
      if (baca == null || baca <= 0) err.baca_ppm = ['Isi bacaan TDS (ppm) sistem saat probe dicelup larutan standar.'];
      const lama = Number((k.konstanta || {}).TDS_FAKTOR_KOREKSI);
      if (!Number.isFinite(lama)) err.konstanta = ['Isi konstanta firmware saat ini (TDS_FAKTOR_KOREKSI) dulu.'];
      if (!Object.keys(err).length) {
        baru = konstantaEc({ TDS_FAKTOR_KOREKSI: lama }, { ref_us_cm: ref, baca_ppm: baca });
        if (baru.TDS_FAKTOR_KOREKSI < 0.3 || baru.TDS_FAKTOR_KOREKSI > 3) err.baca_ppm = [`Faktor hasil ${baru.TDS_FAKTOR_KOREKSI} di luar 0,3–3 — bacaan atau larutan kemungkinan salah.`];
      }
    }
    if (Object.keys(err).length) { await client.query('ROLLBACK'); return json(res, 422, { message: 'Data tidak valid.', errors: err }); }

    // lulus: dari pilihan teknisi, atau otomatis bila bacaan sesudah & referensi & toleransi ada
    let lulus = typeof b.lulus === 'boolean' ? b.lulus : null;
    if (lulus === null && sesudah != null && nilaiRef != null && k.toleransi != null) lulus = Math.abs(sesudah - nilaiRef) <= Number(k.toleransi);
    const log = (await client.query(
      `INSERT INTO kalibrasi_log (sensor, nilai_ref, bacaan_sebelum, bacaan_sesudah, lulus, konstanta_lama, konstanta_baru, catatan, oleh_user_id, oleh_label)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [k.sensor, nilaiRef, sebelum, sesudah, lulus, k.konstanta, baru, catatan, Number(req.user.sub) || null, req.user.username || null])).rows[0];
    await client.query(
      `UPDATE kalibrasi_sensor SET terakhir_dikalibrasi = now(), hasil_ukur = coalesce($2, $3, hasil_ukur),
              konstanta = coalesce($4, konstanta) WHERE sensor = $1`,
      [k.sensor, sesudah, sebelum, baru]);
    await client.query('COMMIT');
    res.status(201).json({ status: true, message: baru ? 'Kalibrasi dicatat. Salin konstanta baru ke firmware lalu unggah ulang.' : 'Kalibrasi dicatat.', data: log });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    next(e);
  } finally {
    client.release();
  }
});

router.put('/:sensor', adminSungguhan, async (req, res, next) => {
  try {
    if (!sensorOk(req.params.sensor)) return json(res, 404, { message: 'Alat tidak ditemukan.' });
    const k = await one('SELECT * FROM kalibrasi_sensor WHERE sensor = $1', [req.params.sensor]);
    if (!k) return json(res, 404, { message: 'Alat tidak ditemukan.' });
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const err = {}; const set = {};
    for (const key of ['periode_hari_min', 'periode_hari_max']) {
      if (b[key] === undefined) continue;
      const v = angka(b[key]);
      if (v !== null && (!Number.isInteger(v) || v < 1 || v > 365)) err[key] = ['Periode harus 1–365 hari.'];
      else set[key] = v;
    }
    for (const key of ['toleransi', 'nilai_ref']) {
      if (b[key] === undefined) continue;
      const v = angka(b[key]);
      if (v !== null && (!Number.isFinite(v) || v < 0)) err[key] = ['Harus angka ≥ 0.'];
      else set[key] = v;
    }
    if (b.larutan_ref !== undefined) {
      const t = b.larutan_ref === null ? null : String(b.larutan_ref).trim();
      if (t && t.length > 64) err.larutan_ref = ['Maksimal 64 karakter.'];
      else set.larutan_ref = t || null;
    }
    if (b.konstanta !== undefined) {
      const c = b.konstanta;
      const sah = c === null || (typeof c === 'object' && !Array.isArray(c)
        && Object.keys(c).length <= 10 && Object.entries(c).every(([n, v]) => /^[A-Z0-9_]{1,40}$/.test(n) && Number.isFinite(Number(v))));
      if (!sah) err.konstanta = ['Konstanta berbentuk {NAMA: angka}, nama huruf besar/angka/_ .'];
      else set.konstanta = c === null ? null : Object.fromEntries(Object.entries(c).map(([n, v]) => [n, Number(v)]));
    }
    const ef = { ...k, ...set };
    if (ef.periode_hari_min != null && ef.periode_hari_max != null && ef.periode_hari_min > ef.periode_hari_max) err.periode_hari_max = ['Periode maksimal tidak boleh lebih kecil dari minimal.'];
    if (Object.keys(err).length) return json(res, 422, { message: 'Data tidak valid.', errors: err });
    const kolom = Object.keys(set);
    if (kolom.length) {
      await q(`UPDATE kalibrasi_sensor SET ${kolom.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE sensor = $1`,
        [k.sensor, ...kolom.map((c) => set[c])]);
    }
    const row = await one(`${DAFTAR} WHERE k.sensor = $1`, [k.sensor]);
    res.json({ status: true, message: 'Pengaturan kalibrasi disimpan.', data: { ...row, ...statusJadwal(row) } });
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.konstantaPh = konstantaPh;
module.exports.konstantaEc = konstantaEc;
module.exports.statusJadwal = statusJadwal;
