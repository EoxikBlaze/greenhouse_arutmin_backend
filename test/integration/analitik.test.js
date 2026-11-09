'use strict';
/**
 * /api/analitik — prediksi panen, saran dosis (teks), ringkasan, ekspor CSV.
 * Membuat meja + tanaman + batch uji sendiri; semua dihapus di after().
 * Jalankan lewat: bash scripts/regresi.sh test/integration/analitik.test.js (DB uji terisolasi).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { startServer, craftToken, bearer } = require('./_server');
const { q, one } = require('../../src/db');
const { lewati } = require('./_isolasi');

const OPSI = { skip: lewati || false };
let srv; let base; let admin; let petani; let idMeja; let idTanaman; let idSemai; let idAlert;
const tok = (level, sub, demo = false) => bearer(craftToken({ sub, username: level, level, demo }, { expiresIn: '10m' }));

before(async () => {
  if (lewati) return;
  srv = await startServer(); base = srv.base;
  admin = tok('admin', 1); petani = tok('petani', 3);
  idMeja = (await one("INSERT INTO mejas (meja, jumlah_lubang) VALUES ('UJI Analitik', 10) RETURNING id_meja")).id_meja;
  idTanaman = (await one("INSERT INTO tanamen (nama_tanaman) VALUES ('UJI Melon Analitik') RETURNING id_tanaman")).id_tanaman;
  for (const [nama, hari] of [['Semai', 10], ['Peremajaan', 15], ['Pendewasaan', 45]]) {
    await q('INSERT INTO sikluses (id_tanaman, nama_siklus, waktu_siklus) VALUES ($1, $2, $3)', [idTanaman, nama, hari]);
  }
  idSemai = (await one(
    `INSERT INTO semais (id_tanaman, jumlah_benih, tgl_awal_semai, tgl_akhir_semai, status, id_meja)
     VALUES ($1, 20, current_date - 5, current_date + 5, 'proses', $2) RETURNING id_semai`, [idTanaman, idMeja])).id_semai;
  idAlert = (await one(
    `INSERT INTO alert_logs (type, value, severity) VALUES ('UJI', '=HYPERLINK("x")', 'warning') RETURNING id`)).id;
});

after(async () => {
  if (lewati) return;
  await q('DELETE FROM alert_logs WHERE id = $1', [idAlert]);
  await q('DELETE FROM semais WHERE id_semai = $1', [idSemai]);
  await q('DELETE FROM sikluses WHERE id_tanaman = $1', [idTanaman]);
  await q('DELETE FROM tanamen WHERE id_tanaman = $1', [idTanaman]);
  await q('DELETE FROM mejas WHERE id_meja = $1', [idMeja]);
  await srv.stop();
});

test('tanpa token → 401 di semua rute analitik', OPSI, async () => {
  for (const p of ['/prediksi-panen', '/saran-dosis', '/ringkasan', '/ekspor/sensor.csv']) {
    assert.equal((await request(base).get(`/api/analitik${p}`)).status, 401, p);
  }
});

test('prediksi-panen: batch semai uji → 70 hari dari mulai (5 hari lalu → sisa 65)', OPSI, async () => {
  const res = await request(base).get('/api/analitik/prediksi-panen').set(admin);
  assert.equal(res.status, 200, res.text);
  const b = res.body.list.find((x) => x.tipe === 'semai' && x.id === idSemai);
  assert.ok(b, 'batch uji harus muncul');
  assert.equal(b.varietas, 'UJI Melon Analitik');
  assert.equal(b.prediksi.sisa_hari, 65);
  assert.equal(b.prediksi.status, 'sesuai');
});

test('prediksi-panen: petani boleh membaca (200)', OPSI, async () => {
  assert.equal((await request(base).get('/api/analitik/prediksi-panen').set(petani)).status, 200);
});

test('saran-dosis: bentuk jawaban + catatan tidak mengeksekusi', OPSI, async () => {
  const res = await request(base).get('/api/analitik/saran-dosis?jam=6').set(admin);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body.saran.map((s) => s.sensor), ['ph', 'tds']);
  assert.match(res.body.catatan, /persetujuan dosing/);
  for (const s of res.body.saran) assert.ok(['aman', 'perhatian', 'di_luar', 'data_kurang'].includes(s.status));
});

test('saran-dosis: jam tak sah dibatasi, tidak error', OPSI, async () => {
  const res = await request(base).get('/api/analitik/saran-dosis?jam=999999').set(admin);
  assert.equal(res.status, 200);
  assert.equal(res.body.jendela_jam, 72);
});

test('ringkasan: bentuk + tanggal tak sah → 422', OPSI, async () => {
  const ok = await request(base).get('/api/analitik/ringkasan').set(admin);
  assert.equal(ok.status, 200, ok.text);
  for (const k of ['sensor', 'alert', 'panen', 'tanam', 'batch_berjalan']) assert.ok(k in ok.body, k);
  assert.equal((await request(base).get('/api/analitik/ringkasan?dari=bukan-tanggal').set(admin)).status, 422);
});

test('ekspor sensor.csv: header + BOM + content-disposition', OPSI, async () => {
  const res = await request(base).get('/api/analitik/ekspor/sensor.csv').set(admin);
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/csv/);
  assert.match(res.headers['content-disposition'], /attachment; filename="sensor-awal_kini\.csv"/);
  assert.ok(res.text.startsWith('﻿waktu,ph,tds_ppm'));
});

test('ekspor peringatan.csv: awalan rumus dinetralkan', OPSI, async () => {
  const res = await request(base).get('/api/analitik/ekspor/peringatan.csv').set(admin);
  assert.equal(res.status, 200);
  assert.ok(res.text.includes(`"'=HYPERLINK(""x"")"`), 'rumus harus diawali kutip tunggal');
  assert.ok(!/(^|,)=HYPERLINK/m.test(res.text), 'tidak boleh ada sel berawalan =');
});

test('ekspor: jenis tak dikenal 404, tanggal tak sah 422, __proto__ aman', OPSI, async () => {
  assert.equal((await request(base).get('/api/analitik/ekspor/rahasia.csv').set(admin)).status, 404);
  assert.equal((await request(base).get('/api/analitik/ekspor/__proto__.csv').set(admin)).status, 404);
  assert.equal((await request(base).get('/api/analitik/ekspor/sensor.csv?sampai=32-13-2026').set(admin)).status, 422);
});
