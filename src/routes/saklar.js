'use strict';
/**
 * Saklar aktuator — mount: app.use('/saklar', saklar).
 *   GET /saklar          semua login (dibaca Dashboard)
 *   PUT /saklar/:kode    {aktif:boolean}  admin; dicatat ke audit_logs (siapa, kapan, dari/ke)
 */
const express = require('express');
const { requireAuth, requireRole, demoGuard, json } = require('../auth');
const saklar = require('../saklar');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (_req, res, next) => {
  try { json(res, 200, { status: true, data: await saklar.daftar() }); } catch (e) { next(e); }
});

router.put('/:kode', requireRole(['admin']), demoGuard('saklar.ubah'), async (req, res, next) => {
  try {
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    if (typeof b.aktif !== 'boolean') {
      return json(res, 422, { message: 'Data tidak valid.', errors: { aktif: ['aktif harus true atau false.'] } });
    }
    const r = await saklar.ubah(req.params.kode, b.aktif, Number(req.user.sub) || null);
    if (!r) return json(res, 404, { message: 'Saklar tidak ditemukan.' });
    req.audit = {
      aksi: 'config_change', tabel: 'saklar_aktuator', row_id: r.sesudah.kode,
      before: { aktif: r.sebelum.aktif }, after: { aktif: r.sesudah.aktif },
      meta: { dari: r.sebelum.aktif ? 'ON' : 'OFF', ke: r.sesudah.aktif ? 'ON' : 'OFF' },
    };
    return json(res, 200, { status: true, message: `Saklar ${r.sesudah.nama} ${r.sesudah.aktif ? 'ON' : 'OFF'}.`, data: await saklar.daftar() });
  } catch (e) { return next(e); }
});

module.exports = router;
