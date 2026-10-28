'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluasiGerbang, validasiBatasOperasi, EKSEKUSI_DIIZINKAN } = require('../src/gerbangDosis');

// angka di bawah HANYA fixture uji bentuk, bukan nilai agronomis
const BATAS = { tds_min_ppm: 100, tds_max_ppm: 900, ph_min: 5, ph_max: 7 };
const preset = (o = {}) => ({ id: 1, versi: 1, status_validasi: 'TERVALIDASI', parameter: { batas_operasi: BATAS }, ...o });
const bacaan = (o = {}) => ({ ph: 6, tds: 500, waterTemp: 25, umurDetik: 5, ...o });

test('gerbang: eksekusi dosis SELALU diblokir di fase ini, walau semua syarat lain terpenuhi', () => {
  assert.equal(EKSEKUSI_DIIZINKAN, false);
  const r = evaluasiGerbang({ preset: preset(), bacaan: bacaan() });
  assert.equal(r.boleh, false);
  assert.deepEqual(r.alasan, ['eksekusi_dosis_diblokir']);
  assert.deepEqual(r.batas, BATAS);
});

test('gerbang: preset hilang / belum tervalidasi / batas operasi tidak ada atau tidak sah', () => {
  assert.ok(evaluasiGerbang({ preset: null, bacaan: bacaan() }).alasan.includes('preset_tidak_ada'));
  assert.ok(evaluasiGerbang({ preset: preset({ status_validasi: 'BELUM_TERVALIDASI' }), bacaan: bacaan() }).alasan.includes('preset_belum_tervalidasi'));
  assert.ok(evaluasiGerbang({ preset: preset({ parameter: { tahap: {} } }), bacaan: bacaan() }).alasan.includes('batas_operasi_belum_ada'));
  assert.ok(evaluasiGerbang({ preset: preset({ parameter: { batas_operasi: { tds_min_ppm: 900, tds_max_ppm: 100, ph_min: 5, ph_max: 7 } } }), bacaan: bacaan() })
    .alasan.includes('batas_operasi_tidak_sah'));
});

test('gerbang: sensor basi, tidak lengkap, tidak wajar (sanity), dan di luar batas operasi tanaman dibedakan', () => {
  assert.ok(evaluasiGerbang({ preset: preset(), bacaan: null }).alasan.includes('bacaan_tidak_ada'));
  assert.ok(evaluasiGerbang({ preset: preset(), bacaan: bacaan({ umurDetik: 600 }) }).alasan.includes('sensor_basi'));
  assert.ok(evaluasiGerbang({ preset: preset(), bacaan: bacaan({ tds: null }) }).alasan.includes('bacaan_tidak_lengkap'));
  const wajar = evaluasiGerbang({ preset: preset(), bacaan: bacaan({ tds: 20 }) });
  assert.ok(wajar.alasan.includes('bacaan_tidak_wajar'));
  assert.ok(!wajar.alasan.includes('di_luar_batas_operasi'), 'bacaan mustahil bukan "di luar batas tanaman"');
  assert.ok(evaluasiGerbang({ preset: preset(), bacaan: bacaan({ tds: 1200 }) }).alasan.includes('di_luar_batas_operasi'));
  assert.ok(evaluasiGerbang({ preset: preset(), bacaan: bacaan({ ph: 7.5 }) }).alasan.includes('di_luar_batas_operasi'));
});

test('gerbang: validasi bentuk batas_operasi tanpa nilai bawaan', () => {
  assert.deepEqual(validasiBatasOperasi(undefined), { ok: true, nilai: null });
  assert.equal(validasiBatasOperasi({ tds_min_ppm: 100, tds_max_ppm: 900, ph_min: 5 }).ok, false, 'ph_max hilang');
  assert.equal(validasiBatasOperasi({ ...BATAS, ec_maks: 3 }).ok, false, 'kunci asing (mencampur konsep) ditolak');
  assert.equal(validasiBatasOperasi({ ...BATAS, ph_max: 15 }).ok, false);
  assert.equal(validasiBatasOperasi({ ...BATAS, tds_min_ppm: '100' }).ok, false, 'teks bukan angka');
  assert.equal(validasiBatasOperasi(BATAS).ok, true);
});

test('gerbang 3B.4: 3 bacaan mustahil berturut-turut → sensor_rusak_3x + wajib_lock; 2 saja → tidak', () => {
  const buruk = { ph: 6, tds: 0 };
  const baik = { ph: 6, tds: 500 };
  const r3 = evaluasiGerbang({ preset: preset(), bacaan: bacaan({ tds: 0 }), riwayat: [buruk, buruk, buruk] });
  assert.ok(r3.alasan.includes('sensor_rusak_3x'));
  assert.equal(r3.wajib_lock, true);
  const r2 = evaluasiGerbang({ preset: preset(), bacaan: bacaan({ tds: 0 }), riwayat: [buruk, buruk, baik] });
  assert.ok(!r2.alasan.includes('sensor_rusak_3x'));
  assert.equal(r2.wajib_lock, false);
  assert.ok(r2.alasan.includes('bacaan_tidak_wajar'), 'bacaan terakhir tetap menutup gerbang');
  assert.equal(evaluasiGerbang({ preset: preset(), bacaan: bacaan(), riwayat: [buruk, buruk] }).wajib_lock, false, 'kurang dari 3 bacaan');
});
