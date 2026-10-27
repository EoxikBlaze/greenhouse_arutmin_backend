'use strict';
/**
 * Kalibrasi alat IoT: rumus konstanta firmware (pH dua titik, faktor TDS), status jadwal,
 * dan API /kalibrasi. Baris log yang dibuat dihapus & kolom yang diubah dipulihkan di after().
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { startServer, craftToken, bearer } = require('./_server');
const { q } = require('../../src/db');
const { konstantaPh, konstantaEc, statusJadwal } = require('../../src/routes/kalibrasi');

let srv; let base; let admin; let demo; let petani; let awalLog; let snap;

before(async () => {
  srv = await startServer(); base = srv.base;
  admin = craftToken({ sub: 1, username: 'garap', level: 'admin', demo: false }, { expiresIn: '10m' });
  demo = craftToken({ sub: 2, username: 'demo', level: 'user', demo: true }, { expiresIn: '10m' });
  petani = craftToken({ sub: 3, username: 'petani', level: 'petani', demo: false }, { expiresIn: '10m' });
  awalLog = Number((await q('SELECT coalesce(max(id), 0) AS m FROM kalibrasi_log'))[0].m);
  snap = await q("SELECT sensor, terakhir_dikalibrasi, hasil_ukur, konstanta, periode_hari_min, periode_hari_max, toleransi FROM kalibrasi_sensor WHERE sensor IN ('ph','ec','suhu_air')");
});

after(async () => {
  await q('DELETE FROM kalibrasi_log WHERE id > $1', [awalLog]);
  for (const s of snap) {
    await q(`UPDATE kalibrasi_sensor SET terakhir_dikalibrasi = $2, hasil_ukur = $3, konstanta = $4, periode_hari_min = $5,
             periode_hari_max = $6, toleransi = $7 WHERE sensor = $1`,
    [s.sensor, s.terakhir_dikalibrasi, s.hasil_ukur, s.konstanta, s.periode_hari_min, s.periode_hari_max, s.toleransi]);
  }
  await srv.stop();
});

/** pH yang dihitung firmware dari tegangan v dengan konstanta tertentu (rumus sensor.ino). */
const phFirmware = ({ PH_V7, PH_V4 }, v) => 7 + ((4.01 - 7) / (PH_V4 - PH_V7)) * (v - PH_V7);

test('unit pH: konstanta lama sudah tepat → hasil sama; probe bergeser → konstanta baru membaca buffer dengan benar', () => {
  const lama = { PH_V7: 2.5, PH_V4: 3.05 };
  assert.deepEqual(konstantaPh(lama, { buffer1: 6.86, baca1: 6.86, buffer2: 4.0, baca2: 4.0 }), { PH_V7: 2.5, PH_V4: 3.05 });

  // probe sebenarnya: 2,40 V di pH 6,86 dan 2,95 V di pH 4,00 → firmware lama membaca angka lain
  const v1 = 2.40; const v2 = 2.95;
  const baru = konstantaPh(lama, { buffer1: 6.86, baca1: phFirmware(lama, v1), buffer2: 4.0, baca2: phFirmware(lama, v2) });
  assert.ok(Math.abs(phFirmware(baru, v1) - 6.86) < 0.01, `buffer 6,86 terbaca ${phFirmware(baru, v1)}`);
  assert.ok(Math.abs(phFirmware(baru, v2) - 4.0) < 0.01, `buffer 4,00 terbaca ${phFirmware(baru, v2)}`);
});

test('unit EC & jadwal', () => {
  assert.deepEqual(konstantaEc({ TDS_FAKTOR_KOREKSI: 1 }, { ref_us_cm: 1413, baca_ppm: 706.5 }), { TDS_FAKTOR_KOREKSI: 1 });
  assert.equal(konstantaEc({ TDS_FAKTOR_KOREKSI: 1 }, { ref_us_cm: 1413, baca_ppm: 650 }).TDS_FAKTOR_KOREKSI, 1.0869);
  const hari = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
  assert.equal(statusJadwal({ periode_hari_min: 7, periode_hari_max: 14, terakhir_dikalibrasi: hari(3) }).status, 'aman');
  assert.equal(statusJadwal({ periode_hari_min: 7, periode_hari_max: 14, terakhir_dikalibrasi: hari(10) }).status, 'segera');
  assert.equal(statusJadwal({ periode_hari_min: 7, periode_hari_max: 14, terakhir_dikalibrasi: hari(15) }).status, 'terlambat');
  assert.equal(statusJadwal({ periode_hari_min: 7, periode_hari_max: 14, terakhir_dikalibrasi: null }).status, 'belum');
  assert.equal(statusJadwal({ periode_hari_min: null, periode_hari_max: null }).status, 'tanpa_jadwal');
});

