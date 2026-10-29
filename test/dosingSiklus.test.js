'use strict';
/** Fase 3C — bagian murni alur persetujuan dosing: jalur status, evaluasi percobaan, bentuk cakupan. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JALUR, AKTIF, evaluasiPercobaan, validasiCakupan } = require('../src/dosingSiklus');

test('jalur: RUNNING hanya dari APPROVED oleh sistem; status akhir buntu; FAULT tidak bisa dipicu user', () => {
  for (const [dari, ke] of Object.entries(JALUR)) {
    if (ke.RUNNING) assert.deepEqual([dari, ke.RUNNING], ['APPROVED', ['system']]);
    if (ke.FAULT) assert.deepEqual(ke.FAULT, ['system'], `${dari} → FAULT`);
    if (!AKTIF.includes(dari)) assert.deepEqual(ke, {}, `${dari} harus status akhir`);
  }
  assert.deepEqual(JALUR.WAITING_APPROVAL.APPROVED, ['user'], 'persetujuan hanya oleh manusia');
});

const dasar = { sebelum: 800, delta: 200, pita: { min: 1000, max: 1100 }, minProgresPersen: 50, maksLampauPersen: 10 };

test('evaluasi: OK / KURANG / GAGAL / KELEBIHAN', () => {
  assert.equal(evaluasiPercobaan({ ...dasar, sesudah: 1050 }).evaluasi, 'OK');
  assert.equal(evaluasiPercobaan({ ...dasar, sesudah: 950 }).evaluasi, 'KURANG'); // progres 75%
  assert.equal(evaluasiPercobaan({ ...dasar, sesudah: 850 }).evaluasi, 'GAGAL'); // progres 25%
  assert.equal(evaluasiPercobaan({ ...dasar, sesudah: 700 }).evaluasi, 'GAGAL', 'arah salah = gagal');
  assert.equal(evaluasiPercobaan({ ...dasar, sesudah: 1150 }).evaluasi, 'OK', 'lampau 4.5% ≤ 10%: berhenti, tidak menambah');
  assert.equal(evaluasiPercobaan({ ...dasar, sesudah: 1300 }).evaluasi, 'KELEBIHAN');
  assert.equal(evaluasiPercobaan({ ...dasar, sesudah: 950 }).progres, 0.75);
});

test('evaluasi: arah turun (pH DOWN) memakai batas bawah', () => {
  const ph = { sebelum: 7.0, delta: -0.5, pita: { min: 5.8, max: 6.5 }, minProgresPersen: 50, maksLampauPersen: 5 };
  assert.equal(evaluasiPercobaan({ ...ph, sesudah: 6.2 }).evaluasi, 'OK');
  assert.equal(evaluasiPercobaan({ ...ph, sesudah: 6.7 }).evaluasi, 'KURANG');
  assert.equal(evaluasiPercobaan({ ...ph, sesudah: 6.95 }).evaluasi, 'GAGAL');
  assert.equal(evaluasiPercobaan({ ...ph, sesudah: 5.0 }).evaluasi, 'KELEBIHAN');
});

test('evaluasi: masukan kosong (parameter belum diputuskan) / delta 0 → galat, bukan tebakan', () => {
  assert.throws(() => evaluasiPercobaan({ ...dasar, sesudah: 900, minProgresPersen: null }));
  assert.throws(() => evaluasiPercobaan({ ...dasar, sesudah: 900, delta: 0 }));
  assert.throws(() => evaluasiPercobaan({ ...dasar, sesudah: undefined }));
});

test('cakupan: bentuk divalidasi', () => {
  const sah = { pompa_diizinkan: ['AB'], maks_ml_per_percobaan: 20, maks_ml_total: 60, maks_percobaan: 3, berlaku_menit: 30 };
  assert.deepEqual(validasiCakupan(sah).errors, {});
  const e = (x) => Object.keys(validasiCakupan({ ...sah, ...x }).errors);
  assert.deepEqual(e({ pompa_diizinkan: [] }), ['pompa_diizinkan']);
  assert.deepEqual(e({ pompa_diizinkan: ['AB', 'AB'] }), ['pompa_diizinkan']);
  assert.deepEqual(e({ pompa_diizinkan: ['A'] }), ['pompa_diizinkan']);
  assert.deepEqual(e({ maks_ml_total: 10 }), ['maks_ml_total']);
  assert.deepEqual(e({ maks_ml_per_percobaan: '20' }), ['maks_ml_per_percobaan']);
  assert.deepEqual(e({ maks_percobaan: 1.5 }), ['maks_percobaan']);
  assert.deepEqual(e({ berlaku_menit: 0 }), ['berlaku_menit']);
  assert.ok(Object.keys(validasiCakupan(null).errors).length >= 4);
});
