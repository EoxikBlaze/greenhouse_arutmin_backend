'use strict';
/**
 * Integripsi gelombang-2 #4 — API ESP32 (src/routes/monitoring.js `api` + guard
 * requireApiKey di src/auth.js) & rute kompatibilitas CI4 ber-X-API-KEY.
 *
 * Kontrak guard: tanpa / salah X-API-KEY → 403 {"status":false,"msg":"Unauthorized"}
 * (perbandingan timing-safe); key BENAR → rute dijalankan (200/400 tergantung body).
 * KEY dibaca dari env (src/config.esp32ApiKey — sumber yang DIPAKAI server) dan
 * TIDAK PERNAH dicetak/dilog di mana pun.
 *
 * NET-ZERO per-PERMINTAAN: tiap POST (yang seharusnya ditolak 403, atau berhenti
 * di validasi payload 400 SEBELUM insert) diapit penghitungan monitorings &
 * alert_logs sebelum & sesudahnya (jendela ~ms) → membuktikan suite ini tidak
 * menulis baris, sekaligus tidak goyah bila pihak lain menulis di luar jendela.
 * 1 login admin (untuk pembanding), token lain tidak diperlukan.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { startServer, adminToken, bearer } = require('./_server');

const KEY = require('../../src/config').esp32ApiKey; // dari env; JANGAN cetak
const KEY_SALAH = 'bukan-kunci-esp32-1234567890';

let srv;
let base;
let auth;

const UNAUTHORIZED = { status: false, msg: 'Unauthorized' };

/** Penghitung baris yang boleh berubah hanya akibat tulisan. */
async function hitungBaris() {
  const { q } = require('../../src/db');
  const m = await q('SELECT count(*)::int AS c FROM monitorings');
  const a = await q('SELECT count(*)::int AS c FROM alert_logs');
  return { m: m[0].c, a: a[0].c };
}

/**
 * Kirim request yang TIDAK BOLEH menulis (403 guard / 400 validasi);
 * jumlah monitorings & alert_logs wajib identik sebelum & sesudahnya.
 */
async function kirimTanpaTulis(label, buatRequest) {
  const sebelum = await hitungBaris();
  const res = await buatRequest();
  const sesudah = await hitungBaris();
  assert.equal(sesudah.m, sebelum.m, `${label}: baris monitorings bertambah — request seharusnya tidak menulis`);
  assert.equal(sesudah.a, sebelum.a, `${label}: baris alert_logs bertambah — request seharusnya tidak menulis`);
  return res;
}

before(async () => {
  srv = await startServer();
  base = srv.base;
  auth = bearer(await adminToken(base));
  assert.ok(KEY && String(KEY).length > 0,
    'ESP32_API_KEY kosong di env — guard menerima key kosong, uji jadi tidak berarti');
});
after(async () => {
  if (!srv) return;
  const { pool } = require('../../src/db');
  await srv.stop();
  await pool.end(); // wajib: tutup pool agar proses test-runner bisa keluar
});

test('GET /api/get-thresholds TANPA X-API-KEY → 403 kontrak Unauthorized', async () => {
  const res = await request(base).get('/api/get-thresholds');
  assert.equal(res.status, 403, `body: ${res.text}`);
  assert.deepEqual(res.body, UNAUTHORIZED);
});

test('GET /api/get-thresholds dgn X-API-KEY SALAH → 403 kontrak identik (timing-safe)', async () => {
  const res = await request(base).get('/api/get-thresholds').set('X-API-KEY', KEY_SALAH);
  assert.equal(res.status, 403, `body: ${res.text}`);
  assert.deepEqual(res.body, UNAUTHORIZED);
});

test('GET /api/get-thresholds dgn X-API-KEY benar (dari env) → 200 {status:true, thresholds, fetched_at}', async () => {
  const res = await request(base).get('/api/get-thresholds').set('X-API-KEY', KEY);
  assert.equal(res.status, 200, `body: ${res.text}`);
  assert.equal(res.body.status, true);
  assert.equal(typeof res.body.thresholds, 'object');
  assert.ok(res.body.thresholds && !Array.isArray(res.body.thresholds), 'thresholds wajib objek peta sensor');
  for (const [sensor, th] of Object.entries(res.body.thresholds)) {
    assert.ok('min' in th && 'max' in th, `thresholds.${sensor} harus punya min/max`);
  }
  assert.ok(!Number.isNaN(Date.parse(res.body.fetched_at)), 'fetched_at harus tanggal valid');
  // Key tidak boleh ikut terkirim balik ke klien.
  assert.equal(JSON.stringify(res.body).includes(String(KEY)), false, 'key tidak boleh bocor di respons');
});

