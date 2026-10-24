'use strict';
/** Profil — lihat, edit profil, ganti password. */
const express = require('express');
const bcrypt = require('bcryptjs');
const { q, one } = require('../db');
const { publicUser, json } = require('../auth');

const router = express.Router();

/**
 * B5 — validasi profil SEBELUM UPDATE. Kolom live users.username varchar(50) dan
 * users.email varchar(100); sebelumnya username cuma dicek min-3 dan email TANPA
 * validasi sama sekali, jadi email 106 karakter / ber-NUL / username 60 karakter
 * lolos lalu PostgreSQL melempar SQLSTATE 22001 (value too long) / 22021 (NUL)
 * → 500. Kini 422 kontrak {message:'Data tidak valid.', errors:{<kolom>:[pesan]}}.
 * Pesan & pola sama dengan src/routes/user.js (emailError / G10).
 */
const MAX_USERNAME = 50;
const MAX_EMAIL = 100;
const NUL = '\u0000';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** B5 — username 3..50 + tanpa NUL. Falsy (tidak dikirim / '') → lolos, seperti lama. */
function usernameError(username) {
  if (!username) return null;
  const u = String(username).trim(); // nilai yang DISIMPAN: lower(trim($1))
  if (u.length < 3) return ['Nama pengguna min 3 karakter.'];
  if (u.includes(NUL)) return ['Nama pengguna tidak boleh mengandung karakter terlarang.'];
  if (u.length > MAX_USERNAME) return [`Nama pengguna maks ${MAX_USERNAME} karakter.`];
  return null;
}

/** B5 — email wajib format + <=100 + tanpa NUL. null/undefined → coalesce, tanpa ubahan. */
function emailError(email) {
  if (email === null || email === undefined) return null;
  if (String(email).trim() === '') return ['Email wajib diisi.'];
  if (typeof email !== 'string' || !EMAIL_RE.test(String(email).trim())) return ['Format email tidak valid.'];
  if (String(email).includes(NUL)) return ['Email tidak boleh mengandung karakter terlarang.'];
  if (String(email).length > MAX_EMAIL) return [`Email maks ${MAX_EMAIL} karakter.`];
  return null;
}

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
    // B5 — username 3..50 + NUL, email format + <=100 + NUL — semua SEBELUM SQL.
    const un = usernameError(username);
    if (un) errors.username = un;
    if (email !== undefined) {
      const em = emailError(email);
      if (em) errors.email = em;
    }
    if (Object.keys(errors).length) return json(res, 422, { message: 'Data tidak valid.', errors });

    const row = await one(
      `UPDATE users SET username = coalesce(lower(trim($1)), username), email = coalesce($2, email), updated_at = now()
       WHERE id = $3 RETURNING id, username, email, level, is_demo, created_at, updated_at`,
      [username ?? null, email ?? null, req.user.sub],
    );
    // Audit trail — aksi 'update' (bukan 'create', walau metodenya POST).
    req.audit = { aksi: 'update', tabel: 'users', row_id: String(row.id), before: null, after: publicUser(row) };
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
    if (!baru || String(baru).length < 8) errors.password = ['Password baru min 8 karakter.'];
    if (baru !== ulang) errors.password_confirmation = ['Konfirmasi password tidak cocok.'];
    if (Object.keys(errors).length) return json(res, 422, { message: 'Data tidak valid.', errors });

    const user = await one('SELECT * FROM users WHERE id = $1', [req.user.sub]);
    const hashLama = user ? String(user.password).replace(/^\$2y\$/, '$2b$') : '';
    if (!user || !(await bcrypt.compare(String(lama || ''), hashLama))) {
      return json(res, 422, { message: 'Password lama salah.', errors: { password_lama: ['Password lama salah.'] } });
    }
    const hash = await bcrypt.hash(String(baru), 12); // cost 12
    await q('UPDATE users SET password = $1, updated_at = now() WHERE id = $2', [hash, req.user.sub]);
    // Audit trail — PERISTIWA ganti password tercatat, nilainya TIDAK PERNAH
    // (kunci password dibuang src/audit.js); detail cukup meta.perubahan.
    req.audit = {
      aksi: 'update',
      tabel: 'users',
      row_id: String(req.user.sub),
      before: null,
      after: null,
      meta: { perubahan: 'Password' },
    };
    res.json({ status: true, message: 'Perubahan tersimpan.' });
  } catch (e) { next(e); }
});

module.exports = router;
