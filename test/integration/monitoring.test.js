'use strict';
/**
 * Integripsi gelombang-2 #2 — /monitoring (src/routes/monitoring.js).
 *
 *   GET /monitoring/chart-data → 200 array (LIMIT 288, urut waktu naik)
 *   query dari/sampai pada chart-data → rute TIDAK membaca query (diabaikan) →
 *     didokumentasikan sebagai tes .skip dinamis + komentar (per mandat).
 *   /monitoring/tarik?dari|sampai tak valid → SAAT INI 500 (cast timestamptz gagal);
 *     daftar fleksibel [500, 422] dengan komentar target G9b/G10 — jangan expect 422
 *     sebelum kode berubah.
 * Tanpa tulis data → net-zero alami; 1 login admin, token lain lokal.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { startServer, adminToken, craftToken, bearer } = require('./_server');

let srv;
let base;
let auth;

const tokenPetani = () => craftToken(
  { sub: 3, username: 'petani', level: 'petani', demo: false }, { expiresIn: '1h' });

function assertFleksibel(res, daftar, label) {
  assert.ok(daftar.includes(res.status),
    `${label}: status aktual ${res.status} DI LUAR daftar [${daftar.join(', ')}] — body: ${res.text}`);
}

before(async () => {
  srv = await startServer();
  base = srv.base;
  auth = bearer(await adminToken(base));
});
after(async () => { if (srv) await srv.stop(); });

test('GET /monitoring/chart-data (admin) → 200 array ≤ 288 baris, urut waktu naik', async () => {
  const res = await request(base).get('/monitoring/chart-data').set(auth);
  assert.equal(res.status, 200, `body: ${res.text}`);
  assert.ok(Array.isArray(res.body), 'chart-data wajib array JSON');
  assert.ok(res.body.length <= 288, `LIMIT 288, aktual ${res.body.length}`);
  for (const baris of res.body) {
    for (const kolom of ['id', 'created_at', 'ph', 'tds', 'airTemp', 'humidity']) {
      assert.ok(kolom in baris, `kolom ${kolom} hilang`);
    }
  }
  for (let i = 1; i < res.body.length; i += 1) {
    const sebelum = new Date(res.body[i - 1].created_at).getTime();
    const sesudah = new Date(res.body[i].created_at).getTime();
    assert.ok(sebelum <= sesudah,
      `chart-data harus urut waktu naik (reverse dari ORDER BY DESC): idx ${i} melompat mundur`);
  }
});

test('GET /monitoring/chart-data?dari=…&sampai=… → param DIABAIKAN (skip + komentar dokumentasi)', async (t) => {
  const tanpa = await request(base).get('/monitoring/chart-data').set(auth);
  const dgn = await request(base).get('/monitoring/chart-data?dari=bukan-tanggal&sampai=2030-13-45').set(auth);
  if (dgn.status === tanpa.status && dgn.text === tanpa.text) {
    t.diagnostic('perilaku aktual: /monitoring/chart-data TIDAK membaca dari/sampai — '
      + `respons identik byte dgn permintaan tanpa query (status ${dgn.status})`);
    t.skip('query dari/sampai diabaikan oleh kontrak chart-data (tak ada parameter waktu di rute ini) '
      + '— didokumentasikan di sini, bukan diassert sebagai perilaku baru');
    return;
  }
  // Perilaku berubah (rute kini memproses query) → wajib tetap array 200 agar jelas gagalnya.
  assert.equal(dgn.status, 200, `perilaku chart-data berubah: ${dgn.status} ${dgn.text}`);
  assert.ok(Array.isArray(dgn.body), 'bila query diproses pun respons tetap array');
});

test('GET /monitoring (admin) → 200 {page:"monitoring"}', async () => {
  const res = await request(base).get('/monitoring').set(auth);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { page: 'monitoring' });
});

test('GET /monitoring tanpa token → 401 kontrak', async () => {
  const res = await request(base).get('/monitoring');
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { message: 'Tidak terautentikasi.' });
});

test('GET /monitoring/tarik?dari&sampai valid → 200 {dari, sampai, data:[]}', async () => {
  const res = await request(base)
    .get('/monitoring/tarik?dari=2020-01-01&sampai=2030-01-01&per_page=999').set(auth);
  assert.equal(res.status, 200, `body: ${res.text}`);
  assert.equal(res.body.dari, '2020-01-01');
  assert.equal(res.body.sampai, '2030-01-01');
  assert.ok(Array.isArray(res.body.data));
  // per_page di luar whitelist [10,25,50,100] → jatuh ke default 10.
  assert.ok(res.body.data.length <= 10,
    `per_page=999 harus ditolak (default 10), aktual ${res.body.data.length}`);
});

test('GET /monitoring/tarik?dari=abc → 500 SAAT INI (fleksibel 500|422 — target G9b/G10)', async () => {
  const res = await request(base).get('/monitoring/tarik?dari=abc').set(auth);
  // Kode: $1::timestamptz tanpa validasi aplikasi → cast gagal → 500 generik.
  // Bila worker G9b/G10 menambah validasi → 422 terstruktur. Lain dari itu = gagal.
  assertFleksibel(res, [500, 422], 'GET /monitoring/tarik?dari=abc');
  if (res.status === 500) {
    assert.deepEqual(res.body, { message: 'Terjadi kesalahan pada server.' });
  } else {
    assert.equal(res.body.message, 'Data tidak valid.');
  }
});

test('GET /monitoring/tarik?sampai=tanggal-aneh → 500 SAAT INI (fleksibel 500|422 — target G9b/G10)', async () => {
  const res = await request(base).get('/monitoring/tarik?sampai=tanggal-aneh').set(auth);
  assertFleksibel(res, [500, 422], 'GET /monitoring/tarik?sampai=tanggal-aneh');
});

test('GET /monitoring/getReport6Jam (publik) → 200 {sensor:{5 rata-rata}, alerts:[]}', async () => {
  const res = await request(base).get('/monitoring/getReport6Jam');
  assert.equal(res.status, 200, `body: ${res.text}`);
  for (const kolom of ['waterTemp', 'ph', 'tds', 'airTemp', 'humidity']) {
    assert.ok(kolom in res.body.sensor, `sensor.${kolom} hilang`);
    assert.ok(res.body.sensor[kolom] === null || Number.isFinite(Number(res.body.sensor[kolom])),
      `sensor.${kolom} harus angka/null`);
  }
  assert.ok(Array.isArray(res.body.alerts), 'alerts wajib array');
});

test('GET /monitoring/tarik (token petani) → 200 (kode: hanya requireAuth, tanpa requireRole)', async () => {
  // Dibaca dari src/index.js: /monitoring dipasang TANPA requireRole — hanya
  // requireAuth per rute, sehingga petani SAAT INI boleh membaca (200).
  // Bila worker G9b/G10 mengerasinya ke PetaniGuard, 403 kontrak diterima juga.
  const res = await request(base).get('/monitoring/tarik').set(bearer(tokenPetani()));
  if (res.status === 403) {
    assert.deepEqual(res.body,
      { message: 'Menu ini untuk pengelola. Silakan gunakan menu "Tanam Saya".' });
    return;
  }
  assert.equal(res.status, 200, `perilaku tak terduga: ${res.status} ${res.text}`);
  assert.ok(Array.isArray(res.body.data), 'petani tetap menerima {dari, sampai, data:[]}');
});
