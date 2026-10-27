'use strict';
/**
 * Preset dosing & target penampung — mount: app.use('/dosing', preset).
 *   GET    /dosing/preset              daftar preset (target_nutrisi) + nama tanaman      admin, demo
 *   POST   /dosing/preset              tambah preset                                       admin
 *   PUT    /dosing/preset/:id          ubah preset                                         admin
 *   DELETE /dosing/preset/:id          hapus preset                                        admin
 *   GET    /dosing/target              per meja: batch berjalan, preset terpilih, target   admin, demo
 *   PUT    /dosing/target/:id_meja     { mode: 'otomatis' | 'manual', target_ec_ppm?, target_ph? }   admin
 *   POST   /dosing/sinkron             hitung ulang target semua penampung bermode otomatis           admin
 *   GET    /dosing/naik-harian         per tanaman: ppm awal, target akhir, lama hari, kenaikan/hari   admin, petani, demo
 *   PUT    /dosing/naik-harian/:id_tanaman  { ppm_awal, ppm_target, hari_capai } (semua null = matikan)  admin, petani
 * Logika pemilihan preset ada di src/presetDosing.js.
 */
const express = require('express');
const { q, one } = require('../db');
const { requireAuth, requireRole, json } = require('../auth');
const { TAHAP, sinkronTarget, sinkronDiam, ringkasTarget } = require('../presetDosing');

const router = express.Router();

/* ── NAIK HARIAN per jenis tanaman — petani juga boleh mengatur (dipasang SEBELUM guard admin/demo) ── */
const KOLOM_NAIK = 'id_tanaman, nama_tanaman, ppm_awal, ppm_target, hari_capai';
const barisNaik = (r) => ({
  ...r,
  per_hari: r.hari_capai ? Math.round(((Number(r.ppm_target) - Number(r.ppm_awal)) / Number(r.hari_capai)) * 10) / 10 : null,
});

router.get('/naik-harian', requireAuth, requireRole('all'), async (_req, res, next) => {
  try {
    const [rows, amb] = await Promise.all([
      q(`SELECT ${KOLOM_NAIK} FROM tanamen ORDER BY nama_tanaman`),
      one("SELECT min, max FROM sensor_thresholds WHERE sensor = 'tds'"),
    ]);
    res.json({ data: rows.map(barisNaik), ambang_tds: amb ? { min: Number(amb.min), max: Number(amb.max) } : null, batas: BATAS.ec });
  } catch (e) { next(e); }
});

router.put('/naik-harian/:id_tanaman', requireAuth, async (req, res, next) => {
  try {
    const { level, demo } = req.user || {};
    if (demo || !['admin', 'petani'].includes(level)) return json(res, 403, { message: 'Hanya admin atau petani yang boleh mengubah target nutrisi.' });
    const id = req.params.id_tanaman;
    const lama = idOk(id) ? await one(`SELECT ${KOLOM_NAIK} FROM tanamen WHERE id_tanaman = $1`, [id]) : null;
    if (!lama) return json(res, 404, { message: 'Tanaman tidak ditemukan.' });
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const awal = ambilAngka(b.ppm_awal); const target = ambilAngka(b.ppm_target); const hari = ambilAngka(b.hari_capai);
    const kosong = [awal, target, hari].every((v) => v == null);
    const err = {};
    if (!kosong) {
      const [lo, hi] = BATAS.ec;
      if (awal == null || !Number.isFinite(awal) || awal < lo || awal > hi) err.ppm_awal = [`ppm awal harus ${lo}–${hi}.`];
      if (target == null || !Number.isFinite(target) || target < lo || target > hi) err.ppm_target = [`Target akhir harus ${lo}–${hi} ppm.`];
      if (hari == null || !Number.isInteger(hari) || hari < 1 || hari > 365) err.hari_capai = ['Lama hari harus bilangan bulat 1–365.'];
      if (!err.ppm_awal && !err.ppm_target && awal > target) err.ppm_target = ['Target akhir tidak boleh lebih kecil dari ppm awal.'];
    }
    if (Object.keys(err).length) return json(res, 422, { message: 'Data tidak valid.', errors: err });
    const row = await one(
      `UPDATE tanamen SET ppm_awal = $2, ppm_target = $3, hari_capai = $4 WHERE id_tanaman = $1 RETURNING ${KOLOM_NAIK}`,
      [id, kosong ? null : awal, kosong ? null : target, kosong ? null : hari]);
    req.audit = { aksi: 'update', tabel: 'tanamen', row_id: String(id), before: lama, after: row };
    await sinkronTarget();   // target penampung yang menanam tanaman ini langsung ikut
    res.json({
      status: true,
      message: kosong ? `Naik harian ${row.nama_tanaman} dimatikan — kembali memakai preset per tahap.`
        : `Target ${row.nama_tanaman} disimpan: ${awal} → ${target} ppm dalam ${hari} hari.`,
      data: barisNaik(row),
    });
  } catch (e) { next(e); }
});

router.use(requireAuth, requireRole(['admin', 'demo']));

