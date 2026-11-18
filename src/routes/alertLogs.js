'use strict';
/**
 * Peringatan (tabel alert_logs) — mount: app.use('/alert-logs', alertLogs).
 *   GET  /alert-logs?limit=100        semua login; yang sedang terjadi dulu, lalu terbaru
 *   POST /alert-logs/:id/ack          admin; tandai sudah ditangani (acknowledged)
 */
const express = require('express');
const { q } = require('../db');
const { requireAuth, requireRole, demoGuard, json } = require('../auth');
const { idValidValue } = require('./_id');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
    const rows = await q(
      `SELECT id, type, value, severity, locked, acknowledged, acknowledged_at, created_at, updated_at,
              kunci_kejadian, selesai_pada,
              (kunci_kejadian IS NOT NULL AND selesai_pada IS NULL) AS sedang_terjadi
         FROM alert_logs
        ORDER BY (kunci_kejadian IS NOT NULL AND selesai_pada IS NULL) DESC, created_at DESC, id DESC LIMIT $1`, [limit]);
    // aktif = kejadian yang sedang terjadi (ditutup otomatis saat pulih, src/peringatan.js)
    const total = (await q(`SELECT count(*)::int AS n,
        count(*) FILTER (WHERE kunci_kejadian IS NOT NULL AND selesai_pada IS NULL)::int AS aktif FROM alert_logs`))[0];
    return json(res, 200, { status: true, data: rows, total: total.n, aktif: total.aktif });
  } catch (e) { return next(e); }
});

router.post('/:id/ack', requireRole(['admin']), demoGuard('alert.ack'), async (req, res, next) => {
  if (!idValidValue(req.params.id)) return json(res, 404, { message: 'Data tidak ditemukan.' });
  try {
    const r = await q(
      `UPDATE alert_logs SET acknowledged = true, acknowledged_at = now(), updated_at = now()
        WHERE id = $1 RETURNING id, type, acknowledged`, [req.params.id]);
    if (!r.length) return json(res, 404, { message: 'Data tidak ditemukan.' });
    req.audit = { aksi: 'update', tabel: 'alert_logs', row_id: String(r[0].id), before: { acknowledged: false }, after: { acknowledged: true } };
    return json(res, 200, { status: true, message: 'Peringatan ditandai selesai.' });
  } catch (e) { return next(e); }
});

module.exports = router;
