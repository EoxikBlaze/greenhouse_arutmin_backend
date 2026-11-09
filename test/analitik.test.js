'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prediksiPanen, tren, saranSensor, keCsv, sel } = require('../src/analitik');

const DURASI = { semai: 10, peremajaan: 15, pendewasaan: 45 };

test('prediksiPanen: semai mulai 1 Jan → panen 70 hari kemudian', () => {
  const r = prediksiPanen({ tipe: 'semai', mulai: '2026-01-01' }, DURASI, new Date('2026-01-01T05:00:00Z'));
  assert.equal(r.tgl_prediksi, '2026-03-12');
  assert.equal(r.sisa_hari, 70);
  assert.equal(r.status, 'sesuai');
});

test('prediksiPanen: pendewasaan hanya menjumlah durasinya sendiri', () => {
  const r = prediksiPanen({ tipe: 'pendewasaan', mulai: '2026-02-01' }, DURASI, new Date('2026-03-10T00:00:00Z'));
  assert.equal(r.tgl_prediksi, '2026-03-18');
  assert.equal(r.sisa_hari, 8);
});

test('prediksiPanen: status segera ≤3 hari dan terlambat <0', () => {
  assert.equal(prediksiPanen({ tipe: 'pendewasaan', mulai: '2026-02-01' }, DURASI, new Date('2026-03-16T00:00:00Z')).status, 'segera');
  assert.equal(prediksiPanen({ tipe: 'pendewasaan', mulai: '2026-02-01' }, DURASI, new Date('2026-03-20T00:00:00Z')).status, 'terlambat');
});

test('prediksiPanen: durasi kosong/tahap tak dikenal → null (tidak dikarang)', () => {
  assert.equal(prediksiPanen({ tipe: 'semai', mulai: '2026-01-01' }, { semai: 10, peremajaan: null, pendewasaan: 45 }), null);
  assert.equal(prediksiPanen({ tipe: 'panen', mulai: '2026-01-01' }, DURASI), null);
  assert.equal(prediksiPanen({ tipe: 'semai', mulai: null }, DURASI), null);
});

test('tren: kemiringan per jam benar; titik <3 → null', () => {
  const jam = 3_600_000;
  assert.ok(Math.abs(tren([{ t: 0, v: 6 }, { t: jam, v: 6.1 }, { t: 2 * jam, v: 6.2 }]) - 0.1) < 1e-9);
  assert.equal(tren([{ t: 0, v: 6 }, { t: jam, v: 6.1 }]), null);
  assert.equal(tren([{ t: 5, v: 1 }, { t: 5, v: 2 }, { t: 5, v: 3 }]), null);
});

const AMBANG_PH = { min: 5, max: 7 };

test('saranSensor: di luar ambang', () => {
  assert.equal(saranSensor('ph', 4.5, 0, AMBANG_PH, 6).status, 'di_luar');
  assert.equal(saranSensor('ph', 7.4, 0, AMBANG_PH, 6).status, 'di_luar');
});

test('saranSensor: naik menuju batas dalam jendela → perhatian', () => {
  const r = saranSensor('ph', 6.7, 0.1, AMBANG_PH, 6);
  assert.equal(r.status, 'perhatian');
  assert.equal(r.perkiraan_jam_ke_batas, 3);
  assert.match(r.saran, /persetujuan dosing/);
});

test('saranSensor: stabil → aman; tanpa tren → aman tanpa klaim tren; ambang kosong → data_kurang', () => {
  assert.equal(saranSensor('ph', 6, 0.001, AMBANG_PH, 6).status, 'aman');
  assert.equal(saranSensor('ph', 6, null, AMBANG_PH, 6).status, 'aman');
  assert.equal(saranSensor('ph', 6, 0, { min: null, max: null }, 6).status, 'data_kurang');
  assert.equal(saranSensor('ph', NaN, 0, AMBANG_PH, 6).status, 'data_kurang');
});

test('saranSensor: tidak pernah memuat angka dosis (ml/gram)', () => {
  for (const r of [saranSensor('ph', 4.5, 0, AMBANG_PH, 6), saranSensor('tds', 2700, 0, { min: 50, max: 2600 }, 6)]) {
    assert.doesNotMatch(r.saran, /\b\d+\s?(ml|mL|gram|g|liter|l)\b/);
  }
});

test('CSV: kutip, koma, baris baru, dan injeksi rumus dinetralkan', () => {
  assert.equal(sel('a,b'), '"a,b"');
  assert.equal(sel('say "hi"'), '"say ""hi"""');
  assert.equal(sel('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(sel('-5'), '-5');
  assert.equal(sel(null), '');
  const csv = keCsv(['a', 'b'], [{ a: 1, b: '=1+1' }]);
  assert.ok(csv.startsWith('﻿a,b\n'));
  assert.ok(csv.endsWith("1,'=1+1"));
});
