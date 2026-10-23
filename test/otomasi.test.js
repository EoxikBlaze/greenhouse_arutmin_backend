'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { putuskan, bacaanMustahil } = require('../src/otomasi');

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

/* ── B1: sanity check sesuai Perancangan FINAL §4.1/§9 (pH 3–9, EC 50–2.500 ppm, suhu air 5–45 °C) ── */
test('otomasi B1: probe EC lepas (TDS ~0–49 ppm) → bacaan dibuang, TIDAK mendosis', () => {
  for (const tds of [0, 20, 49.9]) {
    const r = putuskan(sensor({ tds }), T, CFG, 3);
    assert.equal(r.aksi, null, `TDS ${tds} tidak boleh memicu dosis`);
    assert.match(r.sebab, /dibuang/);
  }
  // tepat di batas bawah masih sah → dosis AB normal
  assert.equal(putuskan(sensor({ tds: 50 }), T, CFG, 3).aksi.parameter.larutan, 'AB');
  assert.equal(putuskan(sensor({ tds: 2501 }), T, CFG, 3).aksi, null);
});

test('otomasi B1: pH di luar 3–9 dan suhu air di luar 5–45 °C → dibuang', () => {
  assert.equal(putuskan(sensor({ ph: 2.5 }), T, CFG, 3).aksi, null);  // dulu → PH_UP
  assert.equal(putuskan(sensor({ ph: 9.5 }), T, CFG, 3).aksi, null);  // dulu → PH_DOWN
  assert.equal(putuskan(sensor({ ph: 3 }), T, CFG, 3).aksi.parameter.larutan, 'PH_UP');   // batas = sah
  assert.equal(putuskan(sensor({ ph: 9 }), T, CFG, 3).aksi.parameter.larutan, 'PH_DOWN');
  assert.equal(putuskan(sensor({ tds: 400, waterTemp: 4.9 }), T, CFG, 3).aksi, null);
  assert.equal(putuskan(sensor({ tds: 400, waterTemp: 46 }), T, CFG, 3).aksi, null);
  assert.equal(putuskan(sensor({ tds: 400, waterTemp: 26 }), T, CFG, 3).aksi.parameter.larutan, 'AB');
  assert.equal(putuskan(sensor({ tds: 400, waterTemp: null }), T, CFG, 3).aksi.parameter.larutan, 'AB'); // tak dikirim = tak diperiksa
});

test('otomasi B1: bacaanMustahil memberi sebab yang bisa dibaca', () => {
  assert.equal(bacaanMustahil({ ph: 6, tds: 800, suhuAir: 25 }), null);
  assert.match(bacaanMustahil({ ph: 6, tds: 20, suhuAir: 25 }), /TDS 20 ppm/);
  assert.match(bacaanMustahil({ ph: 12, tds: 800, suhuAir: 25 }), /pH 12/);
  assert.match(bacaanMustahil({ ph: 6, tds: 800, suhuAir: 60 }), /suhu air 60/);
  assert.match(bacaanMustahil({ ph: Number.NaN, tds: 800, suhuAir: 25 }), /pH/);
});
