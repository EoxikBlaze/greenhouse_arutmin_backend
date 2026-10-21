'use strict';
/**
 * Pesan validasi 422 — BAHASA MANUSIA (temuan review awam:
 * 'Kolom nama_siklus wajib diisi.' membingungkan petani).
 *
 * Suite ini mengunci:
 *  1. isi pesan memakai label sehari-hari ('Nama siklus belum diisi.', bukan
 *     'Kolom nama_siklus wajib diisi.');
 *  2. KONTRAK error TIDAK berubah — 422 {message:'Data tidak valid.',
 *     errors:{<kolom>:[pesan]}} dengan kunci errors = nama kolom ASLI;
 *  3. semua kasus ditolak SEBELUM query tulis → net-zero (tidak ada baris uji).
 *
 * Sumber pesan: src/routes/_validate.js (messageFor). Rute memakai crudRouter
 * (master.js / tahap.js) sehingga lewat validateBody yang sama.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { startServer, adminToken, bearer } = require('./_server');

let srv;
let base;
let auth;

before(async () => {
  srv = await startServer();
  base = srv.base;
  auth = bearer(await adminToken(base));
});

after(async () => { if (srv) await srv.stop(); });

/** Kirim body, paksa 422 kontrak, kembalikan errors. */
async function tolak(path, body) {
  const res = await request(base).post(path).set(auth).send(body);
  assert.equal(res.status, 422, `${path} ${JSON.stringify(body)} → 422; aktual ${res.status}: ${res.text}`);
  assert.equal(res.body.message, 'Data tidak valid.', 'kontrak {message, errors} wajib utuh');
  assert.equal(typeof res.body.errors, 'object');
  assert.ok(!Array.isArray(res.body.errors), 'errors berupa objek per-field');
  return res.body.errors;
}

test('required — kolom kosong → "<Label> belum diisi." (bukan "Kolom X wajib diisi.")', async () => {
  const e = await tolak('/siklus', { nama_siklus: '' });
  assert.deepEqual(e.nama_siklus, ['Nama siklus belum diisi.']);

  const e2 = await tolak('/meja', { jumlah_lubang: 10 });
  assert.deepEqual(e2.meja, ['Nama meja belum diisi.']);
  assert.equal(e2.jumlah_lubang, undefined, 'kolom terkirim valid tidak ikut error');
});

test('required — field TIDAK dikirim saat CREATE → "<Label> belum diisi."', async () => {
  const e = await tolak('/semai', { jumlah_benih: 10 });
  assert.deepEqual(e.tgl_awal_semai, ['Tanggal mulai semai belum diisi.']);
  assert.deepEqual(e.tgl_akhir_semai, ['Tanggal akhir semai belum diisi.']);
  assert.equal(e.jumlah_benih, undefined);
});

test('null → "<Label> tidak boleh kosong (null)."', async () => {
  const e = await tolak('/siklus', { nama_siklus: null });
  assert.deepEqual(e.nama_siklus, ['Nama siklus tidak boleh kosong (null).']);
});

test('rentang — "<Label> harus bernilai antara a dan b."', async () => {
  const e = await tolak('/meja', { meja: 'Uji Rentang', jumlah_lubang: 0 });
  assert.deepEqual(e.jumlah_lubang, ['Jumlah lubang harus bernilai antara 1 dan 1000000.']);
});

test('tipe salah — "<Label> harus berupa angka/bulat/teks."', async () => {
  const e = await tolak('/ambang', { sensor: 'ph', min: 'rendah', max: 10 });
  assert.deepEqual(e.min, ['Nilai minimum harus berupa angka.']);

  const e2 = await tolak('/siklus', { nama_siklus: 'X', waktu_siklus: 'cepat' });
  assert.deepEqual(e2.waktu_siklus, ['Waktu siklus (hari) harus berupa angka bulat.']);
});

test('enum — "<Label> hanya boleh diisi: a, b, …."', async () => {
  const e = await tolak('/ambang', { sensor: 'suhuKolam', min: 1, max: 2 });
  assert.deepEqual(e.sensor,
    ['Sensor hanya boleh diisi: waterTemp, ph, tds, airTemp, humidity.']);
});

test('tanggal — "<Label> harus berupa tanggal (format YYYY-MM-DD, contoh: …)."', async () => {
  const e = await tolak('/panen', { tgl_panen: '31-12-2026' });
  assert.deepEqual(e.tgl_panen,
    ['Tanggal panen harus berupa tanggal (format YYYY-MM-DD, contoh: 2026-10-21).']);
});

test('kunci errors tetap nama kolom ASLI (kontrak), hanya teksnya yang manusiawi', async () => {
  const e = await tolak('/siklus', { nama_siklus: '', waktu_siklus: 30 });
  assert.deepEqual(Object.keys(e), ['nama_siklus'], 'kunci errors tidak boleh ikut berubah');
  assert.ok(!JSON.stringify(e).includes('Kolom '), 'tidak ada awalan "Kolom " tersisa');
  assert.ok(!JSON.stringify(e).includes('wajib diisi'), 'kata "wajib diisi" sudah diganti');
});
