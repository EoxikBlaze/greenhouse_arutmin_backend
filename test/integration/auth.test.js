'use strict';
/**
 * Integripsi #1 — AUTENTIKASI & JWT (login, 401, token cacat).
 * Kontrak: docs/KONTRAK_API.md §auth · src/routes/auth.js · src/auth.js.
 * Server sendiri (PORT bebas) — lihat _server.js; src/ tidak disentuh.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { startServer, adminToken, craftToken, bearer, readEnv } = require('./_server');

let srv;
let base;
const env = readEnv();

before(async () => { srv = await startServer(); base = srv.base; });
after(async () => { if (srv) await srv.stop(); });

test('POST /login valid (admin .env) → 200 + token + user.level=admin', async () => {
  const res = await request(base).post('/login')
    .send({ username: 'garap', password: env.ADMIN_PASSWORD });
  assert.equal(res.status, 200, 'kredensial admin dari .env harus diterima');
  assert.equal(res.body.status, true);
  assert.equal(res.body.user.level, 'admin');
  assert.equal(res.body.user.is_demo, false);
  assert.match(res.body.redirect, /dashboard/);

  const decoded = jwt.decode(res.body.token);
  assert.equal(jwt.decode(res.body.token, { complete: true }).header.alg, 'HS256');
  assert.equal(typeof decoded.exp, 'number', 'token wajib membawa exp');
  assert.ok(decoded.exp > Math.floor(Date.now() / 1000), 'token belum kedaluwarsa');
  // Token benar-benar diterima server (bukan cuma ter-cetak).
  const meja = await request(base).get('/meja').set(bearer(res.body.token));
  assert.equal(meja.status, 200);
});

test('POST /login password salah → 422 terstruktur (bukan 401/500)', async () => {
  const res = await request(base).post('/login')
    .send({ username: 'admin', password: 'kata-sandi-salah-9x' });
  assert.equal(res.status, 422);
  assert.equal(res.body.message, 'Username / Password salah.');
  assert.deepEqual(res.body.errors, { username: ['Username / Password salah.'] });
  assert.equal(res.body.token, undefined, 'tidak boleh mengeluarkan token');
  assert.equal(res.body.input.username, 'admin');
});

test('POST /login validasi gagal (username < 3) → 422 "Data tidak valid."', async () => {
  const res = await request(base).post('/login').send({ username: 'ad', password: 'abc' });
  assert.equal(res.status, 422);
  assert.equal(res.body.message, 'Data tidak valid.');
  assert.ok(Array.isArray(res.body.errors.username));
});

test('GET /meja tanpa token → 401 kontrak', async () => {
  const res = await request(base).get('/meja');
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { message: 'Tidak terautentikasi.' });
});

test('GET /dashboard tanpa token → 401 kontrak (rute terproteksi lain)', async () => {
  const res = await request(base).get('/dashboard');
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { message: 'Tidak terautentikasi.' });
});

test('Authorization rusak ("Bearer bukan-jwt") → 401', async () => {
  const res = await request(base).get('/meja').set(bearer('bukan-jwt.sama.sekali'));
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { message: 'Tidak terautentikasi.' });
});

test('JWT TANPA klaim exp → 401 (wajib payload.exp bernilai number)', async () => {
  const token = craftToken({ sub: 1, username: 'admin', level: 'admin', demo: false });
  assert.equal(jwt.decode(token).exp, undefined, 'pra-kondisi: token memang tanpa exp');
  const res = await request(base).get('/dashboard').set(bearer(token));
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { message: 'Tidak terautentikasi.' });
});

test('JWT kedaluwarsa → 401', async () => {
  const token = craftToken(
    { sub: 1, username: 'admin', level: 'admin', demo: false },
    { expiresIn: -60 },
  );
  const res = await request(base).get('/meja').set(bearer(token));
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { message: 'Tidak terautentikasi.' });
});

test('GET / (info publik) → 200 JSON — endpoint tanpa token tetap terbuka', async () => {
  const res = await request(base).get('/');
  assert.equal(res.status, 200);
  assert.match(res.body.message, /GARAP API/);
  assert.equal(res.headers['x-powered-by'], undefined);
});
