'use strict';
/** Laporan matriks + CSV. */
const express = require('express');
const { q } = require('../db');

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
           (SELECT round(avg(m.ph)::numeric,2) FROM monitorings m WHERE date_trunc('month', m.created_at) = bln) AS rata_ph
    FROM bulan ORDER BY 1 DESC`, [dari || null, sampai || null]);
}

router.get('/', async (req, res, next) => {
  try {
    const { dari, sampai } = req.query;
    res.json({ page: 'laporan', dari, sampai, matriks: await matrix(dari, sampai) });
  } catch (e) { next(e); }
});

router.get('/csv', async (req, res, next) => {
  try {
    const { dari, sampai } = req.query;
    const rows = await matrix(dari, sampai);
    const lines = ['PERIODE,SEMAI,REMAJA,DEWASA,PANEN (KG),RATA-RATA PH'];
    for (const r of rows) lines.push([r.periode, r.semai, r.remaja, r.dewasa, r.panen_kg, r.rata_ph].join(','));
    res.setHeader('Content-Type', 'text/csv; charset=UTF-8');
    const nama = `laporan-${dari || 'awal'}_${sampai || 'kini'}.csv`;
    res.setHeader('Content-Disposition', `attachment; filename="${nama}"`);
    res.send('\uFEFF' + lines.join('\n'));
  } catch (e) { next(e); }
});

module.exports = router;
