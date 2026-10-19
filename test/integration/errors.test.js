'use strict';
/**
 * Integripsi #2 — BENTUK ERROR SERAGAM: 404 identik byte (anti-enumerasi),
 * 422 body non-objek, 400 JSON rusak, 404 rute tak dikenal, header keamanan.
 * Kontrak: src/index.js (handler global) · src/routes/_id.js notFound · _validate.invalidBody.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { startServer, adminToken, bearer } = require('./_server');

const ID_TIDAK_ADA = '9223372036854775806'; // ≤ BIGINT_MAX → format valid, tapi tak pernah ada
const NOT_FOUND = { message: 'Data tidak ditemukan.', errors: {} };

let srv;
let base;
let auth;

before(async () => {
  srv = await startServer();
  base = srv.base;
  auth = bearer(await adminToken(base));
});
after(async () => { if (srv) await srv.stop(); });

/** Bandingkan dua body respon pada tingkat BYTE (bukan sekadar struktur sama). */
function assertSameBytes(a, b, label) {
  const ba = Buffer.from(a.text ?? '', 'utf8');
  const bb = Buffer.from(b.text ?? '', 'utf8');
  assert.equal(Buffer.compare(ba, bb), 0,
    `${label}: body harus identik byte → "${a.text}" vs "${b.text}"`);
  assert.equal(a.headers['content-type'], b.headers['content-type']);
}

test('404 seragam byte — rute /meja/:id (id valid-tak-ada == id salah format)', async () => {
  const tidakAda = await request(base).get(`/meja/${ID_TIDAK_ADA}`).set(auth);
  const salah = await request(base).get('/meja/abc').set(auth);
  assert.equal(tidakAda.status, 404);
  assert.equal(salah.status, 404);
  assertSameBytes(tidakAda, salah, '/meja/:id');
  assert.deepEqual(JSON.parse(tidakAda.text), NOT_FOUND);
});

test('404 seragam byte — rute /tanaman/:id (id valid-tak-ada == id salah format)', async () => {
  const tidakAda = await request(base).get(`/tanaman/${ID_TIDAK_ADA}`).set(auth);
  const salah = await request(base).get('/tanaman/abc').set(auth);
  assert.equal(tidakAda.status, 404);
  assert.equal(salah.status, 404);
  assertSameBytes(tidakAda, salah, '/tanaman/:id');
  assert.deepEqual(JSON.parse(tidakAda.text), NOT_FOUND);
});

test('404 seragam byte ANTAR rute (/meja, /tanaman, /konfigurasi-dosis) — satu bentuk', async () => {
  const a = await request(base).get(`/meja/${ID_TIDAK_ADA}`).set(auth);
  const b = await request(base).get(`/tanaman/${ID_TIDAK_ADA}`).set(auth);
  const c = await request(base).get(`/konfigurasi-dosis/${ID_TIDAK_ADA}`).set(auth);
  assert.deepEqual([a.status, b.status, c.status], [404, 404, 404]);
  assertSameBytes(a, b, '/meja vs /tanaman');
  assertSameBytes(a, c, '/meja vs /konfigurasi-dosis');
  for (const r of [a, b, c]) assert.deepEqual(JSON.parse(r.text), NOT_FOUND);
});

test('422 body JSON "null" → kontrak 422 {message, errors:{body:[…]}} (bukan 400/500)', async () => {
  const res = await request(base)
    .post('/meja')
    .set('Content-Type', 'application/json')
    .set(auth)
    .send('null');
  assert.equal(res.status, 422);
  assert.deepEqual(res.body, {
    message: 'Data tidak valid.',
    errors: { body: ['Body harus berupa objek JSON.'] },
  });
});

test('422 body JSON skalar angka (bukan objek) → kontrak 422 yang sama', async () => {
  const res = await request(base)
    .put(`/meja/${ID_TIDAK_ADA}`)
    .set('Content-Type', 'application/json')
    .set(auth)
    .send('42');
  assert.equal(res.status, 422);
  assert.deepEqual(res.body, {
    message: 'Data tidak valid.',
    errors: { body: ['Body harus berupa objek JSON.'] },
  });
});

test('JSON benar-benar rusak → 400 "Format JSON tidak valid." (terpisah dari 422)', async () => {
  const res = await request(base)
    .post('/meja')
    .set('Content-Type', 'application/json')
    .set(auth)
    .send('{"meja":');
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { message: 'Format JSON tidak valid.' });
});

test('GET rute tak dikenal → 404 format seragam (path disubstitusi)', async () => {
  const res = await request(base).get('/rute-tidak-ada');
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { message: 'The route /rute-tidak-ada could not be found.' });
  assert.equal(res.text.includes('stack'), false, 'tidak ada stack trace');
});

test('POST rute tak dikenal → 404 format identik (hanya path berbeda)', async () => {
  const a = await request(base).post('/rute-tidak-ada').send({ x: 1 });
  const b = await request(base).post('/juga-tidak-ada').send({ x: 1 });
  assert.equal(a.status, 404);
  assert.equal(b.status, 404);
  assert.deepEqual(a.body, { message: 'The route /rute-tidak-ada could not be found.' });
  assert.deepEqual(b.body, { message: 'The route /juga-tidak-ada could not be found.' });
  // Template yang sama: beda hanya segmen path.
  assert.equal(
    a.text.replace('/rute-tidak-ada', 'X'),
    b.text.replace('/juga-tidak-ada', 'X'),
  );
});

test('Header keamanan ada + x-powered-by dimatikan', async () => {
  const res = await request(base).get('/');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['x-powered-by'], undefined);
});
