'use strict';
/**
 * Analisis AI harian — dipasang di routes/ai.js sesudah requireAuth + aiRole (admin & petani; demo ditolak).
 *   GET  /api/ai/analisis-harian              daftar (ringkas, terbaru dulu)
 *   GET  /api/ai/analisis-harian/terbaru      laporan terakhir (null bila belum ada)
 *   GET  /api/ai/analisis-harian/:tanggal     YYYY-MM-DD
 *   POST /api/ai/analisis-harian/jalankan     admin saja; 409 bila sedang berjalan
 */
const express = require('express');
const repo = require('../analisisHarianRepo');
const penjadwal = require('../penjadwalAnalisisHarian');

const router = express.Router();
const TANGGAL = /^\d{4}-\d{2}-\d{2}$/;

router.get('/analisis-harian', async (req, res, next) => {
  try {
    const batas = Math.min(90, Math.max(1, Number.parseInt(req.query.batas, 10) || 30));
    res.json({ status: true, sedang_berjalan: penjadwal.sedangBerjalan(), data: await repo.daftar(batas) });
  } catch (e) { next(e); }
});

router.get('/analisis-harian/terbaru', async (_req, res, next) => {
  try {
    res.json({ status: true, sedang_berjalan: penjadwal.sedangBerjalan(), data: await repo.terbaru() });
  } catch (e) { next(e); }
});

router.get('/analisis-harian/:tanggal', async (req, res, next) => {
  try {
    const t = req.params.tanggal;
    if (!TANGGAL.test(t) || Number.isNaN(Date.parse(`${t}T00:00:00Z`)) || new Date(`${t}T00:00:00Z`).toISOString().slice(0, 10) !== t) {
      return res.status(422).json({ message: 'Data tidak valid.', errors: { tanggal: ['Format tanggal YYYY-MM-DD.'] } });
    }
    const data = await repo.perTanggal(t);
    if (!data) return res.status(404).json({ message: 'Analisis untuk tanggal itu belum ada.' });
    return res.json({ status: true, data });
  } catch (e) { return next(e); }
});

router.post('/analisis-harian/jalankan', async (req, res, next) => {
  if (req.user?.level !== 'admin') return res.status(403).json({ message: 'Hanya admin yang boleh menjalankan analisis.' });
  try {
    const data = await penjadwal.jalankanSekarang({ pemicu: 'manual', oleh: Number(req.user.sub ?? req.user.id) || null });
    return res.json({ status: true, data });
  } catch (e) {
    if (e.code === 'SEDANG_BERJALAN') return res.status(409).json({ message: e.message });
    return next(e);
  }
});

module.exports = router;
