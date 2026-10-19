'use strict';
/** Master data: meja, tanaman (jenis), siklus (+csv), ambang — path 1:1 resource Laravel. */
const express = require('express');
const { q } = require('../db');
const { demoGuard, requireAuth, requireRole } = require('../auth');
const { crudRouter } = require('./_crud');

const router = express.Router();
const guard = [requireAuth, requireRole(['admin', 'demo'])];

router.use('/meja', ...guard,
  demoGuard('meja.store'),
  crudRouter({
    table: 'mejas', pk: 'id_meja',
    // Whitelist kolom TULIS — daftar lengkap kolom mejas selain PK & stempel waktu.
    // 7 kolom fisik talang/penampung (migrasi skema V2, ANALISIS_DB_PERANCANGAN §e)
    // WAJIB ada di sini: kolom di luar whitelist tidak ikut SELECT (crudRouter) sehingga
    // dulu tidak muncul di GET/POST/PUT /meja; spec tipe ada di _validate.js TABLE_SPECS
    // (jenis_talang enum NFT|DFT sesuai CHECK, kapasitas/laju/panjang numerik,
    // kenaikan_air_cm integer DEFAULT 40).
    columns: [
      'meja', 'jumlah_lubang',
      'jenis_talang', 'kapasitas_penampung_l', 'jumlah_talang', 'lubang_per_talang',
      'panjang_talang_m', 'laju_per_talang_lpm', 'kenaikan_air_cm',
    ],
    // Kolom baca-saja: ikut GET (baris berjumlah 13 kolom = 1 PK + 9 tulis + 3 waktu)
    // tetapi tetap ditolak/divalidasi sebagai kolom di luar whitelist saat POST/PUT.
    readColumns: ['created_at', 'updated_at', 'expires_at'],
    name: 'meja', orderBy: 'id_meja',
  }));

router.use('/tanaman', ...guard,
  demoGuard('tanaman.store'),
  crudRouter({ table: 'tanamen', pk: 'id_tanaman', columns: ['nama_tanaman', 'id_meja'], name: 'tanaman', orderBy: 'id_tanaman' }));

// CSV SEBELUM route /siklus/:id (kontrak Laravel: 'siklus/csv' di depan resource)
router.get('/siklus/csv', ...guard, async (_req, res, next) => {
  try {
    const rows = await q(`
      SELECT s.*, t.nama_tanaman FROM sikluses s LEFT JOIN tanamen t ON t.id_tanaman = s.id_tanaman
      ORDER BY s.id_siklus DESC`);
    const lines = ['VARIETAS,NAMA SIKLUS,WAKTU SIKLUS (HARI)'];
    for (const r of rows) lines.push([r.nama_tanaman, r.nama_siklus, r.waktu_siklus].join(','));
    res.setHeader('Content-Type', 'text/csv; charset=UTF-8');
    res.setHeader('Content-Disposition', 'attachment; filename="siklus.csv"');
    res.send('\uFEFF' + lines.join('\n'));
  } catch (e) { next(e); }
});

router.use('/siklus', ...guard,
  demoGuard('siklus.store'),
  crudRouter({
    table: 'sikluses', pk: 'id_siklus',
    columns: ['id_tanaman', 'nama_siklus', 'waktu_siklus'], name: 'siklus', orderBy: 'id_siklus',
  }));

router.use('/ambang', ...guard,
  demoGuard('ambang.store'),
  crudRouter({ table: 'sensor_thresholds', pk: 'id', columns: ['sensor', 'min', 'max'], name: 'ambang', orderBy: 'id' }));

module.exports = router;
