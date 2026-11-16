'use strict';
/** Unit: perintah JADWAL (NVS ESP32), umur bacaan antrean, dan status keselamatan alat (pelampung/E-STOP/RESET). */
const test = require('node:test');
const assert = require('node:assert/strict');
const { validasiPerintah, TIPE_DIKIRIM, JADWAL_RENTANG } = require('../src/aktuator');
const { umurBacaanDetik } = require('../src/routes/monitoring');
const { bersihkanStatus } = require('../src/routes/device');

test('JADWAL: dikirim ke alat, rentang = batas keras firmware, bukan dosing', () => {
  assert.ok(TIPE_DIKIRIM.includes('JADWAL'));
  assert.ok(!TIPE_DIKIRIM.includes('DOSIS'));
  assert.deepEqual(validasiPerintah('JADWAL', { jeda_ab_detik: 300, isi_air_maks_detik: 600 }, {}),
    { jeda_ab_detik: 300, isi_air_maks_detik: 600 });
  assert.deepEqual(JADWAL_RENTANG.isi_air_maks_detik, [60, 600]);
});

test('JADWAL: menolak di luar rentang, pecahan, dan isi kosong', () => {
  assert.throws(() => validasiPerintah('JADWAL', { isi_air_maks_detik: 900 }, {}), /Data tidak valid/);
  assert.throws(() => validasiPerintah('JADWAL', { jeda_ab_detik: 90.5 }, {}), /Data tidak valid/);
  assert.throws(() => validasiPerintah('JADWAL', { interval_sensor_detik: 1 }, {}), /Data tidak valid/);
  assert.throws(() => validasiPerintah('JADWAL', {}, {}), /Data tidak valid/);
  // kunci asing tidak ikut dikirim
  assert.deepEqual(validasiPerintah('JADWAL', { jeda_ab_detik: 60, pompa: 'A' }, {}), { jeda_ab_detik: 60 });
});

test('umur_detik bacaan antrean: 0 bila tidak dikirim, undefined bila tidak sah', () => {
  assert.equal(umurBacaanDetik(undefined), 0);
  assert.equal(umurBacaanDetik(null), 0);
  assert.equal(umurBacaanDetik(125), 125);
  assert.equal(umurBacaanDetik('30'), 30);
  assert.equal(umurBacaanDetik(-1), undefined);
  assert.equal(umurBacaanDetik(1.5), undefined);
  assert.equal(umurBacaanDetik(86_401), undefined);
  assert.equal(umurBacaanDetik('abc'), undefined);
});

test('status alat: pelampung & E-STOP fisik hanya boolean, selain itu null (bukan dianggap aman)', () => {
  const s = bersihkanStatus({ float_bawah_rendah: true, float_atas_penuh: false, estop_fisik: true, peristiwa: 'reset' });
  assert.equal(s.floatBawahRendah, true);
  assert.equal(s.floatAtasPenuh, false);
  assert.equal(s.estopFisik, true);
  assert.equal(s.reset, true);
  const kosong = bersihkanStatus({ float_bawah_rendah: 'ya', estop_fisik: 1, peristiwa: 'lain' });
  assert.equal(kosong.floatBawahRendah, null);
  assert.equal(kosong.floatAtasPenuh, null);
  assert.equal(kosong.estopFisik, null);
  assert.equal(kosong.reset, false);
});
