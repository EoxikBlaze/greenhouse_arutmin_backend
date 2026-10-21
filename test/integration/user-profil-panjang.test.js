'use strict';
/**
 * Regresi B4/B5 — panjang & byte NUL SEBELUM query tulis (bukan 500 dari PostgreSQL).
 *
 *  B4  POST /user         : username 60 (varchar 50) / email 150 (varchar 100)
 *                           dulu → SQLSTATE 22001 "value too long" → 500.
 *  B5  POST /profil/update: email 106 / ber-NUL / username 60 dulu → 500.
 *
 * Kini keduanya ditolak dengan 422 kontrak {message:'Data tidak valid.',
 * errors:{<kolom>:[pesan manusiawi]}} SEBELUM SQL → net-zero (tidak ada baris uji,
 * profil admin tidak berubah). Kasus sukses POST /user tetap 201 (lalu dihapus
 * di akhir tes → kontrol bahwa validasi baru tidak menolak data yang sah).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { startServer, adminToken, bearer } = require('./_server');

const NUL = '\u0000';

let srv;
let base;
let auth;
let userIdBaru = null; // baris kontrol POST /user valid → dihapus (net-zero)

before(async () => {
  srv = await startServer();
  base = srv.base;
  auth = bearer(await adminToken(base));
});

after(async () => {
  if (!srv) return;
  if (userIdBaru) await request(base).delete(`/user/${userIdBaru}`).set(auth); // jaring pengaman
  await srv.stop();
});

/** Kirim POST, paksa 422 kontrak, kembalikan errors. */
async function tolak(path, body) {
  const res = await request(base).post(path).set(auth).send(body);
  assert.equal(res.status, 422,
    `${path} ${JSON.stringify(body).slice(0, 80)} → 422; aktual ${res.status}: ${res.text}`);
  assert.equal(res.body.message, 'Data tidak valid.', 'kontrak {message, errors} wajib utuh');
  assert.equal(typeof res.body.errors, 'object');
  assert.ok(!Array.isArray(res.body.errors), 'errors berupa objek per-field');
  return res.body.errors;
}

test('B4 — POST /user: username 60 & email 150 → 422 (dulu 22001 value too long → 500)', async () => {
  const e1 = await tolak('/user', {
    username: 'u'.repeat(60),
    email: 'panjang60@example.com',
    password: 'kata-sandi-uji-123',
  });
  assert.deepEqual(e1.username, ['Nama pengguna maks 50 karakter.']);
  assert.equal(e1.email, undefined, 'hanya kolom bermasalah yang ikut errors');

  const e2 = await tolak('/user', {
    username: 'uji-panjang-email',
    email: `${'e'.repeat(138)}@example.com`, // 150 karakter, format VALID
    password: 'kata-sandi-uji-123',
  });
  assert.deepEqual(e2.email, ['Email maks 100 karakter.']);
  assert.equal(e2.username, undefined);
  assert.ok(`${'e'.repeat(138)}@example.com`.length === 150, 'fixture wajib 150 karakter');
});

test('B4 — POST /user: byte NUL pada username/email → 422 (dulu 22021 → 500)', async () => {
  const e1 = await tolak('/user', {
    username: `uji${NUL}baru`,
    email: 'nul1@example.com',
    password: 'kata-sandi-uji-123',
  });
  assert.deepEqual(e1.username, ['Nama pengguna tidak boleh mengandung karakter terlarang.']);

  const e2 = await tolak('/user', {
    username: 'uji-nul-email',
    email: `a${NUL}b@example.com`,
    password: 'kata-sandi-uji-123',
  });
  assert.deepEqual(e2.email, ['Email tidak boleh mengandung karakter terlarang.']);
});

test('B5 — POST /profil/update: email 106 & username 60 → 422, profil admin TIDAK berubah', async () => {
  const sebelum = await request(base).get('/profil').set(auth);
  assert.equal(sebelum.status, 200, sebelum.text);
  const asli = sebelum.body.user;
  assert.ok(asli && asli.username, 'GET /profil wajib mengembalikan user admin');

  const email106 = `${'p'.repeat(94)}@example.com`; // 94 + 12 = 106
  assert.equal(email106.length, 106, 'fixture wajib 106 karakter');

  const e1 = await tolak('/profil/update', { email: email106 });
  assert.deepEqual(e1.email, ['Email maks 100 karakter.']);

  const e2 = await tolak('/profil/update', { username: 'p'.repeat(60) });
  assert.deepEqual(e2.username, ['Nama pengguna maks 50 karakter.']);

  const e3 = await tolak('/profil/update', { email: `nul${NUL}@example.com` });
  assert.deepEqual(e3.email, ['Email tidak boleh mengandung karakter terlarang.']);

  const sesudah = await request(base).get('/profil').set(auth);
  assert.equal(sesudah.status, 200, sesudah.text);
  assert.deepEqual(sesudah.body.user, asli, 'profil admin wajib identik sebelum & sesudah 422');
});

test('kontrol — POST /user valid masih 201, lalu dihapus → net-zero', async () => {
  const nama = `uji-panjang-${Date.now().toString(36)}`;
  const buat = await request(base).post('/user').set(auth).send({
    username: nama,
    email: `${nama}@example.com`,
    password: 'kata-sandi-uji-123',
    level: 'user',
  });
  assert.equal(buat.status, 201, `data sah wajib tetap diterima 201: ${buat.text}`);
  userIdBaru = buat.body.data.id;

  const idBaru = userIdBaru;
  const hapus = await request(base).delete(`/user/${idBaru}`).set(auth);
  assert.equal(hapus.status, 200, `baris uji wajib terhapus: ${hapus.text}`);
  userIdBaru = null;

  const cek = await request(base).get(`/user/${idBaru}`).set(auth);
  assert.equal(cek.status, 404, 'setelah hapus baris sudah tidak ada');
});
