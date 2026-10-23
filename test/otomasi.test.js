'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { putuskan } = require('../src/otomasi');

const CFG = { deadband_ec_ppm: 100, deadband_ph: 0.2, persen_ronde_dosis: 65, maks_ppm_per_suntikan: 300, maks_ml_per_suntikan: 214, ml_ph_per_langkah: 5 };
const T = { target_ec_ppm: 800, target_ph: 6.0 };
const sensor = (o) => ({ ph: 6.0, tds: 800, umurDetik: 5, ...o });

test('otomasi: dalam pita target → tidak berbuat apa-apa', () => {
  assert.equal(putuskan(sensor({}), T, CFG, 3).aksi, null);
  assert.equal(putuskan(sensor({ tds: 720 }), T, CFG, 3).aksi, null); // di dalam deadband 100
});

test('otomasi: TDS rendah → AB 65% kekurangan, dibatasi 300 ppm/214 mL', () => {
  const a = putuskan(sensor({ tds: 500 }), T, CFG, 3).aksi; // kekurangan 300 → 195 ppm → ×0.7133 = 139.1 mL
  assert.equal(a.tipe, 'DOSIS'); assert.equal(a.parameter.larutan, 'AB'); assert.equal(a.parameter.ml, 139.1);
  const b = putuskan(sensor({ tds: 100 }), { ...T, target_ec_ppm: 1200 }, CFG, 3).aksi; // 1100 → min(715,300) → 214 mL
  assert.equal(b.parameter.ml, 214);
});

test('otomasi: pH tinggi/rendah → satu langkah kecil; EC didahulukan', () => {
  assert.equal(putuskan(sensor({ ph: 6.5 }), T, CFG, 3).aksi.parameter.larutan, 'PH_DOWN');
  assert.equal(putuskan(sensor({ ph: 5.5 }), T, CFG, 3).aksi.parameter.larutan, 'PH_UP');
  assert.equal(putuskan(sensor({ ph: 6.5 }), T, CFG, 3).aksi.parameter.ml, 5);
  assert.equal(putuskan(sensor({ ph: 6.5, tds: 400 }), T, CFG, 3).aksi.parameter.larutan, 'AB');
});

test('otomasi: TDS di atas target / target kosong / sensor basi / bacaan aneh → diam', () => {
  assert.equal(putuskan(sensor({ tds: 1500 }), T, CFG, 3).aksi, null);
  assert.equal(putuskan(sensor({ tds: 100, ph: 9 }), { target_ec_ppm: null, target_ph: null }, CFG, 3).aksi, null);
  assert.equal(putuskan(sensor({ tds: 100, umurDetik: 600 }), T, CFG, 3).aksi, null);
  assert.equal(putuskan(null, T, CFG, 3).aksi, null);
  assert.equal(putuskan(sensor({ ph: 14 }), T, CFG, 3).aksi, null);
  assert.equal(putuskan(sensor({ tds: -5 }), T, CFG, 3).aksi, null);
  assert.equal(putuskan(sensor({ tds: Number.NaN }), T, CFG, 3).aksi, null);
});
