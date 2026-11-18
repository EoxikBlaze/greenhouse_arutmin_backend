'use strict';
/** UJI_POMPA + kiriman laju pompa (KALIBRASI) ke alat. DOSIS tetap tidak pernah dikirim. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { startServer, craftToken, bearer } = require('./_server');
const { lewati } = require('./_isolasi');
const { q } = require('../../src/db');
const aktuator = require('../../src/aktuator');

let srv; let srvKunci; let admin; let petani;

const pemeliharaan = (aktif) => q('UPDATE penampung_states SET mode_pemeliharaan = $1', [aktif]);
const bersih = () => q("DELETE FROM perintah_aktuator WHERE tipe IN ('UJI_POMPA','KALIBRASI','BALIK_KALIBRASI')");

before(async () => {
  if (lewati) return;
  delete process.env.UJI_POMPA_DIIZINKAN;
  srvKunci = await startServer(); // bawaan: uji pompa dikunci
  process.env.UJI_POMPA_DIIZINKAN = '1';
  srv = await startServer();
  delete process.env.UJI_POMPA_DIIZINKAN;
  admin = bearer(craftToken({ sub: 1, username: 'garap', level: 'admin', demo: false }, { expiresIn: '1h' }));
  petani = bearer(craftToken({ sub: 2, username: 'petani', level: 'petani', demo: false }, { expiresIn: '1h' }));
  const meja = (await q('SELECT id_meja FROM mejas ORDER BY id_meja LIMIT 1'))[0];
  await q('INSERT INTO penampung_states (id_meja) VALUES ($1) ON CONFLICT DO NOTHING', [meja.id_meja]);
  await q("UPDATE aktuator_state SET nilai = '0' WHERE kunci = 'estop'");
});
after(async () => {
  if (lewati) return;
  await pemeliharaan(false);
  await q("UPDATE aktuator_state SET nilai = '0' WHERE kunci = 'estop'");
  await bersih();
  await srv?.stop();
  await srvKunci?.stop();
});

test('validasi murni: UJI_POMPA dan KALIBRASI', () => {
  const v = (tipe, p) => aktuator.validasiPerintah(tipe, p, {});
  assert.deepEqual(v('UJI_POMPA', { pompa: 'ph_up', detik: 30 }), { pompa: 'PH_UP', detik: 30 });
  for (const p of [{ pompa: 'ISI_AIR', detik: 30 }, { pompa: 'A', detik: 4 }, { pompa: 'A', detik: 121 }, { pompa: 'A' }, {}]) {
    assert.throws(() => v('UJI_POMPA', p), (e) => e.status === 422, JSON.stringify(p));
  }
  assert.deepEqual(v('KALIBRASI', { laju_a: 2.1, laju_ph_down: 0.5, tds_faktor: 1.23456, lain: 1 }), { laju_a: 2.1, laju_ph_down: 0.5, tds_faktor: 1.2346 });
  assert.deepEqual(v('KALIBRASI', { ph_v7: 2.51234, ph_v4: 3.05 }), { ph_v7: 2.5123, ph_v4: 3.05 });
  assert.deepEqual(v('KALIBRASI', { tds_faktor: 1.5 }), { tds_faktor: 1.5 });
  assert.deepEqual(v('BALIK_KALIBRASI', { sensor: 'ph' }), { sensor: 'ph' });
  assert.deepEqual(v('BALIK_KALIBRASI', { sensor: 'ec' }), { sensor: 'ec' });
  assert.throws(() => v('BALIK_KALIBRASI', { sensor: 'suhu' }), (e) => e.status === 422);
  for (const p of [{}, { laju_a: 0 }, { laju_b: 501 }, { laju_a: 'x' }, { ph_v7: 2.5 }, { ph_v7: 2.5, ph_v4: 2.52 }, { ph_v7: 2.5, ph_v4: 9 }, { tds_faktor: 0.01 }, { tds_faktor: 21 }, { tds_faktor: 'x' }]) {
    assert.throws(() => v('KALIBRASI', p), (e) => e.status === 422, JSON.stringify(p));
  }
  assert.ok(aktuator.TIPE_DIKIRIM.includes('UJI_POMPA') && aktuator.TIPE_DIKIRIM.includes('KALIBRASI'));
  assert.equal(aktuator.TIPE_DIKIRIM.includes('DOSIS'), false);
});

test('uji pompa: terkunci bawaan (423), hanya admin, wajib mode pemeliharaan', { skip: lewati }, async () => {
  await bersih();
  await pemeliharaan(true);
  const kunci = await request(srvKunci.base).post('/iot-v41/uji-pompa').set(admin).send({ pompa: 'a', detik: 30 });
  assert.equal(kunci.status, 423);
  assert.equal(kunci.body.kode, 'uji_pompa_dikunci');

  assert.equal((await request(srv.base).post('/iot-v41/uji-pompa').set(petani).send({ pompa: 'a', detik: 30 })).status, 403);
  assert.equal((await request(srv.base).post('/iot-v41/uji-pompa').send({ pompa: 'a', detik: 30 })).status, 401);
  await pemeliharaan(false);
  const tanpa = await request(srv.base).post('/iot-v41/uji-pompa').set(admin).send({ pompa: 'a', detik: 30 });
  assert.equal(tanpa.status, 409);
  assert.equal(tanpa.body.kode, 'bukan_pemeliharaan');
  assert.equal((await q("SELECT count(*)::int AS n FROM perintah_aktuator WHERE tipe = 'UJI_POMPA'"))[0].n, 0);
});

test('uji pompa: diantre 202, satu per satu, ditolak saat E-STOP, terambil oleh alat', { skip: lewati }, async () => {
  await bersih();
  await pemeliharaan(true);
  assert.equal((await request(srv.base).post('/iot-v41/uji-pompa').set(admin).send({ pompa: 'a', detik: 500 })).status, 422);
  const r = await request(srv.base).post('/iot-v41/uji-pompa').set(admin).send({ pompa: 'b', detik: 30 });
  assert.equal(r.status, 202);
  assert.equal(r.body.dikonfirmasi, false);
  const baris = (await q('SELECT tipe, parameter, sumber FROM perintah_aktuator WHERE id = $1', [r.body.id_perintah]))[0];
  assert.deepEqual([baris.tipe, baris.parameter, baris.sumber], ['UJI_POMPA', { pompa: 'B', detik: 30 }, 'pengguna']);

  const kedua = await request(srv.base).post('/iot-v41/uji-pompa').set(admin).send({ pompa: 'a', detik: 30 });
  assert.equal(kedua.status, 409);
  assert.equal(kedua.body.kode, 'uji_pompa_berjalan');

  const diambil = await aktuator.ambilPerintah('aktuator-01', 5);
  assert.ok(diambil.some((p) => String(p.id) === String(r.body.id_perintah) && p.tipe === 'UJI_POMPA'));

  await bersih();
  await q("UPDATE aktuator_state SET nilai = '1' WHERE kunci = 'estop'");
  assert.equal((await request(srv.base).post('/iot-v41/uji-pompa').set(admin).send({ pompa: 'a', detik: 30 })).status, 423);
  await q("UPDATE aktuator_state SET nilai = '0' WHERE kunci = 'estop'");
  await assert.rejects(
    aktuator.buatPerintah({ tipe: 'UJI_POMPA', parameter: { pompa: 'A', detik: 30 }, sumber: 'otomasi' }),
    (e) => e.status === 403);
});

test('kalibrasi pompa: laju disimpan DAN diantre ke alat sebagai KALIBRASI', { skip: lewati }, async () => {
  await bersih();
  const r = await request(srv.base).post('/iot-v41/kalibrasi-pompa').set(admin).send({ pompa: 'ph_up', detik: 30, ml: 45 });
  assert.equal(r.status, 201);
  assert.ok(r.body.id_perintah, 'harus ada id perintah ke alat');
  const baris = (await q('SELECT tipe, parameter FROM perintah_aktuator WHERE id = $1', [r.body.id_perintah]))[0];
  assert.deepEqual([baris.tipe, baris.parameter], ['KALIBRASI', { laju_ph_up: 1.5 }]);
  assert.match(r.body.message, /menunggu konfirmasi alat/i);
});

test('kalibrasi pH: tegangan dua titik diantre ke alat; tanpa tegangan hanya tercatat; balik mengirim BALIK_KALIBRASI', { skip: lewati }, async () => {
  await bersih();
  const tanpa = await request(srv.base).post('/iot-v41/kalibrasi-dua-titik').set(admin).send({ sensor: 'ph', baca4: 4.2, baca7: 6.9 });
  assert.equal(tanpa.status, 201);
  assert.equal(tanpa.body.id_perintah, null);
  assert.match(tanpa.body.message, /BELUM dikirim ke alat/);

  const buruk = await request(srv.base).post('/iot-v41/kalibrasi-dua-titik').set(admin).send({ sensor: 'ph', baca4: 4.2, baca7: 6.9, volt4: 2.5, volt7: 2.51 });
  assert.equal(buruk.status, 422, 'selisih tegangan < 0,05 V');

  const r = await request(srv.base).post('/iot-v41/kalibrasi-dua-titik').set(admin).send({ sensor: 'ph', baca4: 4.2, baca7: 6.9, volt4: 3.1, volt7: 2.48 });
  assert.equal(r.status, 201);
  const baris = (await q('SELECT tipe, parameter FROM perintah_aktuator WHERE id = $1', [r.body.id_perintah]))[0];
  assert.deepEqual([baris.tipe, baris.parameter], ['KALIBRASI', { ph_v7: 2.48, ph_v4: 3.1 }]);
  assert.equal((await q("SELECT count(*)::int AS n FROM perintah_aktuator WHERE tipe = 'KALIBRASI'"))[0].n, 1, 'yang ditolak dan yang tanpa tegangan tidak diantre');

  const balik = await request(srv.base).post('/iot-v41/kalibrasi-dua-titik').set(admin).send({ sensor: 'ph', aksi: 'balik' });
  assert.equal(balik.status, 200);
  const b = (await q('SELECT tipe, parameter FROM perintah_aktuator WHERE id = $1', [balik.body.id_perintah]))[0];
  assert.deepEqual([b.tipe, b.parameter], ['BALIK_KALIBRASI', { sensor: 'ph' }]);
});

test('kalibrasi EC: faktor dua titik dikalikan ke faktor lama & diantre ke alat; balik mengirim BALIK_KALIBRASI', { skip: lewati }, async () => {
  await bersih();
  await q(`UPDATE kalibrasi_sensor SET konstanta = '{"TDS_FAKTOR_KOREKSI": 1}'::jsonb WHERE sensor = 'ec'`);
  const r1 = await request(srv.base).post('/iot-v41/kalibrasi-dua-titik').set(admin).send({ sensor: 'ec', baca1: 1000, baca2: 10000 });
  assert.equal(r1.status, 201);
  assert.ok(r1.body.id_perintah, 'harus mengantre perintah KALIBRASI EC ke alat');
  const p1 = (await q('SELECT tipe, parameter FROM perintah_aktuator WHERE id = $1', [r1.body.id_perintah]))[0];
  // (1413/1000 + 12880/10000)/2 = (1.413 + 1.288)/2 = 1.3505
  assert.deepEqual([p1.tipe, p1.parameter], ['KALIBRASI', { tds_faktor: 1.3505 }]);

  // Kalibrasi kedua ketika bacaan sekarang tepat di target harus mempertahankan faktor 1.3505 (tidak reset ke 1.0)
  const r2 = await request(srv.base).post('/iot-v41/kalibrasi-dua-titik').set(admin).send({ sensor: 'ec', baca1: 1413, baca2: 12880 });
  assert.equal(r2.status, 201);
  const p2 = (await q('SELECT tipe, parameter FROM perintah_aktuator WHERE id = $1', [r2.body.id_perintah]))[0];
  assert.deepEqual([p2.tipe, p2.parameter], ['KALIBRASI', { tds_faktor: 1.3505 }]);

  const balik = await request(srv.base).post('/iot-v41/kalibrasi-dua-titik').set(admin).send({ sensor: 'ec', aksi: 'balik' });
  assert.equal(balik.status, 200);
  const b = (await q('SELECT tipe, parameter FROM perintah_aktuator WHERE id = $1', [balik.body.id_perintah]))[0];
  assert.deepEqual([b.tipe, b.parameter], ['BALIK_KALIBRASI', { sensor: 'ec' }]);
});
