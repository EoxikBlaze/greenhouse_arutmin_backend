'use strict';
/** Profil — lihat, edit profil, ganti password. */
const express = require('express');
const bcrypt = require('bcryptjs');
const { q, one } = require('../db');
const { publicUser, json } = require('../auth');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const user = await one('SELECT * FROM users WHERE id = $1', [req.user.sub]);
    res.json({ page: 'profil', user: publicUser(user) });
  } catch (e) { next(e); }
});

router.post('/update', async (req, res, next) => {
  try {
    if (req.user.demo) return json(res, 403, { message: 'Mode demo tidak boleh mengubah profil.' });
    const { username, email } = req.body || {};
    const errors = {};
    if (username && String(username).trim().length < 3) errors.username = ['Nama pengguna min 3 karakter.'];
    if (Object.keys(errors).length) return json(res, 422, { message: 'Data tidak valid.', errors });

    const row = await one(
      `UPDATE users SET username = coalesce(lower(trim($1)), username), email = coalesce($2, email), updated_at = now()
       WHERE id = $3 RETURNING id, username, email, level, is_demo, created_at, updated_at`,
      [username ?? null, email ?? null, req.user.sub],
    );
    res.json({ status: true, message: 'Perubahan tersimpan.', user: publicUser(row) });
  } catch (e) { next(e); }
});

router.get('/password', (_req, res) => {
  res.json({ page: 'profil.password', fields: ['password_lama', 'password', 'password_confirmation'] });
});

router.post('/password', async (req, res, next) => {
  try {
    if (req.user.demo) return json(res, 403, { message: 'Mode demo tidak boleh mengganti password.' });
    const { password_lama: lama, password: baru, password_confirmation: ulang } = req.body || {};
    const errors = {};
    if (!baru || String(baru).length < 6) errors.password = ['Password baru min 6 karakter.'];
    if (baru !== ulang) errors.password_confirmation = ['Konfirmasi password tidak cocok.'];
    if (Object.keys(errors).length) return json(res, 422, { message: 'Data tidak valid.', errors });

    const user = await one('SELECT * FROM users WHERE id = $1', [req.user.sub]);
    const hashLama = user ? String(user.password).replace(/^\$2y\$/, '$2b$') : '';
    if (!user || !(await bcrypt.compare(String(lama || ''), hashLama))) {
      return json(res, 422, { message: 'Password lama salah.', errors: { password_lama: ['Password lama salah.'] } });
    }
    const hash = await bcrypt.hash(String(baru), 12); // cost 12
    await q('UPDATE users SET password = $1, updated_at = now() WHERE id = $2', [hash, req.user.sub]);
    res.json({ status: true, message: 'Perubahan tersimpan.' });
  } catch (e) { next(e); }
});

module.exports = router;
