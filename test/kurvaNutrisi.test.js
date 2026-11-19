'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { naikHarian, targetBatch } = require('../src/presetDosing');
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
  assert.deepEqual(r.kolom, { kurva_ppm_awal: 400, kurva_ppm_target: 1500, kurva_hari_capai: 30, kurva_mulai_hari: 10, kurva_mulai_ppm: 667, kurva_ph_min: null, kurva_ph_max: null });
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
  assert.deepEqual(r.kolom, { kurva_ppm_awal: 350, kurva_ppm_target: 1000, kurva_hari_capai: 25, kurva_mulai_hari: 0, kurva_mulai_ppm: 350, kurva_ph_min: null, kurva_ph_max: null });
});

test('mulai semai: salin kurva tanaman, isian dialog menimpa', () => {
  const tanaman = { ppm_awal: 400, ppm_target: 1200, hari_capai: 30 };
  assert.equal(kurvaAwal(tanaman, {}).kolom.kurva_ppm_target, 1200);
  assert.equal(kurvaAwal(tanaman, { ppm_target: '1400' }).kolom.kurva_ppm_target, 1400);
  assert.equal(kurvaAwal({ ppm_awal: null, ppm_target: null, hari_capai: null }, {}).kolom, null);
  assert.ok(kurvaAwal(null, { ppm_awal: 900, ppm_target: 500, hari_capai: 10 }).errors.ppm_target);
});

test('per tahap: ppm tetap per tahap; per hari: saat Semai = ppm awal', () => {
  const tahap = { kurva_cara: 'tahap', kurva_ppm_semai: 300, kurva_ppm_peremajaan: 700, kurva_ppm_pendewasaan: 1100, kurva_ph_min: '5.5', kurva_ph_max: '6.5' };
  assert.deepEqual(targetBatch({ tahap: 'Semai', ...tahap }), { ppm: 300, ph_min: 5.5, ph_max: 6.5, cara: 'tahap' });
  assert.equal(targetBatch({ tahap: 'Pendewasaan', hari_netpot: 20, ...tahap }).ppm, 1100);
  assert.equal(targetBatch({ tahap: 'Semai', kurva_cara: 'harian', ...KURVA }).ppm, 400);
  assert.equal(targetBatch({ tahap: 'Peremajaan', hari_netpot: 10, kurva_cara: 'harian', ...KURVA }).ppm, 667);
  assert.equal(targetBatch({ tahap: 'Semai' }), null); // batch tanpa resep → preset tahap
});

test('mulai semai per tahap & pH: wajib tiga ppm tahap; pH selisih ≥ 0,2', () => {
  const t = { cara_naik: 'tahap', ppm_semai: 300, ppm_peremajaan: 700, ppm_pendewasaan: 1100, ph_min: 5.5, ph_max: 6.5 };
  assert.equal(kurvaAwal(t, {}).kolom.kurva_ppm_peremajaan, 700);
  assert.ok(kurvaAwal({ ...t, ppm_pendewasaan: null }, {}).errors.kurva);
  assert.ok(kurvaAwal(t, { ph_min: '6,4', ph_max: '6,5' }).errors.ph_max);
  assert.equal(kurvaAwal(t, { ph_min: '5,8' }).kolom.kurva_ph_min, 5.8);
});

test('ubah batch per tahap: ganti angka tahap tanpa syarat netpot', () => {
  const b = { tahap: 'Peremajaan', hari_netpot: 5, kurva_cara: 'tahap', kurva_ppm_semai: 300, kurva_ppm_peremajaan: 700, kurva_ppm_pendewasaan: 1100 };
  assert.equal(rencanaUbah(b, { ppm_peremajaan: 750 }).kolom.kurva_ppm_peremajaan, 750);
});
