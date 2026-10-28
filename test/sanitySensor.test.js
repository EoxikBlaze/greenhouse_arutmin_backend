'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bacaanMustahil, SANITY } = require('../src/sanitySensor');

/* Batas kewajaran sensor (Perancangan FINAL §4.1/§9) — dipindah dari otomasi.test.js saat logika dosing lama dihapus. */
test('sanity: probe EC lepas (TDS < 50) dan TDS > 2500 → mustahil; batas sendiri sah', () => {
  for (const tds of [0, 20, 49.9, 2501]) assert.match(bacaanMustahil({ ph: 6, tds, suhuAir: 25 }), /TDS/, `TDS ${tds}`);
  assert.equal(bacaanMustahil({ ph: 6, tds: 50, suhuAir: 25 }), null);
  assert.equal(bacaanMustahil({ ph: 6, tds: 2500, suhuAir: 25 }), null);
});

test('sanity: pH di luar 3–9, suhu air di luar 5–45 °C → mustahil; batas sendiri sah; null tidak diperiksa', () => {
  assert.match(bacaanMustahil({ ph: 2.5, tds: 800 }), /pH 2.5/);
  assert.match(bacaanMustahil({ ph: 9.5, tds: 800 }), /pH 9.5/);
  assert.equal(bacaanMustahil({ ph: 3, tds: 800 }), null);
  assert.equal(bacaanMustahil({ ph: 9, tds: 800 }), null);
  assert.match(bacaanMustahil({ ph: 6, tds: 400, suhuAir: 4.9 }), /suhu air/);
  assert.match(bacaanMustahil({ ph: 6, tds: 400, suhuAir: 46 }), /suhu air/);
  assert.equal(bacaanMustahil({ ph: 6, tds: 400, suhuAir: null }), null);
});

test('sanity: NaN / -5 / 14 tidak pernah dianggap wajar; sebab bisa dibaca', () => {
  assert.match(bacaanMustahil({ ph: Number.NaN, tds: 800, suhuAir: 25 }), /pH/);
  assert.match(bacaanMustahil({ ph: 6, tds: -5 }), /TDS -5/);
  assert.match(bacaanMustahil({ ph: 14, tds: 800 }), /pH 14/);
  assert.match(bacaanMustahil({ ph: 6, tds: 800, suhuAir: 60 }), /suhu air 60/);
  assert.deepEqual(SANITY.tds, [50, 2500], 'nilai tidak berubah diam-diam');
});
