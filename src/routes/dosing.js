'use strict';
/**
 * API alur persetujuan dosing (Fase 3C, docs/DESAIN_FASE2.md §5.3). EKSEKUSI DOSIS TETAP DIBLOKIR.
 *
 *   GET  /api/dosing/siklus                 daftar (?id_meja=&status=)                            semua login
 *   GET  /api/dosing/siklus/:id             detail + persetujuan + percobaan + transisi           semua login
 *   POST /api/dosing/siklus                 {id_siklus_budidaya, alasan?} → WAITING_APPROVAL      ★ admin/petani
 *   POST /api/dosing/siklus/:id/setujui     {cakupan:{pompa_diizinkan, maks_ml_per_percobaan, maks_ml_total,
 *                                             maks_percobaan, berlaku_menit}, alasan?} → APPROVED  ★ admin/petani
 *   POST /api/dosing/siklus/:id/tolak       {alasan?} → REJECTED                                   ★ admin/petani
 *   POST /api/dosing/siklus/:id/cabut       {alasan} → CANCELLED (+ STOP bila RUNNING)             ★ admin/petani
 *   POST /api/dosing/siklus/:id/jalankan    selalu 423 eksekusi_diblokir (atau FAULT bila sensor rusak) ★ admin/petani
 *
 * ★ = wajib header Idempotency-Key (UUID). Petani hanya untuk penampung yang ditugaskan (dicek di layanan).
 */
const express = require('express');
const { json } = require('../auth');
const { idValidValue } = require('./_id');
const svc = require('../dosingSiklus');
const { bantu } = require('./siklusBudidaya');

const { baca, tulis, kunciIdem, kirimGalat, aktorDari, tidakDitemukan } = bantu;
const router = express.Router();

router.use(async (_req, res, next) => {
  try {
    if (await svc.fiturTersedia()) return next();
    return json(res, 503, { message: 'Alur persetujuan dosing belum dimigrasi di database ini.', kode: 'belum_dimigrasi' });
  } catch (e) { return next(e); }
});

router.get('/siklus', ...baca, async (req, res, next) => {
  try {
    const f = {};
    if (req.query.id_meja !== undefined) {
      if (!idValidValue(req.query.id_meja)) return json(res, 422, { message: 'Data tidak valid.', errors: { id_meja: ['id_meja harus id angka.'] } });
      f.id_meja = req.query.id_meja;
    }
    if (req.query.status !== undefined) {
      if (typeof req.query.status !== 'string' || !(req.query.status in svc.JALUR)) return json(res, 422, { message: 'Data tidak valid.', errors: { status: ['Status tidak dikenal.'] } });
      f.status = req.query.status;
    }
    return json(res, 200, { status: true, data: await svc.daftar(f) });
  } catch (e) { return next(e); }
});

router.get('/siklus/:id', ...baca, async (req, res, next) => {
  if (!idValidValue(req.params.id)) return tidakDitemukan(res);
  try {
    const d = await svc.detail(req.params.id);
    return d ? json(res, 200, { status: true, data: d }) : tidakDitemukan(res);
  } catch (e) { return next(e); }
});

/** Rute tulis: validasi :id + Idempotency-Key, jalankan, balas detail siklus dosing. */
function rutaTulis(fn, { pakaiId = true } = {}) {
  return async (req, res, next) => {
    if (pakaiId && !idValidValue(req.params.id)) return tidakDitemukan(res);
    const idem = kunciIdem(req, res);
    if (!idem) return undefined;
    try {
      const r = await fn(req, idem);
      const data = await svc.detail(r.id_kejadian);
      return json(res, r.baru ? 201 : 200, { status: true, replay: Boolean(r.replay), ...(r.stop ? { stop: r.stop } : {}), data });
    } catch (e) {
      // 501 = jalur eksekusi belum ada: tetap galat terkontrol, bukan 500
      if (e instanceof svc.DosingGalat && e.status === 501) return json(res, 501, { message: e.message, kode: e.kode });
      return kirimGalat(res, next, e);
    }
  };
}

router.post('/siklus', ...tulis, rutaTulis((req, idem) => svc.ajukan(req.body, aktorDari(req), idem), { pakaiId: false }));
router.post('/siklus/:id/setujui', ...tulis, rutaTulis((req, idem) => svc.setujui(Number(req.params.id), req.body, aktorDari(req), idem)));
router.post('/siklus/:id/tolak', ...tulis, rutaTulis((req, idem) => svc.tolak(Number(req.params.id), req.body, aktorDari(req), idem)));
router.post('/siklus/:id/cabut', ...tulis, rutaTulis((req, idem) => svc.cabut(Number(req.params.id), req.body, aktorDari(req), idem)));
router.post('/siklus/:id/jalankan', ...tulis, rutaTulis((req, idem) => svc.jalankan(Number(req.params.id), aktorDari(req), idem)));

module.exports = router;
