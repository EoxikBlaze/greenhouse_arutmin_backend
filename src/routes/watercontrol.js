'use strict';
/** Water Control — AUTO/MANUAL, Isi Air, Stop, status polling. */
const express = require('express');
const { q, one } = require('../db');
const { demoGuard, json } = require('../auth');

const router = express.Router();

router.get('/', async (_req, res, next) => {
  try { res.json({ page: 'watercontrol', wc: await one('SELECT * FROM water_controls ORDER BY id LIMIT 1') }); }
  catch (e) { next(e); }
});

router.get('/status', async (_req, res, next) => {
  try { res.json(await one('SELECT * FROM water_controls ORDER BY id LIMIT 1')); }
  catch (e) { next(e); }
});

router.post('/fill', demoGuard('watercontrol.fill'), async (_req, res, next) => {
  try {
    await q("UPDATE water_controls SET command = 'FORCE_FILL', updated_at = now()");
    res.json({ status: true, message: 'Perintah isi air dikirim.' });
  } catch (e) { next(e); }
});

router.post('/stop', demoGuard('watercontrol.stop'), async (_req, res, next) => {
  try {
    await q("UPDATE water_controls SET command = 'FORCE_STOP', updated_at = now()");
    res.json({ status: true, message: 'Pengisian dihentikan.' });
  } catch (e) { next(e); }
});

router.post('/setMode', demoGuard('watercontrol.mode'), async (req, res, next) => {
  try {
    const mode = String(req.body?.mode || '').toUpperCase();
    if (!['AUTO', 'MANUAL'].includes(mode)) {
      return json(res, 422, { message: 'Data tidak valid.', errors: { mode: ['Mode harus AUTO atau MANUAL.'] } });
    }
    // MANUAL = sistem tidak boleh mengisi sendiri → tutup kran (kontrak Laravel).
    if (mode === 'MANUAL') {
      await q("UPDATE water_controls SET mode = 'MANUAL', command = 'FORCE_STOP', updated_at = now()");
    } else {
      await q("UPDATE water_controls SET mode = 'AUTO', updated_at = now()");
    }
    res.json({
      status: true,
      message: `Mode kerja sistem diubah ke ${mode === 'AUTO' ? 'AUTO (otomatis)' : 'MANUAL (pengguna)'}.`,
    });
  } catch (e) { next(e); }
});

module.exports = router;
