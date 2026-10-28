'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluasiKestabilan } = require('../src/kestabilan');

const NOW = Date.parse('2026-10-29T12:00:00Z');
const t = (detikLalu) => new Date(NOW - detikLalu * 1000).toISOString();
const PITA = { ec_min: 400, ec_max: 600, ph_min: 5.8, ph_max: 6.5 };
const O = { sekarangMs: NOW, jendelaDetik: 600, basiDetik: 120, pita: PITA };
const baris = (mulai, akhir, o = {}) => ({ created_at: t(mulai), updated_at: t(akhir), ph: '6.0', tds: '500', waterTemp: '26', n_konfirmasi: 100, celah_maks_detik: 10, ...o });

test('kestabilan: bacaan identik terdeduplikasi (1 baris panjang) tetap bukti stabil', () => {
  const r = evaluasiKestabilan([baris(1800, 5)], { ...O, minKonfirmasi: 50 });
  assert.equal(r.stabil, true, r.alasan);
  // celah maks 10 dtk, 595 dtk teramati di jendela → minimal 59 penerimaan (bukan sekadar 1 baris)
  assert.equal(r.konfirmasi, 59);
  assert.equal(evaluasiKestabilan([baris(1800, 5, { n_konfirmasi: 1, celah_maks_detik: 0 })], { ...O, minKonfirmasi: 2 }).stabil, false,
    'satu penerimaan saja tidak membuktikan pengamatan berkelanjutan');
});

test('kestabilan: bacaan valid yang terus berganti dan berdempetan → stabil; n_konfirmasi dijumlah', () => {
  const r = evaluasiKestabilan([baris(900, 600, { n_konfirmasi: 40 }), baris(595, 300, { tds: '510' }), baris(295, 3, { tds: '505', n_konfirmasi: 7 })], { ...O, minKonfirmasi: 100 });
  assert.equal(r.stabil, true, r.alasan);
  assert.equal(r.konfirmasi, 1 + 100 + 7, 'baris yang mulai sebelum jendela dihitung 1 (konservatif)');
  assert.deepEqual(r.rentang.tds, [500, 510]);
});

test('kestabilan: sensor basi / terputus', () => {
  assert.match(evaluasiKestabilan([baris(1800, 300)], O).alasan, /basi/);
  // celah antar baris (sensor putus lalu kembali dengan bacaan berbeda)
  assert.match(evaluasiKestabilan([baris(1800, 500), baris(200, 5)], O).alasan, /celah data .* antar bacaan/);
  // pemadaman yang diapit dua bacaan IDENTIK: tersimpan sebagai satu baris, terdeteksi dari celah_maks_detik
  assert.match(evaluasiKestabilan([baris(1800, 5, { celah_maks_detik: 900 })], O).alasan, /celah data 900 dtk di dalam/);
});

test('kestabilan: sensor tidak valid / tidak lengkap / di luar pita', () => {
  assert.match(evaluasiKestabilan([baris(1800, 5, { ph: '99' })], O).alasan, /tidak valid/);
  assert.match(evaluasiKestabilan([baris(1800, 5, { tds: null })], O).alasan, /tidak lengkap/);
  assert.match(evaluasiKestabilan([baris(1800, 5, { tds: '650' })], O).alasan, /di luar pita/);
});

test('kestabilan: durasi belum terpenuhi / belum ada bacaan', () => {
  assert.match(evaluasiKestabilan([baris(300, 5)], O).alasan, /durasi pengamatan belum terpenuhi \(kurang 300 dtk\)/);
  assert.equal(evaluasiKestabilan([], O).alasan, 'belum ada bacaan');
});

test('kestabilan: baris lama tanpa data konfirmasi tidak dihitung sebagai bukti', () => {
  assert.match(evaluasiKestabilan([baris(1800, 5, { n_konfirmasi: null, celah_maks_detik: null })], O).alasan, /tanpa data konfirmasi/);
});

test('kestabilan: toleransi fluktuasi & minimal penerimaan', () => {
  const dua = [baris(900, 300, { ph: '5.9' }), baris(295, 3, { ph: '6.4' })];
  assert.equal(evaluasiKestabilan(dua, { ...O, toleransi: { ph: 1, tds: 100 } }).stabil, true);
  assert.match(evaluasiKestabilan(dua, { ...O, toleransi: { ph: 0.3, tds: 100 } }).alasan, /fluktuasi pH/);
  assert.match(evaluasiKestabilan([baris(900, 3, { n_konfirmasi: 2 })], { ...O, minKonfirmasi: 5 }).alasan, /baru 2 penerimaan/);
});

test('kestabilan: parameter wajib kosong → galat, bukan nilai bawaan', () => {
  assert.throws(() => evaluasiKestabilan([], { ...O, jendelaDetik: null }), /jendelaDetik/);
  assert.throws(() => evaluasiKestabilan([], { ...O, basiDetik: 0 }), /basiDetik/);
  assert.throws(() => evaluasiKestabilan([], { ...O, pita: { ec_min: 400 } }), /pita/);
});
