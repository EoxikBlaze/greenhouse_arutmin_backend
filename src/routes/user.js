'use strict';
/** Manajemen User — CRUD akun (level admin/user/petani + flag demo). */
const express = require('express');
const bcrypt = require('bcryptjs');
const { q, one } = require('../db');
const { publicUser, json } = require('../auth');
const { idValid, notFound } = require('./_id');

const router = express.Router();

const LEVELS = ['admin', 'user', 'petani'];
/**
 * G10 — pola email minimum (tanpa dependensi): tanpa spasi, punya @ dan domain
 * ber-titik. Kolom users.email NOT NULL — dahulu body tanpa email lolos validasi
 * lalu 23502 → 500, dan objek {"a":1} justru TERSIMPAN sebagai teks (201 lolos).
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** G10 — galat 422 utk field email (dipakai POST & PUT; null/kosong = wajib). */
function emailError(email) {
  if (email === null || email === undefined || String(email).trim() === '') return ['Email wajib diisi.'];
  if (typeof email !== 'string' || !EMAIL_RE.test(String(email).trim())) return ['Format email tidak valid.'];
  return null;
}

// V1 — validasi path param :id. users.id adalah bigint, jadi id non-angka membuat
// PostgreSQL gagal parse ("invalid input syntax for bigint") → 500 generik.
// V2 — id yang lolos regex tapi MELEBIHI rentang bigint tetap membuat PostgreSQL
// melempar SQLSTATE 22003 → 500; rentang dicek di sini dengan BigInt (predikat di
// depan query — alasan lengkap ada di _crud.js validId). Dipakai DI DALAM handler
// (setelah cek demo) supaya urutan jawaban 403 demo tidak berubah.
// Definisi bersama (BIGINT_MAX / idValid / notFound) kini ada di ./_id.

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
    // G10 — email wajib + format (dulu tanpa cek → 23502 → 500; objek lolos 201).
    const em = emailError(email);
    if (em) errors.email = em;
    if (Object.keys(errors).length) return json(res, 422, { message: 'Data tidak valid.', errors });

    const hash = await bcrypt.hash(String(password), 12); // cost 12 — lebih keras dari default
    const row = await one(
      `INSERT INTO users (username, email, password, level, is_demo, created_at, updated_at)
       VALUES (lower(trim($1)), $2, $3, $4, $5, now(), now())
       RETURNING id, username, email, level, is_demo, created_at, updated_at`,
      [username, email ?? null, hash, level, !!is_demo],
    );
    res.status(201).json({ status: true, message: 'User berhasil ditambahkan.', data: publicUser(row) });
  } catch (e) {
    // G10 — 23505 dipetakan per-field: constraint email → 'Email sudah dipakai.'
    // (dulu SEMUA unique menjawab pesan username yang keliru).
    if (e && (e.code === '23505' || String(e.message).includes('unique'))) {
      const field = String(e.constraint || e.message).includes('email') ? 'email' : 'username';
      const pesan = field === 'email' ? 'Email sudah dipakai.' : 'Username sudah dipakai.';
      return json(res, 422, { message: 'Data tidak valid.', errors: { [field]: [pesan] } });
    }
    next(e);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    if (!idValid(req)) return notFound(res);
    const row = await one('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (!row) return notFound(res);
    res.json(publicUser(row));
  } catch (e) { next(e); }
});

router.put('/:id', async (req, res, next) => {
  try {
    if (req.user.demo) return json(res, 403, { message: 'Mode demo tidak boleh mengelola user.' });
    if (!idValid(req)) return notFound(res);
    // G10 — urutan '404 identik' (kontrak §2b): baris dicek SEBELUM validasi body.
    // Dulu PUT /user/999999 dgn body invalid → 422 tapi dgn body valid → 404 —
    // jawaban bergantung isi body. Pesan 422 utk id-ADA + body-invalid TETAP sama.
    const lama = await one('SELECT id FROM users WHERE id = $1', [req.params.id]);
    if (!lama) return notFound(res);
    const { username, email, password, level, is_demo } = req.body || {};
    const errors = {};
    if (level && !LEVELS.includes(level)) errors.level = ['Level harus admin/user/petani.'];
    // G10 — email null/kosong dulu → 23502 (500); format salah dulu lolos apa adanya.
    if (email !== undefined) {
      const em = emailError(email);
      if (em) errors.email = em;
    }
    if (Object.keys(errors).length) return json(res, 422, { message: 'Data tidak valid.', errors });
    const sets = [];
    const values = [];
    const add = (col, val) => { values.push(val); sets.push(`${col} = $${values.length}`); };
    if (username) add('username', String(username).trim().toLowerCase());
    if (email !== undefined) add('email', String(email).trim());
    if (level) add('level', level);
    if (is_demo !== undefined) add('is_demo', !!is_demo);
    if (password) add('password', await bcrypt.hash(String(password), 12));
    if (sets.length === 0) return json(res, 422, { message: 'Tidak ada data yang dikirim.', errors: {} });
    values.push(req.params.id);
    const row = await one(
      `UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $${values.length}
       RETURNING id, username, email, level, is_demo, created_at, updated_at`, values);
    if (!row) return notFound(res);
    res.json({ status: true, message: 'User berhasil diperbarui.', data: publicUser(row) });
  } catch (e) {
    // G10 — 23505 unique (email/username milik lain) → 422 per-field (dulu 500);
    // 23502 sisa → biar jatuh ke mapper global 422 di index.js.
    if (e && (e.code === '23505' || String(e.message).includes('unique'))) {
      const field = String(e.constraint || e.message).includes('email') ? 'email' : 'username';
      const pesan = field === 'email' ? 'Email sudah dipakai.' : 'Username sudah dipakai.';
      return json(res, 422, { message: 'Data tidak valid.', errors: { [field]: [pesan] } });
    }
    next(e);
  }
});

router.patch('/:id', (req, res, next) => {
  req.method = 'PUT';
  router.handle(req, res, next);
});

router.delete('/:id', async (req, res, next) => {
  try {
    if (req.user.demo) return json(res, 403, { message: 'Mode demo tidak boleh mengelola user.' });
    if (!idValid(req)) return notFound(res);
    if (Number(req.params.id) === Number(req.user.sub)) {
      return json(res, 422, { message: 'Tidak bisa hapus akun sendiri.', errors: { msg: ['Tidak bisa hapus akun sendiri.'] } });
    }
    const row = await one(
      'DELETE FROM users WHERE id = $1 RETURNING id, username, email, level, is_demo',
      [req.params.id],
    );
    if (!row) return notFound(res);
    res.json({ status: true, message: 'User dihapus.' });
  } catch (e) { next(e); }
});

module.exports = router;
