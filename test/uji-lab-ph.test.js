'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { phMlPer100L, LANGKAH_PH } = require('../src/konfigurasiAlat');

test('takaran pH ke firmware: mL per pH per L × 100 L × langkah pH, ambil yang lebih kecil', () => {
  assert.equal(LANGKAH_PH, 0.3);
  assert.equal(phMlPer100L(0.05, 0.1), 1.5);   // 0,05 × 100 × 0,3
  assert.equal(phMlPer100L(0.2, null), 6);
  assert.equal(phMlPer100L(null, undefined), null);
  assert.equal(phMlPer100L(0, -1), null);
});