test('hak akses: petani 403; demo baca saja', async () => {
  assert.equal((await request(base).get('/kalibrasi').set(bearer(petani))).status, 403);
  assert.equal((await request(base).get('/kalibrasi').set(bearer(demo))).status, 200);
  assert.equal((await request(base).post('/kalibrasi/ph').set(bearer(demo)).send({ catatan: 'x' })).status, 403);
  assert.equal((await request(base).post('/kalibrasi/tidak_ada').set(bearer(admin)).send({})).status, 404);
});

test('API: catat kalibrasi pH & EC → konstanta baru tersimpan, jadwal jadi "aman", riwayat tercatat', async () => {
  await q(`UPDATE kalibrasi_sensor SET konstanta = '{"PH_V7": 2.5, "PH_V4": 3.05}', terakhir_dikalibrasi = NULL WHERE sensor = 'ph'`);
  await q(`UPDATE kalibrasi_sensor SET konstanta = '{"TDS_FAKTOR_KOREKSI": 1.0}' WHERE sensor = 'ec'`);
  let daftar = (await request(base).get('/kalibrasi').set(bearer(admin))).body;
  assert.equal(daftar.find((r) => r.sensor === 'ph').status, 'belum');

  // validasi: bacaan kosong / hampir sama
  assert.equal((await request(base).post('/kalibrasi/ph').set(bearer(admin)).send({ baca1: 7.1 })).status, 422);
  const mirip = await request(base).post('/kalibrasi/ph').set(bearer(admin)).send({ baca1: 6.9, baca2: 6.8 });
  assert.equal(mirip.status, 422);
  assert.ok(mirip.body.errors.baca2);

  const r = await request(base).post('/kalibrasi/ph').set(bearer(admin))
    .send({ buffer1: 6.86, baca1: 7.06, buffer2: 4.0, baca2: 4.3, catatan: 'uji otomatis' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(r.body.data.konstanta_baru.PH_V7 && r.body.data.konstanta_baru.PH_V4);
  assert.deepEqual(r.body.data.konstanta_lama, { PH_V7: 2.5, PH_V4: 3.05 });
  daftar = (await request(base).get('/kalibrasi').set(bearer(admin))).body;
  const ph = daftar.find((x) => x.sensor === 'ph');
  assert.equal(ph.status, 'aman');
  assert.deepEqual(ph.konstanta, r.body.data.konstanta_baru);
  assert.equal(ph.log_terakhir.oleh_label, 'garap');

  const ec = await request(base).post('/kalibrasi/ec').set(bearer(admin)).send({ baca_ppm: 650 });
  assert.equal(ec.status, 201);
  assert.equal(ec.body.data.konstanta_baru.TDS_FAKTOR_KOREKSI, 1.0869);
  assert.equal((await request(base).post('/kalibrasi/ec').set(bearer(admin)).send({ baca_ppm: 100 })).status, 422, 'faktor 7× ditolak');

  // lulus otomatis dari toleransi (suhu air: 0,5 °C)
  const suhu = await request(base).post('/kalibrasi/suhu_air').set(bearer(admin)).send({ nilai_ref: 26.0, bacaan_sesudah: 26.3 });
  assert.equal(suhu.body.data.lulus, true);
  const riwayat = (await request(base).get('/kalibrasi/ph/riwayat').set(bearer(admin))).body;
  assert.equal(riwayat[0].catatan, 'uji otomatis');
});

test('API: atur jadwal & konstanta, validasi', async () => {
  const ok = await request(base).put('/kalibrasi/suhu_air').set(bearer(admin)).send({ periode_hari_min: 60, periode_hari_max: 90, toleransi: 0.4 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.periode_hari_min, 60);
  assert.equal((await request(base).put('/kalibrasi/suhu_air').set(bearer(admin)).send({ periode_hari_min: 100, periode_hari_max: 90 })).status, 422);
  assert.equal((await request(base).put('/kalibrasi/ph').set(bearer(admin)).send({ konstanta: { 'ph v7': 'x' } })).status, 422);
  const k = await request(base).put('/kalibrasi/ph').set(bearer(admin)).send({ konstanta: { PH_V7: 2.48, PH_V4: 3.02 } });
  assert.deepEqual(k.body.data.konstanta, { PH_V7: 2.48, PH_V4: 3.02 });
});
