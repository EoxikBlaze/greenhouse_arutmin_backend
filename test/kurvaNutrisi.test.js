'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { naikHarian, naikDariSemai, targetBatch } = require('../src/presetDosing');
const { rencanaUbah, kurvaAwal } = require('../src/kurvaNutrisi');

// resep contoh: 400 → 1200 ppm dalam 30 hari
const KURVA = { kurva_cara: 'harian', kurva_ppm_awal: 400, kurva_ppm_target: 1200, kurva_hari_capai: 30, kurva_mulai_hari: 0, kurva_mulai_ppm: 400 };
// batch per hari: h = hari sejak Mulai Semai (hari pertama = 0), tahap bebas
const batch = (h, kurva = KURVA, tahap = 'Peremajaan') => ({ tahap, hari_semai: h, hari_netpot: Math.max(0, h - 10), ...kurva });

test('per hari dihitung sejak Mulai Semai: hari pertama = ppm awal, hari kedua langsung naik', () => {
  const lima = { ...KURVA, kurva_hari_capai: 16 }; // (1200 − 400) ÷ 16 = 50 ppm per hari
  assert.equal(naikDariSemai(batch(0, lima)).target_hari_ini, 400);
  assert.equal(naikDariSemai(batch(1, lima)).target_hari_ini, 450); // yang dikirim ke alat: 450, bukan "naik 50"
  assert.equal(naikDariSemai(batch(2, lima)).target_hari_ini, 500);
  assert.equal(naikDariSemai(batch(16, lima)).target_hari_ini, 1200);
  assert.equal(naikDariSemai(batch(40, lima)).target_hari_ini, 1200); // ditahan sampai panen
  // naik sejak tahap Semai, tidak menunggu pindah netpot
  assert.equal(targetBatch(batch(1, lima, 'Semai')).ppm, 450);
  assert.equal(naikDariSemai(batch(10)).target_hari_ini, 667);
});

test('hari semai diambil dari hari_semai (/tanam) atau umur_hari − 1 (batchPerMeja)', () => {
  assert.equal(naikDariSemai({ tahap: 'Semai', umur_hari: 1, ...KURVA }).target_hari_ini, 400);
  assert.equal(naikDariSemai({ tahap: 'Semai', umur_hari: 16, ...KURVA }).target_hari_ini, 800);
});

test('batch lama (tanpa kurva_cara) tetap rumus lama sejak pindah netpot — target tidak melompat', () => {
  const lama = { tahap: 'Pendewasaan', hari_netpot: 15, umur_hari: 26, ppm_awal: 400, ppm_target: 1200, hari_capai: 30 };
  assert.equal(naikHarian(lama).target_hari_ini, 800);
  assert.equal(targetBatch(lama).ppm, 800);
  assert.equal(naikHarian({ tahap: 'Semai', hari_netpot: null, ...KURVA }), null);
});

test('ubah target di hari ke-10: hari ini tetap 667, lalu naik rata ke target baru (tanpa lompatan)', () => {
  const r = rencanaUbah(batch(10), { ppm_target: 1500 });
  assert.equal(r.errors, undefined);
  assert.equal(r.target_hari_ini, 667);
  assert.deepEqual(r.kolom, { kurva_cara: 'harian', kurva_ppm_awal: 400, kurva_ppm_target: 1500, kurva_hari_capai: 30, kurva_mulai_hari: 10, kurva_mulai_ppm: 667, kurva_ph_min: null, kurva_ph_max: null });
  const sesudah = (h) => naikDariSemai(batch(h, r.kolom)).target_hari_ini;
  assert.equal(sesudah(10), 667);
  assert.equal(sesudah(20), 1084); // 667 + (1500 − 667) × 10/20
  assert.equal(sesudah(30), 1500);
});

test('target diturunkan: diizinkan dengan peringatan pengenceran', () => {
  const r = rencanaUbah(batch(10), { ppm_target: 600, hari_capai: 15 });
  assert.match(r.peringatan, /mengencerkan/);
  assert.equal(naikDariSemai(batch(15, r.kolom)).target_hari_ini, 600);
});

test('pagar: hari capai harus di depan hari sekarang; kenaikan maks 150 ppm/hari', () => {
  assert.ok(rencanaUbah(batch(10), { hari_capai: 10 }).errors.hari_capai);
  assert.ok(rencanaUbah(batch(10), { ppm_target: 2500, hari_capai: 12 }).errors.ppm_target);
  assert.ok(rencanaUbah(batch(10), { ppm_target: 'abc' }).errors.ppm_target);
});

test('di hari pertama semai: kurva diganti seluruhnya', () => {
  const r = rencanaUbah(batch(0, KURVA, 'Semai'), { ppm_awal: 350, ppm_target: 1000, hari_capai: 25 });
  assert.deepEqual(r.kolom, { kurva_cara: 'harian', kurva_ppm_awal: 350, kurva_ppm_target: 1000, kurva_hari_capai: 25, kurva_mulai_hari: 0, kurva_mulai_ppm: 350, kurva_ph_min: null, kurva_ph_max: null });
});