/** Tulis hanya admin sungguhan (bukan akun demo). */
function adminSungguhan(req, res, next) {
  if (req.user?.level === 'admin' && !req.user.demo) return next();
  return json(res, 403, { message: 'Hanya admin yang boleh mengubah preset dan target dosing.' });
}
const idOk = (s) => /^[0-9]{1,18}$/.test(String(s));
const STATUS = ['aktif', 'menunggu_konfirmasi', 'kadaluarsa'];
// rentang wajar sama dengan sanity check otomasi (src/otomasi.js SANITY)
const BATAS = { ec: [50, 2500], ph: [3, 9] };

/** Angka dari body: undefined = tidak dikirim, null = dikosongkan, NaN = bukan angka. */
const ambilAngka = (v) => (v === undefined ? undefined : v === null || v === '' ? null : Number(v));

/** Validasi body preset (create: semua kolom; update: hanya yang dikirim, digabung dengan baris lama). */
async function validasiPreset(b, lama) {
  const err = {};
  const out = {};
  const pakai = (k, v) => { if (v !== undefined) out[k] = v; };

  if (b.id_tanaman !== undefined) {
    const id = ambilAngka(b.id_tanaman);
    if (id !== null && (!Number.isInteger(id) || !(await one('SELECT 1 AS x FROM tanamen WHERE id_tanaman = $1', [id])))) {
      err.id_tanaman = ['Tanaman tidak terdaftar.'];
    } else pakai('id_tanaman', id);
  }
  if (b.tahap !== undefined || !lama) {
    const t = TAHAP.find((x) => x.toLowerCase() === String(b.tahap ?? '').trim().toLowerCase());
    if (!t) err.tahap = [`Tahap harus salah satu: ${TAHAP.join(', ')}.`];
    else pakai('tahap', t);
  }
  for (const k of ['umur_min_hari', 'umur_max_hari']) {
    const v = ambilAngka(b[k]);
    if (v !== undefined && v !== null && (!Number.isInteger(v) || v < 0 || v > 365)) err[k] = ['Umur harus bilangan bulat 0–365 hari.'];
    else pakai(k, v);
  }
  for (const [k, [lo, hi], nama] of [['ec_min_ppm', BATAS.ec, 'EC'], ['ec_max_ppm', BATAS.ec, 'EC'], ['ph_min', BATAS.ph, 'pH'], ['ph_max', BATAS.ph, 'pH']]) {
    const v = ambilAngka(b[k]);
    if (v !== undefined && v !== null && (!Number.isFinite(v) || v < lo || v > hi)) err[k] = [`${nama} harus ${lo}–${hi}.`];
    else pakai(k, v);
  }
  if (b.status !== undefined || !lama) {
    const s = b.status === undefined ? 'aktif' : String(b.status);
    if (!STATUS.includes(s)) err.status = [`Status harus salah satu: ${STATUS.join(', ')}.`];
    else pakai('status', s);
  }
  if (b.keterangan !== undefined) {
    const k = b.keterangan === null ? null : String(b.keterangan).trim();
    if (k && k.length > 500) err.keterangan = ['Keterangan maksimal 500 karakter.'];
    else pakai('keterangan', k || null);
  }

  // cek silang pada nilai efektif (lama + kiriman)
  const ef = { ...(lama || {}), ...out };
  const n = (v) => (v == null ? null : Number(v));
  if (n(ef.umur_min_hari) != null && n(ef.umur_max_hari) != null && n(ef.umur_min_hari) > n(ef.umur_max_hari)) err.umur_max_hari = ['Umur maksimal tidak boleh lebih kecil dari umur minimal.'];
  if (n(ef.ec_min_ppm) != null && n(ef.ec_max_ppm) != null && n(ef.ec_min_ppm) > n(ef.ec_max_ppm)) err.ec_max_ppm = ['EC maksimal tidak boleh lebih kecil dari EC minimal.'];
  if (n(ef.ph_min) != null && n(ef.ph_max) != null && n(ef.ph_min) > n(ef.ph_max)) err.ph_max = ['pH maksimal tidak boleh lebih kecil dari pH minimal.'];
  if (ef.status === 'aktif' && [ef.ec_min_ppm, ef.ec_max_ppm, ef.ph_min, ef.ph_max].every((v) => v == null)) {
    err.ec_min_ppm = ['Preset aktif wajib punya rentang EC atau pH.'];
  }
  return { err, out };
}

const DAFTAR = `SELECT tn.*, t.nama_tanaman FROM target_nutrisi tn LEFT JOIN tanamen t ON t.id_tanaman = tn.id_tanaman`;
const URUT = ` ORDER BY tn.tahap = 'Semai' DESC, tn.tahap = 'Peremajaan' DESC, t.nama_tanaman NULLS FIRST, tn.umur_min_hari NULLS FIRST, tn.id`;
const unik = (e) => e && e.code === '23505';
const PESAN_UNIK = { message: 'Data tidak valid.', errors: { tahap: ['Preset untuk tanaman, tahap, dan umur awal ini sudah ada.'] } };

router.get('/preset', async (_req, res, next) => {
  try { res.json(await q(DAFTAR + URUT)); } catch (e) { next(e); }
});

