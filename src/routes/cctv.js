'use strict';
/**
 * Papan kamera CCTV.
 *   GET    /cctv        semua role (daftar kamera)
 *   POST   /cctv        admin   { nama, lokasi?, tipe: 'mjpeg'|'snapshot', url, interval_detik?, aktif? }
 *   PUT    /cctv/:id    admin
 *   DELETE /cctv/:id    admin
 * Browser menarik gambar LANGSUNG dari URL kamera (server hanya menyimpan daftar).
 * URL wajib http(s). Demo hanya baca. Tabel dibuat otomatis (idempoten) bila belum ada.
 */
const express = require('express');
const { q, one } = require('../db');
const { requireRole, demoGuard, json } = require('../auth');
const { idValid, notFound } = require('./_id');

const router = express.Router();
const tulis = [requireRole(['admin']), demoGuard('cctv.tulis')];

let siap = null;
function pastikanTabel() {
  if (!siap) {
    siap = q(`CREATE TABLE IF NOT EXISTS cctv_kameras (
      id bigserial PRIMARY KEY,
      nama varchar(100) NOT NULL,
      lokasi varchar(100),
      tipe varchar(10) NOT NULL DEFAULT 'snapshot' CHECK (tipe IN ('mjpeg', 'snapshot')),
      url text NOT NULL,
      interval_detik integer NOT NULL DEFAULT 5 CHECK (interval_detik BETWEEN 1 AND 60),
      aktif boolean NOT NULL DEFAULT true,
      created_at timestamp(0) without time zone DEFAULT now() NOT NULL,
      updated_at timestamp(0) without time zone
    )`).catch((e) => { siap = null; throw e; });
  }
  return siap;
}

function bersih(v) {
  return String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u001F\u007F]/g, '').trim();
}

/** @returns {{ok:true,data:object}|{ok:false,errors:object}} */
function periksa(body, parsial) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const errors = {};
  const out = {};
  const ada = (k) => b[k] !== undefined;

  if (!parsial || ada('nama')) {
    const nama = bersih(b.nama);
    if (!nama) errors.nama = ['Nama kamera wajib diisi.'];
    else if (nama.length > 100) errors.nama = ['Nama maksimal 100 karakter.'];
    else out.nama = nama;
  }
  if (ada('lokasi')) {
    const l = bersih(b.lokasi);
    if (l.length > 100) errors.lokasi = ['Lokasi maksimal 100 karakter.'];
    else out.lokasi = l || null;
  }
  if (!parsial || ada('tipe')) {
    const t = bersih(b.tipe || 'snapshot');
    if (!['mjpeg', 'snapshot'].includes(t)) errors.tipe = ["Tipe harus 'mjpeg' atau 'snapshot'."];
    else out.tipe = t;
  }
  if (!parsial || ada('url')) {
    const u = bersih(b.url);
    let ok = false;
    try {
      const p = new URL(u);
      ok = (p.protocol === 'http:' || p.protocol === 'https:') && u.length <= 500;
    } catch { ok = false; }
    if (!ok) errors.url = ['URL harus diawali http:// atau https:// (maks 500 karakter).'];
    else out.url = u;
  }
  if (ada('interval_detik')) {
    const n = Number(b.interval_detik);
    if (!Number.isInteger(n) || n < 1 || n > 60) errors.interval_detik = ['Interval harus bilangan bulat 1–60 detik.'];
    else out.interval_detik = n;
  }
  if (ada('aktif')) {
    if (typeof b.aktif !== 'boolean') errors.aktif = ['Aktif harus true atau false.'];
    else out.aktif = b.aktif;
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, data: out };
}

router.get('/', async (_req, res, next) => {
  try {
    await pastikanTabel();
    const rows = await q('SELECT * FROM cctv_kameras ORDER BY id');
    res.json({ page: 'cctv', list: rows });
  } catch (e) { next(e); }
});

router.post('/', ...tulis, async (req, res, next) => {
  try {
    const v = periksa(req.body, false);
    if (!v.ok) return json(res, 422, { message: 'Data tidak valid.', errors: v.errors });
    await pastikanTabel();
    const d = v.data;
    const row = await one(
      `INSERT INTO cctv_kameras (nama, lokasi, tipe, url, interval_detik, aktif)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [d.nama, d.lokasi ?? null, d.tipe, d.url, d.interval_detik ?? 5, d.aktif ?? true],
    );
    return res.status(201).json({ status: true, message: 'Kamera ditambahkan.', data: row });
  } catch (e) { return next(e); }
});

router.put('/:id', ...tulis, async (req, res, next) => {
  try {
    if (!idValid(req)) return notFound(res);
    const v = periksa(req.body, true);
    if (!v.ok) return json(res, 422, { message: 'Data tidak valid.', errors: v.errors });
    const kolom = Object.keys(v.data);
    if (!kolom.length) return json(res, 422, { message: 'Data tidak valid.', errors: { body: ['Tidak ada kolom yang diubah.'] } });
    await pastikanTabel();
    const set = kolom.map((k, i) => `${k} = $${i + 1}`).concat('updated_at = now()');
    const row = await one(
      `UPDATE cctv_kameras SET ${set.join(', ')} WHERE id = $${kolom.length + 1} RETURNING *`,
      [...kolom.map((k) => v.data[k]), req.params.id],
    );
    if (!row) return notFound(res);
    return res.json({ status: true, message: 'Kamera diperbarui.', data: row });
  } catch (e) { return next(e); }
});

router.delete('/:id', ...tulis, async (req, res, next) => {
  try {
    if (!idValid(req)) return notFound(res);
    await pastikanTabel();
    const row = await one('DELETE FROM cctv_kameras WHERE id = $1 RETURNING id', [req.params.id]);
    if (!row) return notFound(res);
    return res.json({ status: true, message: 'Kamera dihapus.' });
  } catch (e) { return next(e); }
});

module.exports = router;
