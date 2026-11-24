'use strict';
/**
 * GET /api/ai/insights — statistik & anomali deterministik. Data SINTETIS, dibuat dan dihapus di sini.
 * Jalankan lewat: bash scripts/regresi.sh test/integration/ai-insights.test.js (DB uji terisolasi).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { startServer, craftToken, bearer } = require('./_server');
const { q, one } = require('../../src/db');
const { lewati } = require('./_isolasi');

const OPSI = { skip: lewati || false };
let srv; let base; let petani; let demo; let idMeja; let idMejaLain;
const tok = (level, sub, isDemo = false) => bearer(craftToken({ sub, username: level, level, demo: isDemo }, { expiresIn: '10m' }));

before(async () => {
  if (lewati) return;
  srv = await startServer(); base = srv.base;
  petani = tok('petani', 3); demo = tok('demo', 4, true);
  idMeja = (await one("INSERT INTO mejas (meja, jumlah_lubang) VALUES ('UJI Insight', 10) RETURNING id_meja")).id_meja;
  idMejaLain = (await one("INSERT INTO mejas (meja, jumlah_lubang) VALUES ('UJI Insight Lain', 10) RETURNING id_meja")).id_meja;
  // 120 bacaan tiap 5 dtk (10 menit terakhir): TDS turun 1400 → 1281, pH tetap 6.0
  await q(`INSERT INTO monitorings (ph, tds, "waterTemp", "airTemp", humidity, id_meja, created_at)
           SELECT 6.0, 1400 - g, 26, 29, 70, $1, LOCALTIMESTAMP - make_interval(secs => (120 - g) * 5)
             FROM generate_series(1, 120) g`, [idMeja]);
  await q(`INSERT INTO monitorings (ph, tds, id_meja, created_at) VALUES (9.9, 9999, $1, LOCALTIMESTAMP)`, [idMejaLain]);
});

after(async () => {
  if (lewati) return;
  await q('DELETE FROM monitorings WHERE id_meja = ANY($1)', [[idMeja, idMejaLain]]);
  await q('DELETE FROM mejas WHERE id_meja = ANY($1)', [[idMeja, idMejaLain]]);
  await srv.stop();
});

test('tanpa token → 401; akun demo → 403', OPSI, async () => {
  assert.equal((await request(base).get('/api/ai/insights')).status, 401);
  assert.equal((await request(base).get('/api/ai/insights').set(demo)).status, 403);
});

test('periode / id_meja tidak sah → 422', OPSI, async () => {
  assert.equal((await request(base).get('/api/ai/insights?periode=1%20tahun').set(petani)).status, 422);
  assert.equal((await request(base).get("/api/ai/insights?id_meja=1;DROP").set(petani)).status, 422);
});

test('1 jam, satu meja: angka dari hitungan, data meja lain tidak tercampur', OPSI, async () => {
  const res = await request(base).get(`/api/ai/insights?periode=1j&id_meja=${idMeja}`).set(petani);
  assert.equal(res.status, 200);
  assert.equal(res.body.sumber, 'deterministik');
  assert.equal(res.body.real_time, true);
  const s = Object.fromEntries(res.body.sensor.map((x) => [x.sensor, x]));
  assert.equal(s.tds.statistik.n, 120);
  assert.equal(s.tds.statistik.maks, 1399);   // 9999 milik meja lain tidak ikut
  assert.equal(s.tds.statistik.akhir, 1280);
  assert.equal(s.tds.statistik.arah, 'turun');
  assert.equal(s.ph.statistik.rata, 6);
  assert.ok(!s.ph.anomali.some((a) => a.jenis === 'basi'));
});

test('7 hari: diagregasi per 5 menit', OPSI, async () => {
  const res = await request(base).get(`/api/ai/insights?periode=7h&id_meja=${idMeja}`).set(petani);
  assert.equal(res.status, 200);
  assert.equal(res.body.resolusi_detik, 300);
  const tds = res.body.sensor.find((x) => x.sensor === 'tds');
  assert.ok(tds.statistik.n >= 2 && tds.statistik.n <= 4);
});

test('laporan harian: templat deterministik, hanya meja yang diminta; jenis tak sah → 422', OPSI, async () => {
  assert.equal((await request(base).get('/api/ai/laporan?jenis=tahunan').set(petani)).status, 422);
  const res = await request(base).get(`/api/ai/laporan?jenis=harian&id_meja=${idMeja}`).set(petani);
  assert.equal(res.status, 200);
  assert.equal(res.body.jenis, 'harian');
  assert.equal(res.body.sumber, 'deterministik');
  assert.equal(res.body.sifat, 'rekomendasi');
  assert.match(res.body.ringkasan.find((s) => s.startsWith('TDS')), /maks 1399/);
  assert.ok(res.body.ringkasan.some((s) => s.startsWith('Alert:')));
  assert.ok(!res.body.teks.includes('9999'));
});