router.post('/preset', adminSungguhan, async (req, res, next) => {
  try {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const { err, out } = await validasiPreset(b, null);
    if (Object.keys(err).length) return json(res, 422, { message: 'Data tidak valid.', errors: err });
    const kolom = Object.keys(out);
    const row = await one(
      `INSERT INTO target_nutrisi (${kolom.join(', ')}, sumber, updated_at)
       VALUES (${kolom.map((_, i) => `$${i + 1}`).join(', ')}, 'preset dosing (web)', now()) RETURNING id`,
      kolom.map((k) => out[k]));
    sinkronDiam();
    res.status(201).json({ status: true, message: 'Preset tersimpan.', data: await one(`${DAFTAR} WHERE tn.id = $1`, [row.id]) });
  } catch (e) {
    if (unik(e)) return json(res, 409, PESAN_UNIK);
    next(e);
  }
});

router.put('/preset/:id', adminSungguhan, async (req, res, next) => {
  try {
    if (!idOk(req.params.id)) return json(res, 404, { message: 'Preset tidak ditemukan.' });
    const lama = await one('SELECT * FROM target_nutrisi WHERE id = $1', [req.params.id]);
    if (!lama) return json(res, 404, { message: 'Preset tidak ditemukan.' });
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const { err, out } = await validasiPreset(b, lama);
    if (Object.keys(err).length) return json(res, 422, { message: 'Data tidak valid.', errors: err });
    const kolom = Object.keys(out);
    if (kolom.length) {
      await q(`UPDATE target_nutrisi SET ${kolom.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`,
        [req.params.id, ...kolom.map((k) => out[k])]);
    }
    sinkronDiam();
    res.json({ status: true, message: 'Preset diperbarui.', data: await one(`${DAFTAR} WHERE tn.id = $1`, [req.params.id]) });
  } catch (e) {
    if (unik(e)) return json(res, 409, PESAN_UNIK);
    next(e);
  }
});

router.delete('/preset/:id', adminSungguhan, async (req, res, next) => {
  try {
    if (!idOk(req.params.id)) return json(res, 404, { message: 'Preset tidak ditemukan.' });
    const row = await one('DELETE FROM target_nutrisi WHERE id = $1 RETURNING id', [req.params.id]);
    if (!row) return json(res, 404, { message: 'Preset tidak ditemukan.' });
    // penampung yang memakai preset ini: target_preset_id → NULL (FK), lalu dihitung ulang
    await sinkronTarget();
    res.json({ status: true, message: 'Preset dihapus.' });
  } catch (e) { next(e); }
});

router.get('/target', async (_req, res, next) => {
  try { res.json(await ringkasTarget()); } catch (e) { next(e); }
});

router.put('/target/:id_meja', adminSungguhan, async (req, res, next) => {
  try {
    const id = req.params.id_meja;
    if (!idOk(id) || !(await one('SELECT 1 AS x FROM mejas WHERE id_meja = $1', [id]))) return json(res, 404, { message: 'Meja tidak ditemukan.' });
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const mode = String(b.mode ?? '');
    if (!['otomatis', 'manual'].includes(mode)) return json(res, 422, { message: 'Data tidak valid.', errors: { mode: ["Mode harus 'otomatis' atau 'manual'."] } });
    await q('INSERT INTO penampung_states (id_meja) VALUES ($1) ON CONFLICT (id_meja) DO NOTHING', [id]);
    if (mode === 'manual') {
      const ec = ambilAngka(b.target_ec_ppm); const ph = ambilAngka(b.target_ph);
      const err = {};
      if (ec != null && (!Number.isFinite(ec) || ec < BATAS.ec[0] || ec > BATAS.ec[1])) err.target_ec_ppm = [`EC harus ${BATAS.ec.join('–')} ppm.`];
      if (ph != null && (!Number.isFinite(ph) || ph < BATAS.ph[0] || ph > BATAS.ph[1])) err.target_ph = [`pH harus ${BATAS.ph.join('–')}.`];
      if (ec == null && ph == null) err.target_ec_ppm = ['Isi target EC atau pH untuk mode manual.'];
      if (Object.keys(err).length) return json(res, 422, { message: 'Data tidak valid.', errors: err });
      await q(`UPDATE penampung_states SET target_mode = 'manual', target_ec_ppm = $2, target_ph = $3, target_preset_id = NULL,
                      target_diperbarui = now(), updated_at = now() WHERE id_meja = $1`, [id, ec ?? null, ph ?? null]);
    } else {
      await q("UPDATE penampung_states SET target_mode = 'otomatis', updated_at = now() WHERE id_meja = $1", [id]);
      await sinkronTarget();
    }
    const baris = (await ringkasTarget()).find((r) => String(r.id_meja) === String(id));
    res.json({ status: true, message: mode === 'manual' ? 'Target manual disimpan.' : 'Target kembali otomatis dari preset.', data: baris });
  } catch (e) { next(e); }
});

router.post('/sinkron', adminSungguhan, async (_req, res, next) => {
  try {
    const berubah = await sinkronTarget();
    res.json({ status: true, message: `${berubah} penampung diperbarui dari preset.`, berubah });
  } catch (e) { next(e); }
});

module.exports = router;
