'use strict';
/* Data di berkas ini SINTETIS (dibuat fungsi deret()), bukan bacaan alat nyata. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ringkasPeriode, bandingTarget } = require('../src/aiStatistik');
const { deteksiAnomali } = require('../src/aiAnomali');

const T0 = Date.UTC(2026, 10, 13, 0, 0, 0);
const DTK = 1000;
/** n titik tiap 5 dtk; nilai = f(i). */
const deret = (n, f, langkahDtk = 5) => Array.from({ length: n }, (_, i) => ({ t: T0 + i * langkahDtk * DTK, v: f(i) }));
const jenis = (hasil) => hasil.map((a) => a.jenis);

test('ringkasPeriode: EC normal (datar) → statistik benar, lengkap 100%', () => {
  const titik = deret(720, () => 1200); // 1 jam
  const r = ringkasPeriode(titik, { dariMs: T0, sampaiMs: T0 + 3600 * DTK, intervalDetik: 5 });
  assert.equal(r.n, 720);
  assert.equal(r.min, 1200);
  assert.equal(r.maks, 1200);
  assert.equal(r.rata, 1200);
  assert.equal(r.perubahan_persen, 0);
  assert.equal(r.kelengkapan_persen, 100);
  assert.equal(r.waktu_terakhir, T0 + 719 * 5 * DTK);
});

test('ringkasPeriode: EC menurun 1400 → 1100 dalam 1 jam', () => {
  const titik = deret(721, (i) => 1400 - (300 * i) / 720);
  const r = ringkasPeriode(titik, { dariMs: T0, sampaiMs: T0 + 3600 * DTK, intervalDetik: 5 });
  assert.equal(r.awal, 1400);
  assert.equal(r.akhir, 1100);
  assert.equal(r.perubahan_persen, -21.4);
  assert.ok(Math.abs(r.tren_per_jam + 300) < 0.5);
  assert.equal(r.arah, 'turun');
});

test('ringkasPeriode: EC meningkat → arah naik', () => {
  const r = ringkasPeriode(deret(100, (i) => 1000 + i * 2), { dariMs: T0, sampaiMs: T0 + 500 * DTK, intervalDetik: 5 });
  assert.equal(r.arah, 'naik');
  assert.ok(r.perubahan_persen > 0);
});

test('ringkasPeriode: sensor tidak terbaca (null) tidak dihitung dan menurunkan kelengkapan', () => {
  const titik = deret(720, (i) => (i % 2 ? null : 6.0));
  const r = ringkasPeriode(titik, { dariMs: T0, sampaiMs: T0 + 3600 * DTK, intervalDetik: 5 });
  assert.equal(r.n, 360);
  assert.equal(r.kelengkapan_persen, 50);
  assert.equal(r.rata, 6);
});

test('ringkasPeriode: tanpa data → n 0 dan nilai null (tidak dikarang)', () => {
  const r = ringkasPeriode([], { dariMs: T0, sampaiMs: T0 + 3600 * DTK, intervalDetik: 5 });
  assert.equal(r.n, 0);
  assert.equal(r.rata, null);
  assert.equal(r.perubahan_persen, null);
  assert.equal(r.kelengkapan_persen, 0);
});

test('ringkasPeriode: titik di luar periode diabaikan', () => {
  const titik = [{ t: T0 - 10 * DTK, v: 99 }, ...deret(10, () => 6)];
  const r = ringkasPeriode(titik, { dariMs: T0, sampaiMs: T0 + 50 * DTK, intervalDetik: 5 });
  assert.equal(r.n, 10);
  assert.equal(r.maks, 6);
});

test('bandingTarget: di bawah, dalam, di atas, tanpa target', () => {
  assert.deepEqual(bandingTarget(5.2, { min: 5.5, max: 6.5 }), { status: 'di_bawah', selisih: -0.3 });
  assert.deepEqual(bandingTarget(6.0, { min: 5.5, max: 6.5 }), { status: 'dalam', selisih: 0 });
  assert.deepEqual(bandingTarget(7.0, { min: 5.5, max: 6.5 }), { status: 'di_atas', selisih: 0.5 });
  assert.equal(bandingTarget(6.0, null).status, 'tanpa_target');
  assert.equal(bandingTarget(null, { min: 5.5, max: 6.5 }).status, 'tanpa_data');
});

