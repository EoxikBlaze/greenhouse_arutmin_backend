'use strict';
/** Manajemen User — CRUD akun (level admin/user/petani + flag demo). */
const express = require('express');
const bcrypt = require('bcryptjs');
const { q, one } = require('../db');
const { publicUser, json } = require('../auth');

const router = express.Router();

const LEVELS = ['admin', 'user', 'petani'];

router.get('/', async (_req, res, next) => {
  try {
    const rows = await q('SELECT * FROM users ORDER BY id DESC');
    res.json(rows.map(publicUser));
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    if (req.user.demo) return json(res, 403, { message: 'Mode demo tidak boleh mengelola user.' });
    const { username, email, password, level = 'user', is_demo = false } = req.body || {};
    const errors = {};
    if (!username || String(username).trim().length < 3) errors.username = ['Nama pengguna min 3 karakter.'];
    if (!password || String(password).length < 6) errors.password = ['Password min 6 karakter.'];
    if (!LEVELS.includes(level)) errors.level = ['Level harus admin/user/petani.'];
    if (Object.keys(errors).length) return json(res, 422, { message: 'Data tidak valid.', errors });

    const hash = await bcrypt.hash(String(password), 12); // cost 12 — lebih keras dari default
    const row = await one(
      `INSERT INTO users (username, email, password, level, is_demo, created_at, updated_at)
       VALUES (lower(trim($1)), $2, $3, $4, $5, now(), now()) RETURNING *`,
      [username, email ?? null, hash, level, !!is_demo],
    );
    res.status(201).json({ status: true, message: 'User berhasil ditambahkan.', data: publicUser(row) });
  } catch (e) {
    if (String(e.message).includes('unique')) {
      return json(res, 422, { message: 'Data tidak valid.', errors: { username: ['Username sudah dipakai.'] } });
    }
    next(e);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const row = await one('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (!row) return json(res, 404, { message: 'Data tidak ditemukan.' });
    res.json(publicUser(row));
  } catch (e) { next(e); }
});

router.put('/:id', async (req, res, next) => {
  try {
    if (req.user.demo) return json(res, 403, { message: 'Mode demo tidak boleh mengelola user.' });
    const { username, email, password, level, is_demo } = req.body || {};
    if (level && !LEVELS.includes(level)) {
      return json(res, 422, { message: 'Data tidak valid.', errors: { level: ['Level harus admin/user/petani.'] } });
    }
    const sets = [];
    const values = [];
    const add = (col, val) => { values.push(val); sets.push(`${col} = $${values.length}`); };
    if (username) add('username', String(username).trim().toLowerCase());
    if (email !== undefined) add('email', email);
    if (level) add('level', level);
    if (is_demo !== undefined) add('is_demo', !!is_demo);
    if (password) add('password', await bcrypt.hash(String(password), 12));
    if (sets.length === 0) return json(res, 422, { message: 'Tidak ada data yang dikirim.', errors: {} });
    values.push(req.params.id);
    const row = await one(
      `UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $${values.length} RETURNING *`, values);
    if (!row) return json(res, 404, { message: 'Data tidak ditemukan.' });
    res.json({ status: true, message: 'User berhasil diperbarui.', data: publicUser(row) });
  } catch (e) { next(e); }
});

router.patch('/:id', (req, res, next) => {
  req.method = 'PUT';
  router.handle(req, res, next);
});

router.delete('/:id', async (req, res, next) => {
  try {
    if (req.user.demo) return json(res, 403, { message: 'Mode demo tidak boleh mengelola user.' });
    if (Number(req.params.id) === Number(req.user.sub)) {
      return json(res, 422, { message: 'Tidak bisa hapus akun sendiri.', errors: { msg: ['Tidak bisa hapus akun sendiri.'] } });
    }
    const row = await one('DELETE FROM users WHERE id = $1 RETURNING *', [req.params.id]);
    if (!row) return json(res, 404, { message: 'Data tidak ditemukan.' });
    res.json({ status: true, message: 'User dihapus.' });
  } catch (e) { next(e); }
});

module.exports = router;
