'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { kondisiSekarang } = require('../src/peringatan');
const { validasiPerintah } = require('../src/aktuator');

const dasar = { online: false, dataSegar: false, estopServer: false, alat: {}, sensor: null, ambang: {} };

test('kalibrasi terlambat jadi peringatan walau alat offline; yang aman/belum tidak', () => {
  const k = kondisiSekarang({ ...dasar, kalibrasi: [
    { sensor: 'ph', status: 'terlambat' }, { sensor: 'ec', status: 'aman' },
    { sensor: 'pulsa_peristaltik', status: 'belum' }, { sensor: 'suhu_air', status: 'terlambat' },
  ] });
  const kal = k.filter((x) => x.kunci.startsWith('kalibrasi_'));
  assert.deepEqual(kal.map((x) => x.kunci), ['kalibrasi_ph']);
  assert.match(kal[0].pesan, /pH terlambat/);
});

test('UJI_POMPA boleh pompa isi air; KAL_SENSOR tetap tervalidasi', () => {
  assert.equal(validasiPerintah('UJI_POMPA', { pompa: 'ISI', detik: 10 }, {}).pompa, 'ISI');
  assert.deepEqual(validasiPerintah('KAL_SENSOR', { sensor: 'ph', titik: 2, aksi: 'simpan' }, {}), { sensor: 'ph', titik: 2, aksi: 'SIMPAN' });
});
