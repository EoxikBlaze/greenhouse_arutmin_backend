'use strict';
/** Master data: meja, tanaman (jenis), siklus (+csv), ambang — path 1:1 resource Laravel. */
const express = require('express');
const { q, one } = require('../db');
const { konfigurasiMeja } = require('../konfigurasiAlat');
const { demoGuard, requireAuth, requireRole } = require('../auth');
const { crudRouter } = require('./_crud');

const router = express.Router();
const guard = [requireAuth, requireRole(['admin', 'demo'])];

/**
 * Konfigurasi alat per meja (yang dikirim KONFIGURASI saat Mulai Semai) + alat yang terpasang.
 * GET /meja/konfigurasi-alat → { data: [{ id_meja, volume_l, monitoring_menit, jeda_ab_dtk, otomatis, alat }], alat: [...] }
 */
router.get('/meja/konfigurasi-alat', ...guard, async (_req, res, next) => {
  try {
    const [meja, alat] = await Promise.all([
      q('SELECT * FROM mejas ORDER BY id_meja'),
      q(`SELECT kode, nama, id_meja, (terakhir_terlihat > now() - interval '120 seconds') AS online
           FROM perangkat WHERE peran IN ('gabungan', 'aktuator') ORDER BY kode`),
    ]);
    res.json({
      data: meja.map((m) => ({ id_meja: m.id_meja, ...konfigurasiMeja(m), alat: alat.find((a) => String(a.id_meja) === String(m.id_meja))?.kode ?? null })),
      alat,
    });
  } catch (e) { next(e); }
});

/** Pasang / lepas alat di meja (perangkat.id_meja). Satu alat hanya di satu meja; satu meja satu alat. */
router.put('/meja/:id/alat', ...guard, demoGuard('meja.alat'), async (req, res, next) => {
  try {
    if (!/^\d{1,18}$/.test(req.params.id)) return res.status(404).json({ message: 'Data tidak ditemukan.' });
    const kode = req.body?.kode ?? null;
    if (kode !== null && (typeof kode !== 'string' || !kode.trim())) {
      return res.status(422).json({ message: 'Data tidak valid.', errors: { kode: ['Pilih alat atau kosongkan.'] } });
    }
    if (!(await one('SELECT 1 AS x FROM mejas WHERE id_meja = $1', [req.params.id]))) return res.status(404).json({ message: 'Data tidak ditemukan.' });
    if (kode && !(await one("SELECT 1 AS x FROM perangkat WHERE kode = $1 AND peran IN ('gabungan','aktuator')", [kode]))) {
      return res.status(422).json({ message: 'Data tidak valid.', errors: { kode: ['Alat tidak dikenal.'] } });
    }
    await q('UPDATE perangkat SET id_meja = NULL, updated_at = now() WHERE id_meja = $1 AND ($2::text IS NULL OR kode <> $2)', [req.params.id, kode]);
    if (kode) await q('UPDATE perangkat SET id_meja = $1, updated_at = now() WHERE kode = $2', [req.params.id, kode]);
    req.audit = { aksi: 'update', tabel: 'perangkat', row_id: kode ?? String(req.params.id), after: { id_meja: kode ? Number(req.params.id) : null } };
    res.json({ status: true, message: kode ? `Alat ${kode} dipasang di meja ini.` : 'Alat dilepas dari meja ini.' });
  } catch (e) { next(e); }
});

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
      'monitoring_menit', 'jeda_ab_dtk', // kosong = dihitung otomatis (src/konfigurasiAlat.js)
    ],
    // Kolom baca-saja: ikut GET (baris berjumlah 13 kolom = 1 PK + 9 tulis + 3 waktu)
    // tetapi tetap ditolak/divalidasi sebagai kolom di luar whitelist saat POST/PUT.
    readColumns: ['created_at', 'updated_at', 'expires_at'],
    name: 'meja', orderBy: 'id_meja',
  }));

router.use('/tanaman', ...guard,
  demoGuard('tanaman.store'),
  crudRouter({
    table: 'tanamen', pk: 'id_tanaman',
    // resep: kurva nutrisi (per hari / per tahap) & rentang pH — disalin ke batch saat Mulai Semai
    columns: ['nama_tanaman', 'id_meja', 'cara_naik', 'ppm_awal', 'ppm_target', 'hari_capai',
      'ppm_semai', 'ppm_peremajaan', 'ppm_pendewasaan', 'ph_min', 'ph_max'],
    name: 'tanaman', orderBy: 'id_tanaman',
  }));

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
