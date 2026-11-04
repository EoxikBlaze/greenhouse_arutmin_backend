'use strict';
/**
 * Uji Lab hasil panen (tabel uji_lab) — mount: app.use('/uji-lab', ujiLab).
 *   GET    /uji-lab/parameter                spesifikasi parameter per kategori (buah|sayur)
 *   GET    /uji-lab?kategori=&parameter=&limit=   riwayat (terbaru dulu)
 *   POST   /uji-lab                          {kategori, tanggal?, id_siklus_budidaya?, catatan?, hasil:[{parameter,nilai}]}
 *   DELETE /uji-lab/:id                      admin
 */
const express = require('express');
const { pool, q } = require('../db');
const { requireAuth, requireRole, demoGuard, json } = require('../auth');
const { idValidValue } = require('./_id');
const { PARAMETER, KATEGORI, validasi } = require('../ujiLab');

const router = express.Router();
router.use(requireAuth, requireRole(['admin', 'demo']));
const tulis = [requireRole(['admin']), demoGuard('uji_lab.store')];

router.get('/parameter', (_req, res) => json(res, 200, { status: true, bawaan: 'buah', data: PARAMETER }));

router.get('/', async (req, res, next) => {
  try {
    const { kategori, parameter } = req.query;
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    if (kategori !== undefined && !KATEGORI.includes(kategori)) {
      return json(res, 422, { message: 'Data tidak valid.', errors: { kategori: ['kategori harus buah atau sayur.'] } });
    }
    if (parameter !== undefined && (typeof parameter !== 'string' || parameter.length > 40)) {
      return json(res, 422, { message: 'Data tidak valid.', errors: { parameter: ['parameter tidak valid.'] } });
    }
    const rows = await q(
      `SELECT l.id, l.kategori, l.tanggal, l.parameter, l.nilai::float8 AS nilai, l.satuan, l.catatan,
              l.id_siklus_budidaya, u.username AS dicatat_oleh, l.created_at
         FROM uji_lab l LEFT JOIN users u ON u.id = l.dicatat_oleh
        WHERE ($1::text IS NULL OR l.kategori = $1) AND ($2::text IS NULL OR l.parameter = $2)
        ORDER BY l.tanggal DESC, l.id DESC LIMIT $3`,
      [kategori ?? null, parameter ?? null, limit]);
    return json(res, 200, { status: true, data: rows });
  } catch (e) { return next(e); }
});

router.post('/', ...tulis, async (req, res, next) => {
  const v = validasi(req.body);
  if (!v.ok) return json(res, 422, { message: 'Data tidak valid.', errors: v.errors });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ids = [];
    for (const r of v.baris) {
      const x = await client.query(
        `INSERT INTO uji_lab (kategori, tanggal, parameter, nilai, satuan, catatan, id_siklus_budidaya, dicatat_oleh)
         VALUES ($1, COALESCE($2::date, (now() AT TIME ZONE 'Asia/Makassar')::date), $3, $4, $5, $6, $7, $8) RETURNING id`,
        [v.kategori, v.tanggal, r.parameter, r.nilai, r.satuan, v.catatan, v.id_siklus_budidaya, Number(req.user.sub) || null]);
      ids.push(Number(x.rows[0].id));
    }
    await client.query('COMMIT');
    req.audit = { aksi: 'create', tabel: 'uji_lab', row_id: String(ids[0]), before: null, after: { kategori: v.kategori, jumlah: ids.length }, meta: { ids } };
    return json(res, 201, { status: true, message: `${ids.length} hasil uji lab disimpan.`, ids });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.code === '23503') return json(res, 422, { message: 'Data tidak valid.', errors: { id_siklus_budidaya: ['Siklus tanam tidak ditemukan.'] } });
    return next(e);
  } finally { client.release(); }
});

router.delete('/:id', ...tulis, async (req, res, next) => {
  if (!idValidValue(req.params.id)) return json(res, 404, { message: 'Data tidak ditemukan.' });
  try {
    const r = await q('DELETE FROM uji_lab WHERE id = $1 RETURNING id, kategori, parameter, nilai::float8 AS nilai', [req.params.id]);
    if (!r.length) return json(res, 404, { message: 'Data tidak ditemukan.' });
    req.audit = { aksi: 'delete', tabel: 'uji_lab', row_id: String(r[0].id), before: r[0], after: null };
    return json(res, 200, { status: true, message: 'Hasil uji lab dihapus.' });
  } catch (e) { return next(e); }
});

module.exports = router;