test('POST /api/save-sensor TANPA key → 403 (BFLA tertutup) dan tidak menulis baris', async () => {
  const res = await kirimTanpaTulis('save-sensor anonim',
    () => request(base).post('/api/save-sensor').send({ ph: 6.1 }));
  assert.equal(res.status, 403, `body: ${res.text}`);
  assert.deepEqual(res.body, UNAUTHORIZED);
});

test('POST /api/save-sensor dgn key SALAH → 403, tidak menulis baris', async () => {
  const res = await kirimTanpaTulis('save-sensor key salah',
    () => request(base).post('/api/save-sensor').set('X-API-KEY', KEY_SALAH).send({ ph: 6.1 }));
  assert.equal(res.status, 403, `body: ${res.text}`);
  assert.deepEqual(res.body, UNAUTHORIZED);
});

test('POST /monitoring/saveSensor (kompatibilitas CI4) TANPA key → 403 guard sama, tidak menulis', async () => {
  const res = await kirimTanpaTulis('saveSensor CI4 anonim',
    () => request(base).post('/monitoring/saveSensor').send({ ph: 6.1 }));
  assert.equal(res.status, 403, `body: ${res.text}`);
  assert.deepEqual(res.body, UNAUTHORIZED);
});

test('POST /monitoring/saveAlert TANPA key → 403 guard sama, tidak menulis', async () => {
  const res = await kirimTanpaTulis('saveAlert anonim',
    () => request(base).post('/monitoring/saveAlert').send({ type: 'solenoid', value: 'ON' }));
  assert.equal(res.status, 403, `body: ${res.text}`);
  assert.deepEqual(res.body, UNAUTHORIZED);
});

test('POST /api/notif-hardware TANPA key → 403, tidak menulis', async () => {
  const res = await kirimTanpaTulis('notif-hardware anonim',
    () => request(base).post('/api/notif-hardware').send({ type: 'solenoid', value: 'ON' }));
  assert.equal(res.status, 403, `body: ${res.text}`);
  assert.deepEqual(res.body, UNAUTHORIZED);
});

test('POST /api/save-sensor dgn key benar tapi body kosong → 400 "No payload" SEBELUM insert', async () => {
  const res = await kirimTanpaTulis('save-sensor body kosong',
    () => request(base).post('/api/save-sensor').set('X-API-KEY', KEY).send({}));
  assert.equal(res.status, 400, `body: ${res.text}`);
  assert.deepEqual(res.body, { status: 'error', message: 'No payload' });
});

test('POST /api/notif-hardware dgn key benar tapi tanpa type/value → 400 kontrak, tidak menulis', async () => {
  const res = await kirimTanpaTulis('notif-hardware body kosong',
    () => request(base).post('/api/notif-hardware').set('X-API-KEY', KEY).send({}));
  assert.equal(res.status, 400, `body: ${res.text}`);
  assert.deepEqual(res.body, { status: false, msg: 'type dan value wajib' });
});

test('GET /api/latest-sensor (publik, tanpa key) → 200 bentuk polling SPA', async () => {
  const res = await request(base).get('/api/latest-sensor');
  assert.equal(res.status, 200, `body: ${res.text}`);
  assert.equal(typeof res.body.is_online, 'boolean');
  assert.ok('seconds_ago' in res.body, 'seconds_ago wajib ada');
  assert.ok(Array.isArray(res.body.anomalies), 'anomalies wajib array');
  assert.ok('sensor' in res.body && 'water_control' in res.body, 'sensor & water_control wajib ada');
  if (res.body.water_control) {
    for (const kolom of ['mode', 'valve_state', 'command']) {
      assert.ok(kolom in res.body.water_control, `water_control.${kolom} hilang`);
    }
  }
});
