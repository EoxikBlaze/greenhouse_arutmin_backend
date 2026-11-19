'use strict';
/**
 * Catatan Aktivitas — mount: app.use('/audit-logs/aktivitas', ...) khusus admin.
 *   GET /audit-logs/aktivitas      ?jenis= &dari=YYYY-MM-DD &sampai= &kata= &page= &per_page=   → {data,total,per_jenis,page,per_page}
 *   GET /audit-logs/aktivitas/csv  filter sama, maksimal 5000 baris
 */
const express = require('express');
const { json } = require('../auth');
const { tanggalErrors } = require('./_validate');
const A = require('../aktivitas');

const router = express.Router();

const teks = (v) => (typeof v === 'string' ? v.trim().slice(0, 80) : '');
const bulat = (v, def, min, max) => {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};

/** Saring query; mengembalikan {opsi} atau {galat}. */
function baca(query) {
  const errors = { ...tanggalErrors(query.dari, query.sampai) };
  const jenis = teks(query.jenis).toLowerCase();
  if (jenis && !A.JENIS.includes(jenis)) errors.jenis = [`jenis harus salah satu dari ${A.JENIS.join(', ')}.`];
  const page = bulat(query.page, 1, 1, 1_000_000);
  const perPage = bulat(query.per_page, 20, 1, 100);
  if (page === null) errors.page = ['page harus bilangan bulat ≥ 1.'];
  if (perPage === null) errors.per_page = ['per_page harus 1–100.'];
  if (Object.keys(errors).length) return { galat: errors };
  return { opsi: { jenis, dari: teks(query.dari) || undefined, sampai: teks(query.sampai) || undefined, kata: teks(query.kata), page, perPage } };
}

router.get('/', async (req, res, next) => {
  try {
    const { opsi, galat } = baca(req.query);
    if (galat) return json(res, 422, { message: 'Data tidak valid.', errors: galat });
    const hasil = await A.cari(opsi);
    return json(res, 200, { ...hasil, page: opsi.page, per_page: opsi.perPage });
  } catch (e) { return next(e); }
});

/** Sel CSV: kutip, dan awalan ' untuk teks yang diawali = + - @ (cegah rumus di Excel). */
const sel = (v) => {
  let t = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
  return `"${t.replace(/"/g, '""')}"`;
};

router.get('/csv', async (req, res, next) => {
  try {
    const { opsi, galat } = baca(req.query);
    if (galat) return json(res, 422, { message: 'Data tidak valid.', errors: galat });
    const baris = await A.untukCsv(opsi);
    const lines = [['Waktu', 'Jenis', 'Aksi', 'Pelaku', 'Objek', 'Status', 'Ringkasan', 'Detail'].join(',')];
    for (const r of baris) {
      lines.push([new Date(r.waktu).toISOString(), r.jenis, r.aksi, r.pelaku, r.objek, r.status, r.ringkas, r.detail].map(sel).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=UTF-8');
    res.setHeader('Content-Disposition', `attachment; filename="aktivitas-${opsi.dari || 'awal'}_${opsi.sampai || 'kini'}.csv"`);
    return res.send(`﻿${lines.join('\n')}`);
  } catch (e) { return next(e); }
});

module.exports = router;
module.exports.sel = sel;
