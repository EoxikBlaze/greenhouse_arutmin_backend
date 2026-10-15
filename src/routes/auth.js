'use strict';
/** Auth — GET /login (info), POST /login, GET /logout, GET / (info). */
const express = require('express');
const { verifyLogin, signToken, publicUser, json } = require('../auth');

const router = express.Router();

router.get('/', (_req, res) => {
  json(res, 200, { message: 'Vertonik Smart Farm API — gunakan POST /login untuk autentikasi.' });
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

    json(res, 200, {
      status: true,
      message: 'Login berhasil.',
      token: signToken(user),
      user: publicUser(user),
      redirect: user.level === 'petani' ? '/tanam' : '/dashboard',
    });
  } catch (e) { next(e); }
});

router.get('/logout', (_req, res) => {
  // JWT bersifat stateless — client membuang token.
  json(res, 200, { status: true, message: 'Berhasil logout.', redirect: '/login' });
});

module.exports = router;
