'use strict';
/**
 * Integripsi gelombang-2 #3 — /watercontrol (src/routes/watercontrol.js).
 *
 * Fakta KODE (dibaca dari sumber, bukan asumsi):
 *   mount `requireAuth + requireRole(['admin','demo'])` lalu per-rute demoGuard;
 *   GET /status SAAT INI 200 dengan baris water_controls mentah
 *   {id, command, mode, updated_at, valve_state}; setMode di luar enum SAAT INI
 *   dijawab 422 terstruktur (validasi sudah ada di kode — bukan 500), jadi tes
 *   meng-expect 422 kontrak; bila validasi pernah hilang lagi (500), pesan gagal
 *   menunjuk 'target G9b/G10' — JANGAN mengubah expect tanpa kode.
 *
 * NET-ZERO per-PERMINTAAN: setiap request yang DITOLAK guard/validasi diapit
 * snapshot /watercontrol/status sebelum & sesudahnya (jendela ~ms) sehingga
 * membuktikan request itu tidak menulis baris — sekaligus TIDAK goyah bila
 * pihak lain (worker paralel / klien live) mengubah baris di luar jendela itu.
 * 1 login admin; token petani/demo ditandatangani lokal (nol login).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { startServer, adminToken, craftToken, bearer } = require('./_server');

let srv;
let base;
let auth;

const tokenPetani = () => bearer(craftToken(
  { sub: 3, username: 'petani', level: 'petani', demo: false }, { expiresIn: '1h' }));
const tokenDemo = () => bearer(craftToken(
  { sub: 2, username: 'demo', level: 'user', demo: true }, { expiresIn: '1h' }));

const PESAN_PETANI = 'Menu ini untuk pengelola. Silakan gunakan menu "Tanam Saya".';
const PESAN_DEMO = 'Mode demo hanya boleh menambah data sementara (otomatis terhapus ± 1 jam).';

/** Baca baris water_controls (snapshot net-zero). */
async function statusSekarang(label) {
  const res = await request(base).get('/watercontrol/status').set(auth);
  assert.equal(res.status, 200, `snapshot /watercontrol/status ${label} gagal: ${res.text}`);
  return res.body;
}

/**
 * Kirim request yang DITOLAK guard/validasi; baris water_controls wajib identik
 * sebelum & sesudahnya (net-zero jendela sempit — tahan tulisan pihak luar).
 */
async function kirimDitolak(label, buatRequest) {
  const sebelum = await statusSekarang(`sebelum ${label}`);
  const res = await buatRequest();
  const sesudah = await statusSekarang(`sesudah ${label}`);
  assert.deepEqual(sesudah, sebelum,
    `${label}: request yang DITOLAK tidak boleh mengubah baris water_controls`);
  return res;
}

before(async () => {
  srv = await startServer();
  base = srv.base;
  auth = bearer(await adminToken(base));
});
after(async () => { if (srv) await srv.stop(); });

test('GET /watercontrol/status (admin) → 200 bentuk {command, mode, valve_state, id, updated_at}', async () => {
  const res = await request(base).get('/watercontrol/status').set(auth);
  assert.equal(res.status, 200, `body: ${res.text}`);
  for (const kolom of ['command', 'mode', 'valve_state']) {
    assert.ok(kolom in res.body, `kolom kontrak ${kolom} hilang — ada: ${Object.keys(res.body).join(',')}`);
  }
  assert.ok('id' in res.body && 'updated_at' in res.body, 'id & updated_at ikut terbawa');
  assert.match(String(res.body.mode), /^(AUTO|MANUAL)$/, 'mode wajib enum AUTO/MANUAL');
  assert.match(String(res.body.command), /^[A-Z_]+$/, 'command wajib nilai enum huruf-kapital');
  assert.match(String(res.body.valve_state), /^(ON|OFF)$/, 'valve_state wajib ON/OFF');
});

test('GET /watercontrol (admin) → 200 {page:"watercontrol", wc:{…}} (wc identik dgn /status pada baca berurutan)', async () => {
  const sebelum = await statusSekarang('pembanding /watercontrol');
  const res = await request(base).get('/watercontrol').set(auth);
  assert.equal(res.status, 200, `body: ${res.text}`);
  assert.equal(res.body.page, 'watercontrol');
  assert.deepEqual(res.body.wc, sebelum, 'wc harus identik dgn /watercontrol/status yang dibaca berurutan');
});

