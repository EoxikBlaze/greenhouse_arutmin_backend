'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const tegangan = require('../src/teganganPh');

test('teganganPh: hanya angka sah yang dicatat; angka basi tidak dipakai', () => {
  assert.equal(tegangan.terbaru(15, 1_000), null);
  tegangan.catat(2.512, 1_000);
  assert.equal(tegangan.terbaru(15, 10_000), 2.512);
  assert.equal(tegangan.terbaru(15, 17_000), null, 'lebih dari 15 detik = basi');
  for (const buruk of ['2.5', NaN, 0, -1, 5, 9, null, undefined]) tegangan.catat(buruk, 20_000);
  assert.equal(tegangan.terbaru(15, 20_000), null, 'nilai tak sah tidak menimpa/menyegarkan');
  tegangan.catat(3.05, 20_000);
  assert.equal(tegangan.terbaru(15, 20_000), 3.05);
});
