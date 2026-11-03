'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  hitungSirkulasi,
  hitungBatasMlPh,
  hitungUjiLabEc,
  hitungUjiLabPh,
  hitungLajuPompa,
  hitungPratinjauDosis,
  cekStabilitasSensor,
  deteksiAirDiganti,
  BAWAAN_V41,
} = require('../src/iotV41');

test('v4.1 sirkulasi: T_putar = volume / (talang * debit), saran monitoring = 2 * T_putar (dijepit 10-120)', () => {
  assert.deepEqual(hitungSirkulasi({ volume_l: 0, talang_jumlah: 5, talang_debit: 1 }), {
    putaran_menit: 0,
    saran_monitoring_menit: 0,
    saran_jeda_ab_menit: 5,
  });
  const s = hitungSirkulasi({ volume_l: 200, talang_jumlah: 10, talang_debit: 1.0 });
  assert.equal(s.putaran_menit, 20);
  assert.equal(s.saran_monitoring_menit, 40);
});

test('v4.1 batas mL per koreksi pH: 0 = otomatis dari volume (maks(5, round(0,2 * volume)))', () => {
  assert.equal(hitungBatasMlPh({ ph_maks_ml: 0, volume_l: 0 }), 5);
  assert.equal(hitungBatasMlPh({ ph_maks_ml: 0, volume_l: 200 }), 40);
  assert.equal(hitungBatasMlPh({ ph_maks_ml: 15, volume_l: 200 }), 15);
});

test('v4.1 uji lab EC & pH: menghitung kenaikan ppm/mL dan mL/pH/L serta menolak input tidak sah', () => {
  const ec = hitungUjiLabEc({ awal: 100, akhir: 1000, volume: 1, ml_a: 5, ml_b: 5 });
  assert.equal(ec.ok, true);
  assert.equal(ec.ppm_per_ml, 90);

  const ecGagal = hitungUjiLabEc({ awal: 500, akhir: 400, volume: 1, ml_a: 5, ml_b: 5 });
  assert.equal(ecGagal.ok, false);
  assert.ok(ecGagal.errors.akhir);

  const ph = hitungUjiLabPh({ arah: 'up', volume: 1, delta_ph: 0.5, ml: 0.5 });
  assert.equal(ph.ok, true);
  assert.equal(ph.ml_per_ph_l, 1);
  assert.equal(ph.param, 'ph_up_ml_per_ph_l');
});

test('v4.1 kalibrasi pompa & pratinjau dosis: menghitung laju mL/detik dan porsi dosis 65%', () => {
  const p = hitungLajuPompa({ pompa: 'a', detik: 30, ml: 60 });
  assert.equal(p.ok, true);
  assert.equal(p.laju, 2);
  assert.equal(p.param, 'laju_pompa_a_mls');

  const d = hitungPratinjauDosis({
    ec_sekarang: 500,
    ec_setpoint: 900,
    persen_dosing: 65,
    max_ppm_dosing: 300,
    volume_l: 200,
    ppm_per_ml: 100,
    laju_a: 1.0,
    laju_b: 2.0,
  });
  assert.equal(d.kurang_ppm, 400);
  assert.equal(d.dosis_ppm, 260);
  assert.equal(d.total_ml, 520);
  assert.equal(d.ml_per_pompa, 260);
  assert.equal(d.durasi_a_detik, 260);
  assert.equal(d.durasi_b_detik, 130);
});

test('v4.1 kestabilan 5 bacaan & deteksi air diganti', () => {
  assert.equal(cekStabilitasSensor([700, 705], 'ec_ppm').stabil, false);
  assert.equal(cekStabilitasSensor([700, 705, 710, 708, 704], 'ec_ppm').stabil, true);
  assert.equal(cekStabilitasSensor([6.0, 6.02, 6.04, 6.01], 'ph').stabil, true);
  assert.equal(cekStabilitasSensor([6.0, 6.15, 6.02], 'ph').stabil, false);

  assert.equal(deteksiAirDiganti({ ec_lama_ppm: 900, ec_baru_ppm: 250, sedang_isi_atau_encer: false }).terdeteksi, true);
  assert.equal(deteksiAirDiganti({ ec_lama_ppm: 900, ec_baru_ppm: 250, sedang_isi_atau_encer: true }).terdeteksi, false);
  assert.equal(deteksiAirDiganti({ ec_lama_ppm: 900, ec_baru_ppm: 800, sedang_isi_atau_encer: false }).terdeteksi, false);
});


test('v4.1 aman-secara-bawaan: semua saklar izin dan mode isi otomatis MATI', () => {
  for (const k of ['saklar_ab', 'saklar_ph_up', 'saklar_ph_down', 'saklar_pengenceran', 'mode_isi_otomatis']) {
    assert.equal(BAWAAN_V41[k], 0, k);
  }
  assert.equal(BAWAAN_V41.mode_isi, 'manual');
  assert.throws(() => { BAWAAN_V41.saklar_ab = 1; }, TypeError); // beku
});