test('POST /watercontrol/setMode mode DI LUAR enum → 422 terstruktur kontrak (bukan 500, tidak menulis)', async () => {
  const res = await kirimDitolak('setMode mode di luar enum',
    () => request(base).post('/watercontrol/setMode').set(auth).send({ mode: 'XYZ' }));
  // Status AKTUAL kode saat ini = 422 (sudah divalidasi). Bila kembali 500 →
  // itulah target G9b/G10 (validasi hilang); pesan gagal menyebutkannya eksplisit.
  assert.equal(res.status, 422,
    `mode di luar enum harus 422 kontrak; aktual ${res.status} — bila 500: target G9b/G10 (validasi setMode hilang) — body: ${res.text}`);
  assert.deepEqual(res.body, {
    message: 'Data tidak valid.',
    errors: { mode: ['Mode harus AUTO atau MANUAL.'] },
  });
});

test('POST /watercontrol/setMode mode kosong / tanpa body → 422 kontrak sama, tanpa tulis', async () => {
  const kosong = await kirimDitolak('setMode mode kosong',
    () => request(base).post('/watercontrol/setMode').set(auth).send({ mode: '' }));
  assert.equal(kosong.status, 422, `body: ${kosong.text}`);
  assert.equal(kosong.body.errors.mode[0], 'Mode harus AUTO atau MANUAL.');

  const tanpaBody = await kirimDitolak('setMode tanpa body',
    () => request(base).post('/watercontrol/setMode').set(auth).send());
  assert.equal(tanpaBody.status, 422, `body: ${tanpaBody.text}`);
  assert.deepEqual(tanpaBody.body, {
    message: 'Data tidak valid.',
    errors: { mode: ['Mode harus AUTO atau MANUAL.'] },
  });
});

test('POST /watercontrol/setMode (token petani) → 403 PetaniGuard, tanpa tulis', async () => {
  const res = await kirimDitolak('setMode petani',
    // nilai VALID sengaja dipakai: guard role harus menolak lebih dulu dari handler
    () => request(base).post('/watercontrol/setMode').set(tokenPetani()).send({ mode: 'AUTO' }));
  assert.equal(res.status, 403, `body: ${res.text}`);
  assert.deepEqual(res.body, { message: PESAN_PETANI });
});

test('POST /watercontrol/setMode (token demo) → 403 demoGuard (routeName watercontrol.mode di luar whitelist), tanpa tulis', async () => {
  const res = await kirimDitolak('setMode demo',
    () => request(base).post('/watercontrol/setMode').set(tokenDemo()).send({ mode: 'AUTO' }));
  assert.equal(res.status, 403, `body: ${res.text}`);
  assert.deepEqual(res.body, { message: PESAN_DEMO });
});

test('POST /watercontrol/fill (token demo, POST di luar whitelist) → 403 demoGuard, tanpa tulis', async () => {
  const res = await kirimDitolak('fill demo',
    () => request(base).post('/watercontrol/fill').set(tokenDemo()).send({}));
  assert.equal(res.status, 403, `body: ${res.text}`);
  assert.deepEqual(res.body, { message: PESAN_DEMO });
});

test('POST /watercontrol/stop (token petani) → 403 PetaniGuard, tanpa tulis', async () => {
  const res = await kirimDitolak('stop petani',
    () => request(base).post('/watercontrol/stop').set(tokenPetani()).send({}));
  assert.equal(res.status, 403, `body: ${res.text}`);
  assert.deepEqual(res.body, { message: PESAN_PETANI });
});

test('GET /watercontrol/status (token petani) → 403 PetaniGuard', async () => {
  const res = await request(base).get('/watercontrol/status').set(tokenPetani());
  assert.equal(res.status, 403, `body: ${res.text}`);
  assert.deepEqual(res.body, { message: PESAN_PETANI });
});

test('GET /watercontrol/status (token demo) → 200 (baca lolos, sama dgn admin pada baca berurutan)', async () => {
  const admin = await statusSekarang('pembanding demo');
  const res = await request(base).get('/watercontrol/status').set(tokenDemo());
  assert.equal(res.status, 200, `body: ${res.text}`);
  assert.deepEqual(res.body, admin);
});
