'use strict';
/**
 * Integripsi gelombang-2 #1 — /laporan (src/routes/laporan.js).
 *
 * Fakta KODE (dibaca dulu, bukan asumsi): router dipasang dengan
 * `requireAuth + requireRole(['admin','demo'])` (src/index.js) → petani DITOLAK 403
 * PetaniGuard, demo DIPERBOLEHKAN. Rute ini tanpa tulis data → net-zero alami.
 * Satu login admin (helper), token petani/demo ditandatangani lokal (nol login).
 *
 * Perilaku query tanggal TIDAK valid SAAT INI = 500 (cast timestamptz gagal di
 * PostgreSQL, tak divalidasi aplikasi). Tes memakai daftar fleksibel
 * [500, 422] supaya tidak merah bila worker G9b/G10 menambah validasi —
 * JANGAN meng-expect 422 sebelum kode berubah.
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
const tokenDemo = () => craftToken(
  { sub: 2, username: 'demo', level: 'user', demo: true }, { expiresIn: '1h' });

const PESAN_PETANI = 'Menu ini untuk pengelola. Silakan gunakan menu "Tanam Saya".';
const KOLOM_MATRIKS = ['periode', 'semai', 'remaja', 'dewasa', 'panen_kg', 'rata_ph'];

/** Gagal hanya bila status keluar dari daftar perilaku yang dicatat. */
function assertFleksibel(res, daftar, label) {
  assert.ok(daftar.includes(res.status),
    `${label}: status aktual ${res.status} DI LUAR daftar [${daftar.join(', ')}] — body: ${res.text}`);
}

before(async () => {
  srv = await startServer();
  base = srv.base;
  auth = bearer(await adminToken(base)); // 1 login / server (di-cache helper)
});
after(async () => { if (srv) await srv.stop(); });

test('GET /laporan (admin) → 200 bentuk {page, matriks:[{periode,semai,remaja,dewasa,panen_kg,rata_ph}]}', async () => {
  const res = await request(base).get('/laporan').set(auth);
  assert.equal(res.status, 200, `body: ${res.text}`);
  assert.equal(res.body.page, 'laporan');
  assert.ok(Array.isArray(res.body.matriks), 'matriks wajib array');
  for (const baris of res.body.matriks) {
    for (const kolom of KOLOM_MATRIKS) {
      assert.ok(kolom in baris, `kolom ${kolom} hilang dari baris matriks`);
    }
    assert.match(String(baris.periode), /^\d{4}-\d{2}$/, 'periode berformat YYYY-MM');
    for (const kolom of ['semai', 'remaja', 'dewasa']) {
      assert.ok(baris[kolom] === null || Number.isInteger(Number(baris[kolom])),
        `${kolom} harus integer/null`);
    }
    assert.ok(baris.panen_kg === null || Number.isFinite(Number(baris.panen_kg)),
      'panen_kg harus angka/null');
    assert.ok(baris.rata_ph === null || Number.isFinite(Number(baris.rata_ph)),
      'rata_ph harus angka/null');
  }
});

test('GET /laporan?dari&sampai valid → 200, param diecho + matriks tetap array', async () => {
  const res = await request(base).get('/laporan?dari=2026-01-01&sampai=2026-06-30').set(auth);
  assert.equal(res.status, 200, `body: ${res.text}`);
  assert.equal(res.body.dari, '2026-01-01');
  assert.equal(res.body.sampai, '2026-06-30');
  assert.equal(res.body.page, 'laporan');
  assert.ok(Array.isArray(res.body.matriks));
  // Terikat rentang: semua periode berada di antara dari & sampai.
  for (const b of res.body.matriks) {
    assert.ok(String(b.periode) >= '2026-01' && String(b.periode) <= '2026-06',
      `periode ${b.periode} di luar rentang dari/sampai`);
  }
});

test('GET /laporan (token petani) → 403 PetaniGuard (kontrak sebenarnya: bukan 403 umum, bukan 200)', async () => {
  const res = await request(base).get('/laporan').set(bearer(tokenPetani()));
  assert.equal(res.status, 403, `body: ${res.text}`);
  assert.deepEqual(res.body, { message: PESAN_PETANI });
});

test('GET /laporan (token demo) → 200 (adminDemo mengizinkan demo membaca laporan)', async () => {
  const res = await request(base).get('/laporan').set(bearer(tokenDemo()));
  assert.equal(res.status, 200, `body: ${res.text}`);
  assert.equal(res.body.page, 'laporan');
  assert.ok(Array.isArray(res.body.matriks));
});

test('GET /laporan tanpa token → 401 kontrak', async () => {
  const res = await request(base).get('/laporan');
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { message: 'Tidak terautentikasi.' });
});

test('GET /laporan?dari=bukan-tanggal → 500 SAAT INI (fleksibel 500|422 — target G9b/G10: validasi tanggal)', async () => {
  const res = await request(base).get('/laporan?dari=bukan-tanggal').set(auth);
  // Perilaku tercatat (dibaca dari kode): matrix() memberi $1::date tanpa validasi
  // aplikasi → SQL gagal cast → 500 generik. Bila G9b/G10 menambah validasi → 422.
  // Keduanya didokumentasikan; status LAIN (mis. 200 diam-diam mengabaikan) = gagal.
  assertFleksibel(res, [500, 422], 'GET /laporan?dari=bukan-tanggal');
  if (res.status === 500) {
    assert.deepEqual(res.body, { message: 'Terjadi kesalahan pada server.' },
      '500 generik tanpa stack trace (kontrak JSON-only)');
  } else {
    assert.equal(res.body.message, 'Data tidak valid.', '422 harus kontrak terstruktur');
  }
});

test('GET /laporan/csv (admin) → 200 text/csv + baris header + BOM UTF-8', async () => {
  const res = await request(base).get('/laporan/csv').set(auth);
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^text\/csv/);
  assert.match(res.headers['content-disposition'], /attachment; filename="laporan-.*\.csv"/);
  assert.ok(res.text.startsWith('\uFEFF'), 'CSV wajib ber-BOM UTF-8 (kompat Excel)');
  const baris = res.text.replace('\uFEFF', '').split('\n');
  assert.equal(baris[0], 'PERIODE,SEMAI,REMAJA,DEWASA,PANEN (KG),RATA-RATA PH');
  assert.ok(baris.length >= 1, 'minimal baris header');
});

test('GET /laporan/csv (token petani) → 403 PetaniGuard (guard berlaku juga pada sub-rute)', async () => {
  const res = await request(base).get('/laporan/csv').set(bearer(tokenPetani()));
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { message: PESAN_PETANI });
});
