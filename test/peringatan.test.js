'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { kondisiSekarang } = require('../src/peringatan');

const AMBANG = { ph: { min: 5, max: 7 }, tds: { min: 50, max: 2600 }, waterTemp: { min: 5, max: 40 }, humidity: { min: 0, max: 0 } };
const dasar = (ubah = {}) => ({
  online: true, dataSegar: true, estopServer: false, ambang: AMBANG,
  alat: { mode: 'SIAP', kunci: '', siap: true, ...ubah.alat },
  sensor: { ph: 6.2, tds: 1000, waterTemp: 25, humidity: 70, ...ubah.sensor },
  ...ubah.atas,
});
const kunci = (s) => kondisiSekarang(s).map((k) => k.kunci).sort();

test('normal: tidak ada peringatan', () => {
  assert.deepEqual(kunci(dasar()), []);
});

test('alat offline: hanya satu peringatan (keadaan lain basi)', () => {
  assert.deepEqual(kunci(dasar({ atas: { online: false }, alat: { kunci: 'SENSOR_RUSAK' } })), ['alat_offline']);
});

test('E-STOP dan kunci alat langsung merah tanpa tunda', () => {
  const k = kondisiSekarang(dasar({ alat: { estop: true, kunci: 'FLOAT_ERROR' } }));
  assert.deepEqual(k.map((x) => [x.kunci, x.severity, x.tunda]).sort(),
    [['estop', 'critical', 0], ['kunci_float_error', 'critical', 0]]);
});

test('pH di luar batas aman: kuning, merah bila jauh; ditunda 5 menit', () => {
  const [kuning] = kondisiSekarang(dasar({ sensor: { ph: 7.3 } }));
  assert.equal(kuning.kunci, 'sensor_ph');
  assert.equal(kuning.severity, 'warning');
  assert.equal(kuning.tunda, 300);
  assert.match(kuning.pesan, /pH 7,30 di atas batas aman 5,00–7,00/);
  assert.equal(kondisiSekarang(dasar({ sensor: { ph: 9.8 } }))[0].severity, 'critical');
});

test('probe tidak dipercaya (SENSOR_RUSAK): pH & ppm tidak dinilai, suhu tetap', () => {
  assert.deepEqual(kunci(dasar({ alat: { kunci: 'SENSOR_RUSAK' }, sensor: { ph: 9.8, waterTemp: 45 } })),
    ['kunci_sensor_rusak', 'sensor_waterTemp']);
});

test('sensor tidak dikirim alat (null) tidak dinilai; batas belum diatur dilewati', () => {
  assert.deepEqual(kunci(dasar({ sensor: { tds: null, humidity: 99 } })), []);
});

test('SEMAI memakai target alat: pH min/maks dan ppm ± toleransi (ditunda 1 jam)', () => {
  const k = kondisiSekarang(dasar({ alat: { mode: 'SEMAI', ph_min: 5.5, ph_max: 6.0, target_ppm: 1200 }, sensor: { ph: 6.2, tds: 1000 } }));
  const ph = k.find((x) => x.kunci === 'sensor_ph');
  const ppm = k.find((x) => x.kunci === 'sensor_tds');
  assert.match(ph.pesan, /target semai 5,50–6,00/);
  assert.equal(ppm.tunda, 3600);
  assert.match(ppm.pesan, /target 1200 ppm 1150–1300/);
});

test('pemeliharaan: angka sensor tidak dinilai', () => {
  assert.deepEqual(kunci(dasar({ alat: { pemeliharaan: true }, sensor: { ph: 9.8 } })), []);
});

test('data tidak masuk, belum siap, air rendah, batas harian', () => {
  assert.deepEqual(kunci(dasar({
    atas: { dataSegar: false },
    alat: { siap: false, kurang: 'volume', mode: 'SEMAI', level_air: 'RENDAH', dosing_ab_hari: 6, isi_hari: 2 },
  })), ['air_rendah', 'batas_dosing_ab_hari', 'belum_siap', 'data_tidak_masuk']);
});
