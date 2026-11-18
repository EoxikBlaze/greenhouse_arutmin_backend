'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { naikHarian } = require('../src/presetDosing');
const { rencanaUbah, kurvaAwal } = require('../src/kurvaNutrisi');

// kurva contoh: 400 → 1200 ppm dalam 30 hari sejak pindah netpot
const KURVA = { kurva_ppm_awal: 400, kurva_ppm_target: 1200, kurva_hari_capai: 30, kurva_mulai_hari: 0, kurva_mulai_ppm: 400 };
const batch = (hari, kurva = KURVA) => ({ tahap: 'Peremajaan', hari_netpot: hari, ...kurva });

test('rumus tanpa perubahan sama dengan rumus lama', () => {
  assert.equal(naikHarian(batch(0)).target_hari_ini, 400);
  assert.equal(naikHarian(batch(10)).target_hari_ini, 667);
  assert.equal(naikHarian(batch(30)).target_hari_ini, 1200);
  assert.equal(naikHarian(batch(45)).target_hari_ini, 1200);
  // batch lama tanpa salinan kurva memakai kurva tanaman
  assert.equal(naikHarian({ tahap: 'Pendewasaan', hari_netpot: 15, ppm_awal: 400, ppm_target: 1200, hari_capai: 30 }).target_hari_ini, 800);
  assert.equal(naikHarian({ tahap: 'Semai', hari_netpot: null, ...KURVA }), null);
});

test('ubah target di hari ke-10: hari ini tetap 667, lalu naik rata ke target baru (tanpa lompatan)', () => {
  const r = rencanaUbah(batch(10), { ppm_target: 1500 });
  assert.equal(r.errors, undefined);
  assert.equal(r.target_hari_ini, 667);
  assert.deepEqual(r.kolom, { kurva_ppm_awal: 400, kurva_ppm_target: 1500, kurva_hari_capai: 30, kurva_mulai_hari: 10, kurva_mulai_ppm: 667 });
  const sesudah = (h) => naikHarian(batch(h, r.kolom)).target_hari_ini;
  assert.equal(sesudah(10), 667);
  assert.equal(sesudah(20), 1084); // 667 + (1500−667) × 10/20
  assert.equal(sesudah(30), 1500);
  // hari sebelum perubahan tidak berubah dari sudut pandang hitungan hari: hari ke-10 tetap 667
});

test('target diturunkan: diizinkan dengan peringatan pengenceran', () => {
  const r = rencanaUbah(batch(10), { ppm_target: 600, hari_capai: 15 });
  assert.match(r.peringatan, /mengencerkan/);
  assert.equal(naikHarian(batch(15, r.kolom)).target_hari_ini, 600);
});

test('pagar: hari capai harus di depan hari sekarang; kenaikan maks 150 ppm/hari', () => {
  assert.ok(rencanaUbah(batch(10), { hari_capai: 10 }).errors.hari_capai);
  assert.ok(rencanaUbah(batch(10), { ppm_target: 2500, hari_capai: 12 }).errors.ppm_target);
  assert.ok(rencanaUbah(batch(10), { ppm_target: 'abc' }).errors.ppm_target);
});

test('sebelum pindah netpot: kurva diganti seluruhnya', () => {
  const r = rencanaUbah({ tahap: 'Semai', hari_netpot: null, ...KURVA }, { ppm_awal: 350, ppm_target: 1000, hari_capai: 25 });
  assert.deepEqual(r.kolom, { kurva_ppm_awal: 350, kurva_ppm_target: 1000, kurva_hari_capai: 25, kurva_mulai_hari: 0, kurva_mulai_ppm: 350 });
});

test('mulai semai: salin kurva tanaman, isian dialog menimpa', () => {
  const tanaman = { ppm_awal: 400, ppm_target: 1200, hari_capai: 30 };
  assert.equal(kurvaAwal(tanaman, {}).kolom.kurva_ppm_target, 1200);
  assert.equal(kurvaAwal(tanaman, { ppm_target: '1400' }).kolom.kurva_ppm_target, 1400);
  assert.equal(kurvaAwal({ ppm_awal: null, ppm_target: null, hari_capai: null }, {}).kolom, null);
  assert.ok(kurvaAwal(null, { ppm_awal: 900, ppm_target: 500, hari_capai: 10 }).errors.ppm_target);
});