test('mengubah batch lama: dialihkan ke hitungan sejak Mulai Semai, melanjutkan dari target hari ini (tanpa lompatan)', () => {
  const lama = { tahap: 'Pendewasaan', hari_semai: 25, hari_netpot: 15, ppm_awal: 400, ppm_target: 1200, hari_capai: 30 };
  const r = rencanaUbah(lama, { ppm_target: 1000, hari_capai: 40 });
  assert.equal(r.target_hari_ini, 800);
  assert.equal(r.kolom.kurva_cara, 'harian');
  assert.equal(r.kolom.kurva_mulai_hari, 25);
  assert.equal(naikDariSemai({ ...lama, ...r.kolom }).target_hari_ini, 800);
});

test('mulai semai: salin kurva tanaman, isian dialog menimpa', () => {
  const tanaman = { ppm_awal: 400, ppm_target: 1200, hari_capai: 30 };
  assert.equal(kurvaAwal(tanaman, {}).kolom.kurva_ppm_target, 1200);
  assert.equal(kurvaAwal(tanaman, { ppm_target: '1400' }).kolom.kurva_ppm_target, 1400);
  assert.equal(kurvaAwal({ ppm_awal: null, ppm_target: null, hari_capai: null }, {}).kolom, null);
  assert.ok(kurvaAwal(null, { ppm_awal: 900, ppm_target: 500, hari_capai: 10 }).errors.ppm_target);
});

test('per siklus: ppm tetap per tahap; berganti hanya saat tahap berganti', () => {
  const tahap = { kurva_cara: 'tahap', kurva_ppm_semai: 300, kurva_ppm_peremajaan: 700, kurva_ppm_pendewasaan: 1100, kurva_ph_min: '5.5', kurva_ph_max: '6.5' };
  assert.deepEqual(targetBatch({ tahap: 'Semai', hari_semai: 9, ...tahap }), { ppm: 300, ph_min: 5.5, ph_max: 6.5, cara: 'tahap' });
  assert.equal(targetBatch({ tahap: 'Peremajaan', hari_semai: 11, ...tahap }).ppm, 700);
  assert.equal(targetBatch({ tahap: 'Pendewasaan', hari_semai: 30, ...tahap }).ppm, 1100);
  assert.equal(targetBatch({ tahap: 'Semai' }), null); // batch tanpa resep → preset tahap
});

test('mulai semai per siklus & pH: wajib tiga ppm tahap; pH selisih ≥ 0,2', () => {
  const t = { ppm_semai: 300, ppm_peremajaan: 700, ppm_pendewasaan: 1100, ph_min: 5.5, ph_max: 6.5 };
  assert.equal(kurvaAwal(t, { cara_naik: 'tahap' }).kolom.kurva_ppm_peremajaan, 700);
  assert.ok(kurvaAwal({ ...t, ppm_pendewasaan: null }, { cara_naik: 'tahap' }).errors.cara_naik);
  assert.ok(kurvaAwal(t, { cara_naik: 'tahap', ph_min: '6,4', ph_max: '6,5' }).errors.ph_max);
  assert.equal(kurvaAwal(t, { cara_naik: 'tahap', ph_min: '5,8' }).kolom.kurva_ph_min, 5.8);
});

test('ubah batch per siklus: ganti angka tahap', () => {
  const b = { tahap: 'Peremajaan', hari_semai: 12, kurva_cara: 'tahap', kurva_ppm_semai: 300, kurva_ppm_peremajaan: 700, kurva_ppm_pendewasaan: 1100 };
  assert.equal(rencanaUbah(b, { ppm_peremajaan: 750 }).kolom.kurva_ppm_peremajaan, 750);
});

test('cara naik dipilih saat Mulai Semai: master menyimpan dua resep', () => {
  const t = { ppm_awal: 400, ppm_target: 1200, hari_capai: 30, ppm_semai: 300, ppm_peremajaan: 700, ppm_pendewasaan: 1100, ph_min: 5.5, ph_max: 6.5 };
  assert.equal(kurvaAwal(t, {}).kolom.kurva_cara, 'harian'); // bawaan: per hari bila lengkap
  assert.equal(kurvaAwal(t, { cara_naik: 'tahap' }).kolom.kurva_ppm_semai, 300);
  assert.ok(kurvaAwal({ ...t, ppm_semai: null }, { cara_naik: 'tahap' }).errors.cara_naik);
  assert.ok(kurvaAwal({ ppm_semai: 300, ppm_peremajaan: 700, ppm_pendewasaan: 1100 }, { cara_naik: 'harian' }).errors.cara_naik);
  assert.ok(kurvaAwal(t, { cara_naik: 'bebas' }).errors.cara_naik);
});
