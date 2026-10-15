'use strict';
/**
 * CRUD generik — menggantikan Route::resource() Laravel (path 1:1, JSON-only).
 *   GET /x           → daftar (opsional ?q= search sederhana)
 *   POST /x          → tambah (roleName.store)
 *   GET /x/:id       → detail
 *   PUT|PATCH /x/:id → ubah (roleName.update)
 *   DELETE /x/:id    → hapus (roleName.destroy)
 */
const express = require('express');
const { q, one } = require('../db');
const { demoExpiry } = require('../auth');

function crudRouter({ table, pk, columns, name, orderBy, withJoins }) {
  const router = express.Router();
  const cols = columns.join(', ');
  const select = withJoins
    ? `SELECT ${columns.map((c) => `${table}.${c}`).join(', ')}${withJoins ? ', ' + withJoins : ''} FROM ${table}`
    : `SELECT ${cols} FROM ${table}`;

  router.get('/', async (req, res, next) => {
    try {
      res.json(await q(`${select} ORDER BY ${orderBy || pk} DESC`));
    } catch (e) { next(e); }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      const row = await one(`${select} WHERE ${table}.${pk} = $1`, [req.params.id]);
      if (!row) return res.status(404).json({ message: 'Data tidak ditemukan.' });
      res.json(row);
    } catch (e) { next(e); }
  });

  router.post('/', async (req, res, next) => {
    try {
      const fields = columns.filter((c) => c in req.body);
      if (fields.length === 0) return res.status(422).json({ message: 'Tidak ada data yang dikirim.', errors: {} });
      const exp = demoExpiry(req.user);
      const allFields = exp ? [...fields, 'expires_at'] : fields;
      const values = fields.map((c) => req.body[c]);
      const ph = fields.map((_, i) => `$${i + 1}`);
      if (exp) { values.push(exp); ph.push(`$${values.length}`); }
      const row = await one(
        `INSERT INTO ${table} (${allFields.join(', ')}) VALUES (${ph.join(', ')}) RETURNING *`,
        values,
      );
      res.status(201).json({ status: true, message: 'Data berhasil ditambahkan.', data: row });
    } catch (e) { next(e); }
  });

  const update = async (req, res, next) => {
    try {
      const fields = columns.filter((c) => c in req.body);
      if (fields.length === 0) return res.status(422).json({ message: 'Tidak ada data yang dikirim.', errors: {} });
      const sets = fields.map((c, i) => `${c} = $${i + 1}`);
      const values = fields.map((c) => req.body[c]);
      values.push(req.params.id);
      const row = await one(
        `UPDATE ${table} SET ${sets.join(', ')}, updated_at = now() WHERE ${pk} = $${values.length} RETURNING *`,
        values,
      );
      if (!row) return res.status(404).json({ message: 'Data tidak ditemukan.' });
      res.json({ status: true, message: 'Data berhasil diperbarui.', data: row });
    } catch (e) { next(e); }
  };
  router.put('/:id', update);
  router.patch('/:id', update);

  router.delete('/:id', async (req, res, next) => {
    try {
      const row = await one(`DELETE FROM ${table} WHERE ${pk} = $1 RETURNING *`, [req.params.id]);
      if (!row) return res.status(404).json({ message: 'Data tidak ditemukan.' });
      res.json({ status: true, message: 'Data dihapus.' });
    } catch (e) { next(e); }
  });

  return router;
}

module.exports = { crudRouter };
