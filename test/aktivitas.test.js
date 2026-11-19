'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rentang, JENIS } = require('../src/aktivitas');
const { sel } = require('../src/routes/aktivitas');

test('rentang: bawaan 30 hari sampai akhir hari ini (UTC); sampai eksklusif hari berikutnya', () => {
  const r = rentang({}, new Date('2026-11-19T10:00:00Z'));
  assert.equal(r.akhir, '2026-11-20T00:00:00.000Z');
  assert.equal(r.awal, '2026-10-21T00:00:00.000Z');
  const s = rentang({ dari: '2026-11-01', sampai: '2026-11-05' });
  assert.deepEqual([s.awal, s.akhir], ['2026-11-01T00:00:00.000Z', '2026-11-06T00:00:00.000Z']);
});

test('semua jenis sumber terdaftar', () => {
  assert.deepEqual(JENIS, ['data', 'pengaturan', 'login', 'perintah', 'peringatan', 'dosing', 'kalibrasi']);
});

test('CSV: sel dikutip dan rumus Excel dinetralkan', () => {
  assert.equal(sel('a"b'), '"a""b"');
  assert.equal(sel('=1+1'), `"'=1+1"`);
  assert.equal(sel('-5'), `"'-5"`);
  assert.equal(sel(null), '""');
  assert.equal(sel({ a: 1 }), '"{""a"":1}"');
});

test('laporan lengkap: rentang dibatasi 92 hari dan bawaan 30 hari', () => {
  const { rentangLaporan, MAKS_HARI, LAPORAN } = require('../src/laporanLengkap');
  assert.equal(MAKS_HARI, 92);
  const a = rentangLaporan({}, new Date('2026-11-19T10:00:00Z'));
  assert.deepEqual([a.awal.slice(0, 10), a.akhir.slice(0, 10), a.terpotong], ['2026-10-21', '2026-11-20', false]);
  const b = rentangLaporan({ dari: '2025-01-01', sampai: '2026-11-19' });
  assert.equal(b.terpotong, true);
  assert.equal((Date.parse(b.akhir) - Date.parse(b.awal)) / 86_400_000, 92);
  assert.deepEqual(Object.keys(LAPORAN), ['batch', 'sensor', 'dosing', 'peringatan', 'kalibrasi']);
});
