'use strict';
/**
 * Validasi parameter keselamatan oleh admin (Fase 3B.2).
 *
 *   GET  /api/parameter                               status semua parameter (semua login)
 *   POST /api/parameter/:tabel/:param/validasi        {nilai_diperiksa, bukti}             admin (bukan demo)
 *
 * Aturan:
 *  - Hanya parameter yang punya aturan tipe (src/parameter.js ATURAN) dan nilainya SAH.
 *  - `nilai_diperiksa` wajib SAMA dengan nilai aktif di DB, dicek di transaksi dengan FOR UPDATE: nilai yang
 *    berubah sebelum/selama validasi → 409, tidak pernah memvalidasi nilai yang tidak dilihat admin.
 *  - `bukti` (dokumen/uji alat/pihak berwenang) 20–2000 karakter; tidak ada jalan pintas `{tervalidasi:true}`.
 *  - Nilai berubah kemudian → status gugur otomatis (trigger migrasi 2026-10-29_03).
 *  - Tercatat di audit_logs.
 */
const crypto = require('crypto');
const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole, demoGuard, json } = require('../auth');
const { bacaParameter, SEMUA, ATURAN, tafsir } = require('../parameter');

const router = express.Router();
const TABEL = ['konfigurasi_dosis', 'timing_operasi'];

router.get('/', requireAuth, requireRole('all'), async (_req, res, next) => {
  try { return res.json(Object.values(await bacaParameter(SEMUA))); } catch (e) { return next(e); }
});

router.post('/:tabel/:param/validasi', requireAuth, requireRole(['admin']), demoGuard('parameter.validasi'), async (req, res, next) => {
  const { tabel, param } = req.params;
  if (!TABEL.includes(tabel) || !/^[a-z0-9_]{1,64}$/.test(param)) return json(res, 404, { message: 'Data tidak ditemukan.', errors: {} });
  const aturan = ATURAN[tabel][param];
  if (!aturan) return json(res, 422, { message: 'Parameter ini belum punya aturan validasi; tidak bisa ditandai tervalidasi.', kode: 'aturan_belum_ada' });
  const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const errors = {};
  const diperiksa = tafsir(b.nilai_diperiksa, aturan);
  if (diperiksa.status !== 'SAH') errors.nilai_diperiksa = [`Nilai yang diperiksa wajib angka sah (${diperiksa.alasan}).`];
  const bukti = typeof b.bukti === 'string' ? b.bukti.trim() : '';
  if (bukti.length < 20 || bukti.length > 2000) errors.bukti = ['Bukti validasi (dokumen/uji alat/pihak berwenang) 20–2000 karakter.'];
  if (Object.keys(errors).length) return json(res, 422, { message: 'Data tidak valid.', errors });

  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const lama = (await c.query(`SELECT * FROM ${tabel} WHERE param = $1 FOR UPDATE`, [param])).rows[0];
    if (!lama) { await c.query('ROLLBACK'); return json(res, 404, { message: 'Data tidak ditemukan.', errors: {} }); }
    const aktif = tafsir(lama.nilai, aturan);
    if (aktif.status !== 'SAH') {
      await c.query('ROLLBACK');
      return json(res, 409, { message: `Nilai aktif tidak sah (${aktif.alasan}); isi nilai dulu.`, kode: 'nilai_tidak_sah' });
    }
    if (aktif.nilai !== diperiksa.nilai) {
      await c.query('ROLLBACK');
      return json(res, 409, { message: 'Nilai aktif berbeda dari nilai yang diperiksa (sudah berubah). Periksa ulang.', kode: 'nilai_berubah', nilai_aktif: aktif.nilai });
    }
    if (lama.tervalidasi) {
      await c.query('ROLLBACK');
      return json(res, 409, { message: 'Nilai ini sudah tervalidasi.', kode: 'sudah_tervalidasi' });
    }
    const baru = (await c.query(
      `UPDATE ${tabel} SET tervalidasi = true, divalidasi_oleh = $2, divalidasi_pada = now(), catatan_validasi = $3
        WHERE param = $1 RETURNING param, nilai, satuan, tervalidasi, divalidasi_oleh, divalidasi_pada, catatan_validasi`,
      [param, req.user.sub, bukti])).rows[0];
    await c.query(
      `INSERT INTO audit_logs (actor_user_id, actor_tipe, actor_label, aksi, tabel, row_id, before_data, after_data, request_id, meta)
       VALUES ($1, 'user', $2, 'config_change', $3, $4, $5, $6, $7, $8)`,
      [req.user.sub, req.user.username ?? null, tabel, param, { nilai: lama.nilai, tervalidasi: false },
        { nilai: lama.nilai, tervalidasi: true, bukti }, crypto.randomUUID(), { level: req.user.level, aksi: 'validasi_parameter' }]);
    await c.query('COMMIT');
    return res.json({ status: true, data: baru });
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    return next(e);
  } finally {
    c.release();
  }
});

module.exports = router;
