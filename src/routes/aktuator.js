'use strict';
/**
 * Kendali aktuator & manajemen API key — untuk PENGELOLA (JWT admin, bukan demo).
 * Mount: app.use('/api/aktuator', aktuator.router) · app.use('/api/kunci', aktuator.kunci)
 */
const express = require('express');
const { q, one } = require('../db');
const { requireAuth, json } = require('../auth');
const { SCOPE_VALID, SCOPE_PERAN, buatKunci } = require('../kunci');
const A = require('../aktuator');

const router = express.Router();
const kunci = express.Router();

/** Admin sungguhan: level admin dan BUKAN akun demo. */
function adminSungguhan(req, res, next) {
  if (req.user?.level === 'admin' && !req.user.demo) return next();
  return json(res, 403, { message: 'Hanya admin yang boleh melakukan ini.' });
}
/** Baca saja: admin atau demo (petani tidak). */
function pengelolaBaca(req, res, next) {
  if (req.user?.level === 'admin' || req.user?.demo) return next();
  return json(res, 403, { message: 'Menu ini untuk pengelola.' });
}
const galat = (res, e) => (e instanceof A.PerintahDitolak
  ? json(res, e.status, { message: e.message, ...(e.errors ? { errors: e.errors } : {}) })
  : null);
const idOk = (s) => /^[0-9]{1,18}$/.test(String(s));

/* ── Aktuator ─────────────────────────────────────────────────────── */
router.use(requireAuth);

router.get('/status', pengelolaBaca, async (_req, res, next) => {
  try {
    const perangkat = await q(
      `SELECT kode, nama, peran, versi_firmware AS firmware, rssi, uptime_detik, estop_aktif, terakhir_terlihat,
              (terakhir_terlihat IS NOT NULL AND terakhir_terlihat > now() - interval '120 seconds') AS online
         FROM perangkat WHERE peran IS NOT NULL ORDER BY kode`);
    const es = await A.statusEstop();
    res.json({ estop: es.nilai === '1', estop_sejak: es.diubah_pada ?? null, perangkat });
  } catch (e) { next(e); }
});

router.get('/perintah', pengelolaBaca, async (req, res, next) => {
  try {
    const batas = Math.min(200, Math.max(1, Number.parseInt(req.query.batas, 10) || 50));
    res.json({ data: await q(
      `SELECT id, perangkat_kode, tipe, parameter, status, sumber, alasan, dibuat_pada, dikirim_pada, selesai_pada, hasil
         FROM perintah_aktuator ORDER BY id DESC LIMIT $1`, [batas]) });
  } catch (e) { next(e); }
});

router.post('/perintah', adminSungguhan, async (req, res, next) => {
  try {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const row = await A.buatPerintah({
      tipe: String(b.tipe || '').toUpperCase(), parameter: b.parameter,
      sumber: 'pengguna', userId: Number(req.user.sub) || null, alasan: b.alasan, ttlDetik: b.ttl_detik,
    });
    res.status(201).json({ status: true, perintah: row });
  } catch (e) { return galat(res, e) || next(e); }
});

router.delete('/perintah/:id', adminSungguhan, async (req, res, next) => {
  try {
    if (!idOk(req.params.id)) return json(res, 404, { message: 'Perintah tidak ditemukan.' });
    const row = await one(
      "UPDATE perintah_aktuator SET status = 'batal', selesai_pada = now() WHERE id = $1 AND status = 'menunggu' RETURNING id",
      [req.params.id]);
    if (!row) return json(res, 404, { message: 'Perintah tidak ditemukan atau sudah dikirim ke perangkat.' });
    res.json({ status: true });
  } catch (e) { next(e); }
});

router.post('/estop', adminSungguhan, async (req, res, next) => {
  try {
    const row = await A.buatPerintah({
      tipe: 'STOP_DARURAT', parameter: {}, sumber: 'pengguna', userId: Number(req.user.sub) || null,
      alasan: 'E-STOP dari aplikasi', ttlDetik: 600,
    });
    res.status(201).json({ status: true, estop: true, perintah: row });
  } catch (e) { return galat(res, e) || next(e); }
});

router.post('/estop/reset', adminSungguhan, async (_req, res, next) => {
  try { await A.resetEstop(); res.json({ status: true, estop: false }); } catch (e) { next(e); }
});