test('deteksiAnomali: data normal berderau kecil → tidak ada anomali', () => {
  const titik = deret(200, (i) => 6.0 + (i % 3) * 0.01);
  const a = deteksiAnomali(titik, { sensor: 'ph', sekarangMs: T0 + 200 * 5 * DTK });
  assert.deepEqual(a, []);
});

test('deteksiAnomali: lonjakan satu titik pH → lompatan, berlabel anomali data', () => {
  const titik = deret(100, (i) => (i === 50 ? 8.5 : 6.0 + (i % 2) * 0.01));
  const a = deteksiAnomali(titik, { sensor: 'ph', sekarangMs: T0 + 100 * 5 * DTK });
  assert.deepEqual(jenis(a), ['lompatan']);
  assert.equal(a[0].t, T0 + 50 * 5 * DTK);
  assert.equal(a[0].nilai, 8.5);
  assert.ok(a.every((x) => x.kategori === 'anomali_data'));
});

test('deteksiAnomali: perubahan pH bertahap BUKAN lompatan', () => {
  const titik = deret(720, (i) => 6.0 + (0.8 * i) / 720);
  const a = deteksiAnomali(titik, { sensor: 'ph', sekarangMs: T0 + 720 * 5 * DTK });
  assert.ok(!jenis(a).includes('lompatan'));
});

test('deteksiAnomali: data terlambat → basi', () => {
  const titik = deret(50, () => 1200);
  const a = deteksiAnomali(titik, { sensor: 'tds', sekarangMs: T0 + 50 * 5 * DTK + 600 * DTK });
  assert.ok(jenis(a).includes('basi'));
});

test('deteksiAnomali: MQTT terputus 10 menit di tengah → jeda', () => {
  const titik = [...deret(50, () => 1200), ...deret(50, () => 1200).map((p) => ({ ...p, t: p.t + 850 * DTK }))];
  const a = deteksiAnomali(titik, { sensor: 'tds', sekarangMs: titik[titik.length - 1].t });
  const jeda = a.filter((x) => x.jenis === 'jeda');
  assert.equal(jeda.length, 1);
  assert.equal(jeda[0].durasi_detik, 605);
});

test('deteksiAnomali: nilai persis sama terlalu lama → macet', () => {
  const titik = deret(400, () => 6.37);
  const a = deteksiAnomali(titik, { sensor: 'ph', sekarangMs: T0 + 400 * 5 * DTK, macetTitik: 360 });
  assert.ok(jenis(a).includes('macet'));
});

test('deteksiAnomali: bacaan di luar rentang wajar probe → di_luar_wajar', () => {
  const titik = deret(20, (i) => (i === 10 ? 0 : 1200));
  const a = deteksiAnomali(titik, { sensor: 'tds', sekarangMs: T0 + 20 * 5 * DTK });
  assert.ok(jenis(a).includes('di_luar_wajar'));
});

test('deteksiAnomali: tanpa data → satu temuan tanpa_data', () => {
  assert.deepEqual(jenis(deteksiAnomali([], { sensor: 'ph', sekarangMs: T0 })), ['tanpa_data']);
});

test('susunInsight: menggabung statistik, target, anomali; data basi bukan real-time', () => {
  const { susunInsight } = require('../src/aiInsight');
  const sekarangMs = T0 + 3600 * DTK;
  const baris = deret(600, (i) => 6 + i * 0).map((p, i) => ({ t: p.t, ph: 6.0, tds: 1400 - i * 0.5, waterTemp: null, airTemp: 28, humidity: 70 }));
  const r = susunInsight(baris, { periode: '1j', sekarangMs, ambang: { ph: { min: 5.5, max: 6.5 }, tds: { min: 1200, max: 1600 } } });
  const s = Object.fromEntries(r.sensor.map((x) => [x.sensor, x]));
  assert.equal(r.real_time, false);               // data terakhir 605 dtk lalu
  assert.equal(r.umur_data_detik, 605);
  assert.equal(s.ph.terhadap_target.status, 'dalam');
  assert.equal(s.tds.statistik.arah, 'turun');
  assert.equal(s.tds.terhadap_target.status, 'di_bawah');
  assert.equal(s.airTemp.terhadap_target.status, 'tanpa_target');
  assert.deepEqual(s.waterTemp.anomali.map((a) => a.jenis), ['tanpa_data']);
  assert.ok(s.ph.anomali.some((a) => a.jenis === 'basi'));
  assert.equal(r.sifat, 'analisis_data');
});
