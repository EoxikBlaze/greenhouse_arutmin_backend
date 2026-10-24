'use strict';
/**
 * Integripsi gelombang-2 #5 — RBAC/Authorization lintas rute:
 *   petani  → /user, /meja, POST /user  → 403 PetaniGuard
 *   (/notifikasi-wa dihapus dari backend — rutenya kini 404, diuji di bawah)
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
const { startServer, adminToken, craftToken, bearer, ROOT } = require('./_server');

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

test('GET /notifikasi-wa → 404 (fitur notifikasi WhatsApp dihapus — rute tak dikenal)', async () => {
  const res = await request(base).get('/notifikasi-wa').set(tokenPetani());
  assert.equal(res.status, 404, `body: ${res.text}`);
  assert.match(res.body.message || '', /could not be found/,
    'route /notifikasi-wa harus hilang total (404 JSON generik), bukan 403/401');
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

/* ── HARDENING prioritas peresmian — S3 (helmet) + S10 (JWT) + guard ESP32 ── */

test('Header helmet ada pada respons API: CSP + nosniff + DENY + no-referrer + CORP, x-powered-by tetap mati', async () => {
  const res = await request(base).get('/rute-tidak-ada');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['x-powered-by'], undefined);
  // Header baru hasil helmet:
  assert.match(res.headers['content-security-policy'] || '', /default-src 'self'/);
  assert.match(res.headers['content-security-policy'] || '', /object-src 'none'/);
  assert.equal(res.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(res.headers['cross-origin-opener-policy'], 'same-origin');
});

test('HSTS TIDAK dikirim pada http:// lokal (SECURITY_HSTS default auto) — terkirim saat request bertanda TLS', async () => {
  const lokal = await request(base).get('/rute-tidak-ada');
  assert.equal(lokal.headers['strict-transport-security'], undefined,
    'http:// lokal tidak boleh menerima HSTS (jangan mengunci origin dev)');
  const tls = await request(base).get('/rute-tidak-ada').set('X-Forwarded-Proto', 'https');
  assert.match(String(tls.headers['strict-transport-security'] || ''), /^max-age=\d+/,
    'di belakang TLS (X-Forwarded-Proto https) HSTS wajib terkirim');
});

test("requireApiKey: key aktif kosong / fallback 'HARVEST123' → SEMUA permintaan 403, key asli tetap 200", () => {
  const cfg = require('../../src/config');
  const { requireApiKey } = require('../../src/auth');
  const asli = cfg.esp32ApiKey;
  const jalankan = (headers) => {
    let status = null;
    let lolos = false;
    const res = { status(c) { status = c; return res; }, json() { return res; } };
    requireApiKey({ headers: headers || {}, body: {} }, res, () => { lolos = true; });
    return { status, lolos };
  };
  try {
    for (const kunciKosong /* '' | 'HARVEST123' */ of ['', 'HARVEST123']) {
      cfg.esp32ApiKey = kunciKosong;
      const label = kunciKosong === '' ? '(kosong)' : "'HARVEST123'";
      const tanpaHeader = jalankan();
      assert.equal(tanpaHeader.lolos, false, `key aktif ${label}: tanpa header TIDAK boleh lolos`);
      assert.equal(tanpaHeader.status, 403, `key aktif ${label}: tanpa header harus 403`);
      const dgnHeaderFallback = jalankan({ 'x-api-key': kunciKosong === '' ? '' : 'HARVEST123' });
      assert.equal(dgnHeaderFallback.lolos, false, `key aktif ${label}: mengirim key itu TIDAK boleh lolos`);
      assert.equal(dgnHeaderFallback.status, 403, `key aktif ${label}: harus 403 kontrak Unauthorized`);
    }
    // Key asli (dari .env) tetap berperilaku normal — guard tidak "menolak semua".
    cfg.esp32ApiKey = 'kunci-uji-bukan-fallback';
    assert.equal(jalankan({ 'x-api-key': 'kunci-uji-bukan-fallback' }).lolos, true, 'key asli harus tetap diterima');
    assert.equal(jalankan({ 'x-api-key': 'salah' }).lolos, false, 'key salah tetap 403');
    assert.equal(jalankan().lolos, false, 'tanpa header dengan key valid tetap 403');
  } finally {
    cfg.esp32ApiKey = asli; // pulihkan — jangan bocor ke tes lain di file ini
  }
});

test("JWT_SECRET kosong / 'dev-secret-ganti' → proses MENOLAK start (fail-fast, pesan jelas)", () => {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env, JWT_SECRET: '' }; // '' → config.js tidak pakai .env → fallback
  const r = spawnSync(process.execPath, ['-e', "require('./src/auth')"], { cwd: ROOT, env, encoding: 'utf8' });
  assert.notEqual(r.status, 0, 'server harus GAGAL start, bukan diam-diam memakai secret publik');
  assert.match(r.stderr, /JWT_SECRET tidak diatur/, `stderr: ${r.stderr}`);
  // Varian: nilai eksplisit = fallback historis juga ditolak.
  const r2 = spawnSync(process.execPath, ['-e', "require('./src/auth')"],
    { cwd: ROOT, env: { ...process.env, JWT_SECRET: 'dev-secret-ganti' }, encoding: 'utf8' });
  assert.notEqual(r2.status, 0, "JWT_SECRET='dev-secret-ganti' harus ditolak");
  assert.match(r2.stderr, /JWT_SECRET tidak diatur/);
});

// Kata sandi minimal 8 karakter di SEMUA jalur (buat user, edit user, ganti sandi profil).
// Dulu edit user (PUT) menerima sandi 1 karakter. Semua kasus ditolak sebelum menulis → net-zero.
test('kata sandi < 8 karakter ditolak 422 di POST /user, PUT /user/:id, dan POST /profil/password', async () => {
  const buat = await request(base).post('/user').set(auth)
    .send({ username: 'uji-sandi-pendek', email: 'uji-sandi@pendek.id', password: 'abc1234', level: 'petani' });
  assert.equal(buat.status, 422, JSON.stringify(buat.body));
  assert.match(buat.body.errors.password[0], /min 8/);
  const ubah = await request(base).put('/user/1').set(auth).send({ password: 'a' });
  assert.equal(ubah.status, 422, JSON.stringify(ubah.body));
  assert.match(ubah.body.errors.password[0], /min 8/);
  const profil = await request(base).post('/profil/password').set(auth)
    .send({ password_lama: 'apa-saja', password: 'abc1234', password_confirmation: 'abc1234' });
  assert.equal(profil.status, 422, JSON.stringify(profil.body));
  assert.ok(profil.body.errors.password, JSON.stringify(profil.body));
});
