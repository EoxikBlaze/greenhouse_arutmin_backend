'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { statusSiklus, alasanLot, jumlahCocok } = require('../scripts/migrasi-siklus');

const lot = (tahap, status) => ({ tahap, status });

test('migrasi: status siklus dari semai + lot (DESAIN_FASE2 D.2)', () => {
  assert.deepEqual(statusSiklus('proses', []), { status: 'SEEDING', hasil: null });
  assert.deepEqual(statusSiklus('selesai', [lot('PEREMAJAAN', 'PROSES')]), { status: 'GROWTH', hasil: null });
  // satu cabang masih PROSES → GROWTH walau cabang lain sudah panen
  assert.deepEqual(statusSiklus('selesai', [lot('PEREMAJAAN', 'SELESAI'), lot('PANEN', 'SELESAI'), lot('PENDEWASAAN', 'PROSES')]),
    { status: 'GROWTH', hasil: null });
  assert.deepEqual(statusSiklus('selesai', [lot('PEREMAJAAN', 'SELESAI'), lot('PENDEWASAAN', 'SELESAI'), lot('PANEN', 'SELESAI')]),
    { status: 'COMPLETED', hasil: 'PANEN' });
  assert.deepEqual(statusSiklus('gagal', []), { status: 'COMPLETED', hasil: 'GAGAL_SEMAI' });
  // selesai tanpa lanjutan: tidak ditebak gagal/panen
  assert.deepEqual(statusSiklus('selesai', []), { status: 'COMPLETED', hasil: null });
});

test('migrasi: alasan tinjau — data selisih ditandai, tidak diperbaiki', () => {
  const k = ['jumlah_masuk', 'b', 'g'];
  assert.deepEqual(alasanLot({ status: 'selesai', jumlah_masuk: 10, b: 7, g: 3 }, ...k), []);
  assert.deepEqual(alasanLot({ status: 'proses', jumlah_masuk: 10, b: 0, g: 0 }, ...k), []);
  assert.deepEqual(alasanLot({ status: 'selesai', jumlah_masuk: null, b: 4, g: 1 }, ...k),
    ['jumlah_masuk kosong', 'berhasil+gagal ≠ jumlah_masuk']);
  assert.deepEqual(alasanLot({ status: 'selesai', jumlah_masuk: 470, b: 0, g: 0 }, ...k), ['berhasil+gagal ≠ jumlah_masuk']);
  assert.deepEqual(alasanLot({ status: 'proses', jumlah_masuk: 3, b: 3, g: 3 }, ...k), ['berhasil+gagal > jumlah_masuk saat proses']);
  assert.equal(jumlahCocok(null, 0, 0), false);
  assert.equal(jumlahCocok('60', '0', '0'), false);
  assert.equal(jumlahCocok('60', '50', '10'), true);
});
