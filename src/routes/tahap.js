'use strict';
/** Data Tahap: semai (list/create/detail/tab selesai), peremajaan, pendewasaan, panen. */
const express = require('express');
const { q, one } = require('../db');
const { demoGuard, requireAuth, requireRole } = require('../auth');
const { crudRouter } = require('./_crud');
const { idValid, notFound } = require('./_id');

const router = express.Router();
const guard = [requireAuth, requireRole(['admin', 'demo'])];

// V2 — validasi path param :id (lihat _crud.js validId): non-angka ATAU melebihi
// rentang bigint Postgres → 404 PERSIS sama dengan id yang tidak ada (anti-enumeration),
// dicek di depan query (dulu 'abc'/id raksasa → 500). Body 404 diseragamkan dengan
// kontrak baru {message, errors:{}} (sebelumnya batch/:id membalas tanpa errors:{}).
// Definisi bersama (BIGINT_MAX / idValid / notFound) kini ada di ./_id.

/* ── SEMAI (ada endpoint khusus — letakkan SEBELUM crud) ───────────── */
router.get('/semai/selesai', ...guard, async (_req, res, next) => {
  try {
    res.json(await q(`
      SELECT s.*, t.nama_tanaman FROM semais s LEFT JOIN tanamen t ON t.id_tanaman = s.id_tanaman
      WHERE s.status = 'selesai' ORDER BY s.id_semai DESC`));
  } catch (e) { next(e); }
});

router.get('/semai/batch/:id', ...guard, async (req, res, next) => {
  try {
    if (!idValid(req)) return notFound(res);
    const semai = await one(`
      SELECT s.*, t.nama_tanaman FROM semais s LEFT JOIN tanamen t ON t.id_tanaman = s.id_tanaman
      WHERE s.id_semai = $1`, [req.params.id]);
    if (!semai) return notFound(res);
    const peremajaan = await q('SELECT * FROM peremajaans WHERE id_semai = $1 ORDER BY id_peremajaan DESC', [req.params.id]);
    const pendewasaan = await q(`
      SELECT pd.* FROM pendewasaans pd JOIN peremajaans pr ON pr.id_peremajaan = pd.id_peremajaan
      WHERE pr.id_semai = $1 ORDER BY pd.id_pendewasaan DESC`, [req.params.id]);
    const panen = await q(`
      SELECT p.* FROM panens p
      JOIN pendewasaans pd ON pd.id_pendewasaan = p.id_pendewasaan
      JOIN peremajaans pr ON pr.id_peremajaan = pd.id_peremajaan
      WHERE pr.id_semai = $1 ORDER BY p.id_panen DESC`, [req.params.id]);
    res.json({ semai, peremajaan, pendewasaan, panen });
  } catch (e) { next(e); }
});

router.use('/semai', ...guard, demoGuard('semai.store'), crudRouter({
  table: 'semais', pk: 'id_semai', orderBy: 'id_semai',
  columns: ['id_tanaman', 'id_siklus', 'id_meja', 'jumlah_benih', 'tgl_awal_semai', 'tgl_akhir_semai', 'status', 'keterangan', 'benih_berhasil', 'benih_gagal'],
}));

router.use('/peremajaan', ...guard, demoGuard('peremajaan.store'), crudRouter({
  table: 'peremajaans', pk: 'id_peremajaan', orderBy: 'id_peremajaan',
  columns: ['id_semai', 'id_meja', 'jumlah_masuk', 'benih_berhasil', 'benih_gagal', 'tgl_awal_peremajaan', 'tgl_akhir_peremajaan', 'keterangan'],
  readColumns: ['status'], // ditulis hanya oleh POST /tanam/:tipe/:id/selesai
}));

router.use('/pendewasaan', ...guard, demoGuard('pendewasaan.store'), crudRouter({
  table: 'pendewasaans', pk: 'id_pendewasaan', orderBy: 'id_pendewasaan',
  columns: ['id_peremajaan', 'id_meja', 'jumlah_masuk', 'tanaman_berhasil', 'tanaman_gagal', 'tgl_awal_pendewasaan', 'tgl_akhir_pendewasaan', 'keterangan'],
  readColumns: ['status'], // ditulis hanya oleh POST /tanam/:tipe/:id/selesai
}));

router.use('/panen', ...guard, demoGuard('panen.store'), crudRouter({
  table: 'panens', pk: 'id_panen', orderBy: 'id_panen',
  columns: ['id_pendewasaan', 'panen_berhasil', 'panen_gagal', 'tgl_panen', 'keterangan'],
}));

module.exports = router;
