'use strict';
/** Sesi web lewat cookie HttpOnly + CSRF double-submit; Bearer tetap jalan untuk klien lain. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { startServer, readEnv, bearer } = require('./_server');

let srv; let base; let cookieSesi; let csrf;
const env = readEnv();

before(async () => { srv = await startServer(); base = srv.base; });
after(async () => { if (srv) await srv.stop(); });

const ambil = (res, nama) => (res.headers['set-cookie'] || []).find((c) => c.startsWith(`${nama}=`));

test('login sesi:cookie → cookie HttpOnly+SameSite=Strict, token TIDAK ada di body', async () => {
  const res = await request(base).post('/login').send({ username: 'garap', password: env.ADMIN_PASSWORD, sesi: 'cookie' });
  assert.equal(res.status, 200);
  assert.equal(res.body.token, undefined, 'token tidak boleh terbaca JS');
  const sesi = ambil(res, 'vsf_sesi');
  const tokenCsrf = ambil(res, 'vsf_csrf');
  assert.match(sesi, /HttpOnly/);
  assert.match(sesi, /SameSite=Strict/);
  assert.doesNotMatch(tokenCsrf, /HttpOnly/, 'cookie CSRF harus terbaca JS');
  cookieSesi = sesi.split(';')[0];
  csrf = tokenCsrf.split(';')[0].split('=')[1];
});

test('GET dengan cookie → 200 tanpa Authorization', async () => {
  const r = await request(base).get('/meja').set('Cookie', cookieSesi);
  assert.equal(r.status, 200);
});

test('POST dengan cookie tanpa/ salah X-CSRF-Token → 403 csrf_tidak_cocok', async () => {
  const cookies = `${cookieSesi}; vsf_csrf=${csrf}`;
  const tanpa = await request(base).post('/meja').set('Cookie', cookies).send({});
  assert.equal(tanpa.status, 403);
  assert.equal(tanpa.body.kode, 'csrf_tidak_cocok');
  const salah = await request(base).post('/meja').set('Cookie', cookies).set('X-CSRF-Token', 'salah').send({});
  assert.equal(salah.status, 403);
  assert.equal(salah.body.kode, 'csrf_tidak_cocok');
});

test('POST dengan cookie + X-CSRF-Token benar → lolos CSRF (validasi isi yang menolak, bukan 403)', async () => {
  const r = await request(base).post('/meja').set('Cookie', `${cookieSesi}; vsf_csrf=${csrf}`).set('X-CSRF-Token', csrf).send({});
  assert.notEqual(r.status, 403);
  assert.notEqual(r.status, 401);
});

test('login tanpa sesi:cookie tetap mengembalikan token (Flutter) dan Bearer tidak butuh CSRF', async () => {
  const res = await request(base).post('/login').send({ username: 'garap', password: env.ADMIN_PASSWORD });
  assert.ok(res.body.token);
  assert.equal(ambil(res, 'vsf_sesi'), undefined);
  const r = await request(base).post('/meja').set(bearer(res.body.token)).send({});
  assert.notEqual(r.status, 403);
});

test('logout menghapus kedua cookie; cookie palsu → 401', async () => {
  const out = await request(base).post('/logout').set('Cookie', cookieSesi);
  assert.equal(out.status, 200);
  assert.match(ambil(out, 'vsf_sesi'), /Max-Age=0/);
  assert.match(ambil(out, 'vsf_csrf'), /Max-Age=0/);
  const palsu = await request(base).get('/meja').set('Cookie', 'vsf_sesi=bukan.token.sah');
  assert.equal(palsu.status, 401);
});
