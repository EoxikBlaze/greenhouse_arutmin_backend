'use strict';
/**
 * Integripsi gelombang-2 #5 — RBAC/Authorization lintas rute:
 *   petani  → /user, /notifikasi-wa, /meja, POST /user  → 403 PetaniGuard
 *   level tak dikenal (bukan admin/petani) → 403 'Akses ditolak.'
 *   demo    → baca lolos (200), TULIS di luar whitelist DEMO_BOLEH_TAMBAH → 403
 *             dengan pesan kontrak persis (demoGuard), termasuk PUT/PATCH/DELETE
 *             pada resource yang routeName-nya ada di whitelist — karena demoGuard
 *             kini METHOD-AWARE (hanya POST yang boleh).
 *
 * Semua probe tulis memakai id yang TIDAK ADA → net-zero alami (tidak pernah
 * menyentuh baris). Token petani/demo/level-lain ditandatangani lokal (nol login);
 * 1× login admin dipakai untuk pembanding baca.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { startServer, adminToken, craftToken, bearer } = require('./_server');

const ID_TIDAK_ADA = '9223372036854775806';
const PESAN_PETANI = 'Menu ini untuk pengelola. Silakan gunakan menu "Tanam Saya".';
const PESAN_DEMO = 'Mode demo hanya boleh menambah data sementara (otomatis terhapus ± 1 jam).';
const PESAN_DEMO_USER = 'Mode demo tidak boleh mengelola user.';

let srv;
let base;
let auth;

const tokenPetani = () => bearer(craftToken(
  { sub: 3, username: 'petani', level: 'petani', demo: false }, { expiresIn: '1h' }));
const tokenDemo = () => bearer(craftToken(
  { sub: 2, username: 'demo', level: 'user', demo: true }, { expiresIn: '1h' }));
const tokenLevelLain = () => bearer(craftToken(
  { sub: 9, username: 'opsi', level: 'supervisor', demo: false }, { expiresIn: '1h' }));

before(async () => {
  srv = await startServer();
  base = srv.base;
  auth = bearer(await adminToken(base));
});
after(async () => { if (srv) await srv.stop(); });

/* ── petani ditolak dari menu pengelola ─────────────────────────────── */
test('GET /user (petani) → 403 PetaniGuard', async () => {
  const res = await request(base).get('/user').set(tokenPetani());
  assert.equal(res.status, 403, `body: ${res.text}`);
  assert.deepEqual(res.body, { message: PESAN_PETANI });
});

test('GET /notifikasi-wa (petani) → 403 PetaniGuard', async () => {
  const res = await request(base).get('/notifikasi-wa').set(tokenPetani());
  assert.equal(res.status, 403, `body: ${res.text}`);
  assert.deepEqual(res.body, { message: PESAN_PETANI });
});

test('POST /user (petani) → 403 PetaniGuard (metode tulis pun diblokir guard role)', async () => {
  const res = await request(base).post('/user').set(tokenPetani())
    .send({ username: 'dilarang', password: 'password1' });
  assert.equal(res.status, 403, `body: ${res.text}`);
  assert.deepEqual(res.body, { message: PESAN_PETANI });
});

test('GET /meja (petani) → 403 PetaniGuard', async () => {
  const res = await request(base).get('/meja').set(tokenPetani());
  assert.equal(res.status, 403, `body: ${res.text}`);
  assert.deepEqual(res.body, { message: PESAN_PETANI });
});

/* ── level di luar daftar → 403 generik kontrak ────────────────────── */
test('token dgn level tak dikenal (supervisor) → GET /user 403 "Akses ditolak."', async () => {
  const res = await request(base).get('/user').set(tokenLevelLain());
  assert.equal(res.status, 403, `body: ${res.text}`);
  assert.deepEqual(res.body, { message: 'Akses ditolak.' });
});

/* ── demo: baca lolos ──────────────────────────────────────────────── */
test('GET /user (demo) → 200 array publik tanpa kolom password/hash', async () => {
  const res = await request(base).get('/user').set(tokenDemo());
  assert.equal(res.status, 200, `body: ${res.text}`);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.length >= 1, 'minimal akun admin terdaftar');
  for (const u of res.body) {
    assert.deepEqual(Object.keys(u).sort(), ['email', 'id', 'is_demo', 'level', 'username'],
      `bentuk publicUser berubah: ${Object.keys(u).join(',')}`);
    assert.equal(u.password, undefined, 'password tidak boleh terkirim');
  }
});

/* ── demo: semua TULISAN di luar whitelist → 403 kontrak ───────────── */
test('POST /user (demo) → 403 "Mode demo tidak boleh mengelola user."', async () => {
  const res = await request(base).post('/user').set(tokenDemo())
    .send({ username: 'barudemo', password: 'password1' });
  assert.equal(res.status, 403, `body: ${res.text}`);
  assert.deepEqual(res.body, { message: PESAN_DEMO_USER });
});

test('PUT /user/:id (demo) → 403 "Mode demo tidak boleh mengelola user." (id sengaja tak-ada → net-zero)', async () => {
  const res = await request(base).put(`/user/${ID_TIDAK_ADA}`).set(tokenDemo())
    .send({ email: 'x@y.z' });
  assert.equal(res.status, 403, `body: ${res.text}`);
  assert.deepEqual(res.body, { message: PESAN_DEMO_USER });
});

test('PUT /meja/:id (demo) → 403 demoGuard kontrak (method-aware: PUT walau routeName meja.store di whitelist)', async () => {
  const res = await request(base).put(`/meja/${ID_TIDAK_ADA}`).set(tokenDemo())
    .send({ meja: 'TIDAK-ADA', jumlah_lubang: 5 });
  assert.equal(res.status, 403,
    `demo PUT /meja harus 403 kontrak; aktual ${res.status} — body: ${res.text}`);
  assert.deepEqual(res.body, { message: PESAN_DEMO });
});

test('PATCH /siklus/:id (demo) → 403 demoGuard kontrak', async () => {
  const res = await request(base).patch(`/siklus/${ID_TIDAK_ADA}`).set(tokenDemo())
    .send({ nama_siklus: 'TIDAK-ADA' });
  assert.equal(res.status, 403, `body: ${res.text}`);
  assert.deepEqual(res.body, { message: PESAN_DEMO });
});

test('DELETE /tanaman/:id (demo) → 403 demoGuard kontrak', async () => {
  const res = await request(base).delete(`/tanaman/${ID_TIDAK_ADA}`).set(tokenDemo());
  assert.equal(res.status, 403, `body: ${res.text}`);
  assert.deepEqual(res.body, { message: PESAN_DEMO });
});

test('DELETE /meja/:id (demo) → 403 demoGuard kontrak', async () => {
  const res = await request(base).delete(`/meja/${ID_TIDAK_ADA}`).set(tokenDemo());
  assert.equal(res.status, 403, `body: ${res.text}`);
  assert.deepEqual(res.body, { message: PESAN_DEMO });
});

test('PUT /user/:id (admin, id tak-ada) → 404 kontrak — pembanding: guard admin tidak menolak', async () => {
  const res = await request(base).put(`/user/${ID_TIDAK_ADA}`).set(auth).send({ email: 'x@y.z' });
  assert.equal(res.status, 404, `body: ${res.text}`);
  assert.deepEqual(res.body, { message: 'Data tidak ditemukan.', errors: {} });
});
