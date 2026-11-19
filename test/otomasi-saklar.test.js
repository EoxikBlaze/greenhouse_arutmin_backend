'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validasiPerintah, TIPE_DIKIRIM, PerintahDitolak } = require('../src/aktuator');

test('OTOMASI: boleh dikirim ke alat dan hanya kunci yang disebut yang dibawa', () => {
  assert.ok(TIPE_DIKIRIM.includes('OTOMASI'));
  assert.deepEqual(validasiPerintah('OTOMASI', { nutrisi: 1, ph: false, encer: '0', isi: true }, {}), { nutrisi: 1, ph: 0, encer: 0, isi: 1 });
  assert.deepEqual(validasiPerintah('OTOMASI', { ph: 0 }, {}), { ph: 0 });
});

test('OTOMASI: kosong atau nilai aneh ditolak', () => {
  assert.throws(() => validasiPerintah('OTOMASI', {}, {}), PerintahDitolak);
  assert.throws(() => validasiPerintah('OTOMASI', { nutrisi: 'mungkin' }, {}), PerintahDitolak);
});
