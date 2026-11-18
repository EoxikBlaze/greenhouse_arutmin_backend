'use strict';
/**
 * /api/ai/analisis-harian — laporan harian deterministik + notifikasi (dedup) + otorisasi.
 * Jalankan lewat: bash scripts/regresi.sh test/integration/ai-analisis-harian.test.js (DB uji terisolasi).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { startServer, craftToken, bearer } = require('./_server');
const { q } = require('../../src/db');
const { lewati } = require('./_isolasi');

const OPSI = { skip: lewati || false };
const URL = '/api/ai/analisis-harian';
let srv; let base; let admin; let petani; let demo;
const tok = (level, sub, isDemo = false) => bearer(craftToken({ sub, username: level, level, demo: isDemo }, { expiresIn: '10m' }));

before(async () => {
  if (lewati) return;
  srv = await startServer(); base = srv.base;
  // id 999999 tidak ada di users: dijalankan_oleh harus jadi NULL, bukan galat FK
  admin = tok('admin', 999999); petani = tok('petani', 3); demo = tok('demo', 4, true);
});

after(async () => {
  if (lewati) return;
  await srv.stop();
});

test('tanpa token → 401; demo → 403; petani tidak boleh menjalankan → 403', OPSI, async () => {
  assert.equal((await request(base).get(URL)).status, 401);
  assert.equal((await request(base).get(`${URL}/terbaru`).set(demo)).status, 403);
  assert.equal((await request(base).post(`${URL}/jalankan`).set(petani)).status, 403);
});

test('belum ada laporan → terbaru null; tanggal salah 422; tanggal tiada 404', OPSI, async () => {
  const r = await request(base).get(`${URL}/terbaru`).set(petani);
  assert.equal(r.status, 200);
  assert.equal(r.body.data, null);
  assert.equal((await request(base).get(`${URL}/2026-02-30`).set(petani)).status, 422);
  assert.equal((await request(base).get(`${URL}/kemarin`).set(petani)).status, 422);
  assert.equal((await request(base).get(`${URL}/2000-01-01`).set(petani)).status, 404);
});

test('admin menjalankan → laporan lengkap tersimpan + satu notifikasi; jalankan ulang = upsert tanpa notifikasi ganda', OPSI, async () => {
  const r1 = await request(base).post(`${URL}/jalankan`).set(admin);
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  const { tanggal, isi, pemicu, dijalankan_oleh: oleh } = r1.body.data;
  assert.match(tanggal, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(pemicu, 'manual');
  assert.equal(oleh, null);
  assert.equal(isi.sumber, 'deterministik');
  assert.equal(isi.bagian.length, 9);
  assert.ok(isi.bagian.at(-1).butir.some((b) => /alur persetujuan dosing/.test(b)));

  const r2 = await request(base).post(`${URL}/jalankan`).set(admin);
  assert.equal(r2.status, 200);
  assert.equal(r2.body.data.id, r1.body.data.id);

  const notif = await q("SELECT severity, judul, tautan FROM notifikasi WHERE jenis = 'ai_harian' AND dedup_key = $1", [`ai-harian:${tanggal}`]);
  assert.equal(notif.length, 1);
  assert.deepEqual(notif[0].tautan, { halaman: 'asisten', tab: 'analisis-harian', tanggal });
  assert.equal(notif[0].severity, isi.prioritas === 'tinggi' ? 'warning' : 'info');

  const terbaru = await request(base).get(`${URL}/terbaru`).set(petani);
  assert.equal(terbaru.body.data.tanggal, tanggal);
  const per = await request(base).get(`${URL}/${tanggal}`).set(petani);
  assert.equal(per.status, 200);
  assert.equal(per.body.data.isi.judul, isi.judul);
  const daftar = await request(base).get(URL).set(petani);
  assert.equal(daftar.body.data.length, 1);
  assert.equal(daftar.body.data[0].judul, isi.judul);
});

test('dua permintaan bersamaan → satu 409', OPSI, async () => {
  const hasil = await Promise.all([1, 2].map(() => request(base).post(`${URL}/jalankan`).set(admin)));
  assert.deepEqual(hasil.map((r) => r.status).sort(), [200, 409]);
});
