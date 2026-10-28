'use strict';
/** Water Control — status polling. Perintah tulis NONAKTIF (lihat nonaktif()). */
const express = require('express');
const { one } = require('../db');
const { demoGuard, json } = require('../auth');

const router = express.Router();

/**
 * NONAKTIF (Fase 3B.2): FORCE_FILL/FORCE_STOP/mode dulu hanya disimpan di water_controls dan hanya terbaca
 * lewat balasan rute lama /api/saveSensor. Firmware v0.2 (MQTT) tidak membacanya dan tidak ada konfirmasi
 * perangkat, jadi "berhasil" di layar palsu. Ditolak (tanpa mengubah DB) sampai jalur ISI_AIR lewat antrean
 * aktuator — yang punya laporan hasil — dipasang di UI. Kode lama ada di riwayat git (fe0f51c).
 */
function nonaktif(_req, res) {
  return json(res, 503, {
    message: 'Kontrol air dari aplikasi dinonaktifkan: perangkat saat ini tidak menerima maupun mengonfirmasi perintah ini. Gunakan katup/saklar fisik.',
    kode: 'kontrol_air_nonaktif',
  });
}

router.get('/', async (_req, res, next) => {
  try { res.json({ page: 'watercontrol', wc: await one('SELECT * FROM water_controls ORDER BY id LIMIT 1') }); }
  catch (e) { next(e); }
});

router.get('/status', async (_req, res, next) => {
  try { res.json(await one('SELECT * FROM water_controls ORDER BY id LIMIT 1')); }
  catch (e) { next(e); }
});

router.post('/fill', demoGuard('watercontrol.fill'), nonaktif);
router.post('/stop', demoGuard('watercontrol.stop'), nonaktif);
router.post('/setMode', demoGuard('watercontrol.mode'), nonaktif);

module.exports = router;
