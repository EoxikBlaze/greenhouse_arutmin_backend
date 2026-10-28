'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tafsir, statusBaris, ATURAN } = require('../src/parameter');

const persen = ATURAN.konfigurasi_dosis.min_progres_persen;
const bulat = ATURAN.timing_operasi.stabil_n_bacaan;

test('parameter: NULL/kosong/NaN tidak pernah menjadi 0', () => {
  assert.deepEqual(tafsir(null), { status: 'NULL', nilai: null, alasan: 'nilai belum diisi' });
  assert.equal(tafsir(undefined).status, 'NULL');
  assert.equal(tafsir('').status, 'TIDAK_VALID');
  assert.equal(tafsir('   ').status, 'TIDAK_VALID');
  assert.equal(tafsir('abc').status, 'TIDAK_VALID');
  assert.equal(tafsir('NaN').status, 'TIDAK_VALID');
  assert.equal(tafsir(NaN).status, 'TIDAK_VALID');
  assert.equal(tafsir('Infinity').status, 'TIDAK_VALID');
  assert.equal(tafsir({}).status, 'TIDAK_VALID');
  for (const x of [null, '', 'abc', NaN]) assert.equal(tafsir(x).nilai, null);
});

test('parameter: negatif, di luar rentang, pecahan untuk param bulat → TIDAK_VALID', () => {
  assert.equal(tafsir('-1').status, 'TIDAK_VALID');
  assert.equal(tafsir('0', persen).status, 'TIDAK_VALID', 'persen > 0 (min eksklusif)');
  assert.equal(tafsir('100.5', persen).status, 'TIDAK_VALID');
  assert.equal(tafsir('2.5', bulat).status, 'TIDAK_VALID');
  assert.equal(tafsir('1', bulat).status, 'TIDAK_VALID', 'stabil_n_bacaan ≥ 2');
  assert.equal(tafsir('5', ATURAN.konfigurasi_dosis.maks_gagal_berturut).status, 'TIDAK_VALID', 'maks 4 (CHECK persetujuan)');
});

test('parameter: nilai sah (string pg numeric maupun number)', () => {
  assert.deepEqual(tafsir('4.0000', ATURAN.konfigurasi_dosis.maks_gagal_berturut), { status: 'SAH', nilai: 4, alasan: null });
  assert.equal(tafsir(0).nilai, 0, 'nol eksplisit tetap sah untuk aturan umum ≥ 0');
  assert.equal(tafsir('12.5', persen).nilai, 12.5);
});

test('parameter: status baris membedakan TIDAK_ADA / NULL / BELUM_TERVALIDASI / SIAP', () => {
  assert.equal(statusBaris('timing_operasi', 'x', undefined).status, 'TIDAK_ADA');
  assert.equal(statusBaris('timing_operasi', 'ulang_konfirmasi_jam', { nilai: null, tervalidasi: false }).status, 'NULL');
  const belum = statusBaris('timing_operasi', 'ulang_konfirmasi_jam', { nilai: '12', tervalidasi: false, sumber: 'x' });
  assert.equal(belum.status, 'BELUM_TERVALIDASI');
  assert.equal(belum.nilai, 12, 'nilai tetap terlihat, tetapi tidak SIAP');
  assert.equal(statusBaris('timing_operasi', 'ulang_konfirmasi_jam', { nilai: '12', tervalidasi: true }).status, 'SIAP');
  // tervalidasi tidak menyelamatkan nilai yang tidak sah
  assert.equal(statusBaris('timing_operasi', 'ulang_konfirmasi_jam', { nilai: '-3', tervalidasi: true }).status, 'TIDAK_VALID');
  assert.equal(statusBaris('timing_operasi', 'ulang_konfirmasi_jam', { nilai: null, tervalidasi: true }).status, 'NULL');
});
