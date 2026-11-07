'use strict';
/** Auth — GET /login (info), POST /login, GET /logout, GET / (info). */
const express = require('express');
const { verifyLogin, signToken, publicUser, json } = require('../auth');
const sesiCookie = require('../sesiCookie');

const router = express.Router();

router.get('/', (_req, res) => {
  json(res, 200, { message: 'GARAP API — gunakan POST /login untuk autentikasi.' });
});

router.get('/login', (_req, res) => {
  json(res, 200, { message: 'Endpoint autentikasi. Gunakan POST /login {username,password}.' });
});

router.post('/login', async (req, res, next) => {
  try {
    const { username, password, remember } = req.body || {};
    const errors = {};
    if (!username || String(username).trim().length < 3) errors.username = ['Nama pengguna wajib diisi (min 3 karakter).'];
    if (!password || String(password).length < 3) errors.password = ['Kata sandi wajib diisi (min 3 karakter).'];
    if (Object.keys(errors).length) {
      return json(res, 422, { message: 'Data tidak valid.', errors, input: { username } });
    }

    const user = await verifyLogin(username, password);
    if (!user) {
      return json(res, 422, {
        message: 'Username / Password salah.',
        errors: { username: ['Username / Password salah.'] },
        input: { username },
      });
    }

    // Audit trail — sukses login dicatat middleware auditTrail (src/index.js);
    // aktor diambil dari akun yang baru masuk (req.user belum terisi di rute ini).
    req.audit = {
      aksi: 'login',
      tabel: 'users',
      row_id: String(user.id),
      actor: { id: user.id, label: user.username, level: user.level },
      before: null,
      after: { username: user.username, level: user.level, ingat: !!remember },
    };

    // Web/Mobile: mendukung Bearer token berumur panjang (default 10 tahun) maupun cookie HttpOnly.
    const ingat = remember !== false;
    const token = signToken(user, ingat);
    const lewatCookie = req.body?.sesi === 'cookie';
    if (lewatCookie) sesiCookie.pasangSesi(req, res, token, ingat);
    json(res, 200, {
      status: true,
      message: 'Login berhasil.',
      ...(lewatCookie ? {} : { token }),
      user: publicUser(user),
      redirect: user.level === 'petani' ? '/tanam' : '/dashboard',
    });
  } catch (e) { next(e); }
});

function keluar(req, res) {
  // JWT stateless: klien Bearer membuang token; cookie sesi web dihapus di sini.
  sesiCookie.hapusSesi(req, res);
  json(res, 200, { status: true, message: 'Berhasil logout.', redirect: '/login' });
}
router.get('/logout', keluar);
router.post('/logout', keluar);

module.exports = router;
