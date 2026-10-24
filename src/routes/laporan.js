'use strict';
/** Laporan matriks + CSV. */
const express = require('express');
const { q } = require('../db');
const { queryParam } = require('./_id');
const { tanggalErrors } = require('./_validate');

const router = express.Router();

async function matrix(dari, sampai) {
  // CTE per-bulan — bebas masalah GROUP BY dengan subquery korelasi.
  return q(`
    WITH bulan AS (
      SELECT DISTINCT date_trunc('month', tgl_awal_semai) AS bln
      FROM semais
      WHERE ($1::timestamptz IS NULL OR tgl_awal_semai >= $1::date)
        AND ($2::timestamptz IS NULL OR tgl_awal_semai <= $2::date)
    )
    SELECT to_char(bln, 'YYYY-MM') AS periode,
           (SELECT count(*)::int FROM semais s WHERE date_trunc('month', s.tgl_awal_semai) = bln) AS semai,
           (SELECT count(*)::int FROM peremajaans p WHERE date_trunc('month', p.tgl_awal_peremajaan) = bln) AS remaja,
           (SELECT count(*)::int FROM pendewasaans d WHERE date_trunc('month', d.tgl_awal_pendewasaan) = bln) AS dewasa,
           (SELECT coalesce(sum(p.panen_berhasil),0)::float FROM panens p WHERE date_trunc('month', p.tgl_panen) = bln) AS panen_kg,
           -- rentang (bukan date_trunc pada kolom) → idx_monitorings_created terpakai; tanpa ini SETIAP bulan
           -- memindai seluruh riwayat sensor (uji beban: 5 juta baris → 716 ms/permintaan dan terus naik)
           (SELECT round(avg(m.ph)::numeric,2) FROM monitorings m
             WHERE m.created_at >= bln::timestamp AND m.created_at < (bln + interval '1 month')::timestamp) AS rata_ph
    FROM bulan ORDER BY 1 DESC`, [dari || null, sampai || null]);
}

router.get('/', async (req, res, next) => {
  try {
    // queryParam: ?DARI=... dikenali spt ?dari=... (normalisasi case — _id.js).
    const dari = queryParam(req.query, 'dari');
    const sampai = queryParam(req.query, 'sampai');
    // G10 — tanggal query divalidasi SEBELUM SQL (dulu 500 22007/22008).
    const errors = tanggalErrors(dari, sampai);
    if (Object.keys(errors).length) {
      return res.status(422).json({ message: 'Data tidak valid.', errors });
    }
    res.json({ page: 'laporan', dari, sampai, matriks: await matrix(dari, sampai) });
  } catch (e) { next(e); }
});

router.get('/csv', async (req, res, next) => {
  try {
    const dari = queryParam(req.query, 'dari');
    const sampai = queryParam(req.query, 'sampai');
    // G10 — sama dengan GET / (validasi sebelum SQL, 422 per-field).
    const errors = tanggalErrors(dari, sampai);
    if (Object.keys(errors).length) {
      return res.status(422).json({ message: 'Data tidak valid.', errors });
    }
    const rows = await matrix(dari, sampai);
    // panen_kg (nama kolom API lama) berisi JUMLAH TANAMAN dipanen, bukan kilogram
    const lines = ['PERIODE,SEMAI,REMAJA,DEWASA,PANEN (TANAMAN),RATA-RATA PH'];
    for (const r of rows) lines.push([r.periode, r.semai, r.remaja, r.dewasa, r.panen_kg, r.rata_ph].join(','));
    res.setHeader('Content-Type', 'text/csv; charset=UTF-8');
    const nama = `laporan-${dari || 'awal'}_${sampai || 'kini'}.csv`;
    res.setHeader('Content-Disposition', `attachment; filename="${nama}"`);
    res.send('\uFEFF' + lines.join('\n'));
  } catch (e) { next(e); }
});

module.exports = router;