/** Buka LOCK penampung setelah diperiksa. Hitungan harian tetap (reset 00:00 WITA). */
router.post('/penampung/:id/buka-kunci', adminSungguhan, async (req, res, next) => {
  try {
    if (!idOk(req.params.id)) return json(res, 404, { message: 'Penampung tidak ditemukan.' });
    const ok = await A.bukaKunci(req.params.id, req.user.username);
    if (!ok) return json(res, 409, { message: 'Penampung tidak sedang terkunci.' });
    res.json({ status: true, status_lock: false });
  } catch (e) { next(e); }
});

/* ── Manajemen API key (admin) ────────────────────────────────────── */
kunci.use(requireAuth, adminSungguhan);

const kolom = 'id, nama, prefix, scope, perangkat_kode, aktif, kedaluwarsa_pada, terakhir_dipakai, ip_terakhir, dibuat_pada, dicabut_pada';

kunci.get('/', async (_req, res, next) => {
  try { res.json({ scope_valid: SCOPE_VALID, data: await q(`SELECT ${kolom} FROM api_keys ORDER BY id DESC`) }); }
  catch (e) { next(e); }
});

async function validasiBodyKunci(b) {
  const err = {};
  const nama = typeof b.nama === 'string' ? b.nama.trim() : '';
  if (!nama || nama.length > 80) err.nama = ['nama wajib 1–80 karakter.'];
  let perangkat = b.perangkat_kode ?? null;
  let scope = Array.isArray(b.scope) ? b.scope : null;
  if (perangkat != null) {
    const d = await one('SELECT peran FROM perangkat WHERE kode = $1', [String(perangkat)]);
    if (!d) err.perangkat_kode = ['perangkat tidak ditemukan.'];
    else scope = scope || SCOPE_PERAN[d.peran];
  }
  if (!scope?.length || scope.some((s) => !SCOPE_VALID.includes(s))) err.scope = [`scope harus berisi: ${SCOPE_VALID.join(', ')}.`];
  const hari = b.hari_berlaku == null ? null : Number(b.hari_berlaku);
  if (hari != null && (!Number.isInteger(hari) || hari < 1 || hari > 3650)) err.hari_berlaku = ['hari_berlaku 1–3650.'];
  return { err, nama, perangkat, scope, hari };
}

kunci.post('/', async (req, res, next) => {
  try {
    const v = await validasiBodyKunci(req.body && typeof req.body === 'object' ? req.body : {});
    if (Object.keys(v.err).length) return json(res, 422, { message: 'Data tidak valid.', errors: v.err });
    const k = await buatKunci({ nama: v.nama, scope: v.scope, perangkatKode: v.perangkat, hariBerlaku: v.hari });
    res.status(201).json({ status: true, peringatan: 'Simpan kunci ini SEKARANG — tidak akan ditampilkan lagi.', data: k });
  } catch (e) { next(e); }
});

kunci.delete('/:id', async (req, res, next) => {
  try {
    if (!idOk(req.params.id)) return json(res, 404, { message: 'Kunci tidak ditemukan.' });
    const row = await one('UPDATE api_keys SET aktif = false, dicabut_pada = now() WHERE id = $1 AND dicabut_pada IS NULL RETURNING id', [req.params.id]);
    if (!row) return json(res, 404, { message: 'Kunci tidak ditemukan atau sudah dicabut.' });
    res.json({ status: true });
  } catch (e) { next(e); }
});

kunci.post('/:id/rotasi', async (req, res, next) => {
  try {
    if (!idOk(req.params.id)) return json(res, 404, { message: 'Kunci tidak ditemukan.' });
    const lama = await one('SELECT nama, scope, perangkat_kode FROM api_keys WHERE id = $1 AND dicabut_pada IS NULL', [req.params.id]);
    if (!lama) return json(res, 404, { message: 'Kunci tidak ditemukan atau sudah dicabut.' });
    const baru = await buatKunci({ nama: lama.nama, scope: lama.scope, perangkatKode: lama.perangkat_kode });
    await q('UPDATE api_keys SET aktif = false, dicabut_pada = now() WHERE id = $1', [req.params.id]);
    res.status(201).json({ status: true, peringatan: 'Kunci lama sudah dicabut. Simpan kunci baru SEKARANG.', data: baru });
  } catch (e) { next(e); }
});

module.exports = { router, kunci };
