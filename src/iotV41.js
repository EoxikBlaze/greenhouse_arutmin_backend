'use strict';
/**
 * Perhitungan murni & aturan Perancangan Sistem IoT Hidroponik 1 Penampung v4.1
 * (Perancangan_Sistem_v4.1.md, Wiring_Sistem_v2.0.md, Kontrak_MQTT_Hidro_Control.docx).
 *
 * Mencakup:
 *  - Waktu satu putaran larutan (T_putar) & saran otomatis monitoring_menit (2 × T_putar)
 *  - Batas mL per koreksi pH otomatis dari volume (maks(5, round(0,2 × volume_l)))
 *  - Kalkulator Uji Lab EC (ppm_per_ml) & Uji Lab pH (ph_up_ml_per_ph_l, ph_down_ml_per_ph_l)
 *  - Kalkulator laju pompa hasil kalibrasi gelas ukur (mL ÷ detik)
 *  - Pratinjau dosis A+B (kekurangan, porsi 65%, batas 300 ppm, total mL, durasi detik)
 *  - Pemeriksaan kestabilan 5 bacaan terakhir (sebaran EC ≤ 40 µS/cm atau 20 ppm; pH ≤ 0,06)
 *  - Deteksi kecurigaan air dikuras/diganti (EC turun ≥ 200 ppm dan ≥ 30% dalam 10 menit)
 */

// Nilai cadangan HANYA untuk tampilan/pratinjau saat parameter di DB kosong. Semua saklar izin bawaan MATI (0);
// angka lain berasal dari Perancangan v4.1 dan BELUM divalidasi — jangan dipakai sebagai dasar tindakan.
const BAWAAN_V41 = Object.freeze({
  volume_l: 0,
  talang_jumlah: 5,
  talang_debit: 1.0,
  monitoring_menit: 45,
  jeda_ab_menit: 5,
  jeda_ec_menit: 20,
  persen_dosing: 65,
  max_ppm_dosing: 300,
  batas_ec_bawah: 900,
  batas_ec_atas: 1500,
  batas_ph_bawah: 5.0,
  batas_ph_atas: 7.0,
  ph_maks_ml: 0,
  pemeliharaan_maks_menit: 120,
  saklar_ab: 0,
  saklar_ph_up: 0,
  saklar_ph_down: 0,
  saklar_pengenceran: 0,
  mode_isi_otomatis: 0, // aman-secara-bawaan: manual sampai pemilik menyalakan
  mode_isi: 'manual',
  ppm_per_ml: 100.7,
  ph_up_ml: 1.0,
  ph_down_ml: 1.0,
  laju_a: 1.0,
  laju_b: 2.1,
  laju_ph_up: 1.5,
  laju_ph_down: 1.53,
  maks_ec_hari: 10,
  maks_encer_hari: 3,
  maks_ph_hari: 5,
});

const bulat = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
const jepit = (v, min, max) => Math.max(min, Math.min(max, v));

/**
 * Hitung satu putaran larutan (T_putar) dan saran waktu monitoring (2 × T_putar).
 * T_putar = volume_l / (talang_jumlah × talang_debit) menit.
 */
function hitungSirkulasi({ volume_l = 0, talang_jumlah = 0, talang_debit = 0 } = {}) {
  const vol = Number(volume_l) || 0;
  const talang = Number(talang_jumlah) || 0;
  const debit = Number(talang_debit) || 0;
  if (vol <= 0 || talang <= 0 || debit <= 0) {
    return { putaran_menit: 0, saran_monitoring_menit: 0, saran_jeda_ab_menit: 5 };
  }
  const putaran = bulat(vol / (talang * debit), 1);
  const saranMonitoring = jepit(Math.round(putaran * 2), 10, 120);
  const saranJedaAb = jepit(Math.max(3, Math.round(putaran * 0.25)), 1, 10);
  return {
    putaran_menit: putaran,
    saran_monitoring_menit: saranMonitoring,
    saran_jeda_ab_menit: saranJedaAb,
  };
}

/**
 * Batas mL per koreksi pH: bila ph_maks_ml > 0 pakai nilai itu,
 * bila 0 hitung otomatis dari volume: maks(5, round(0,2 × volume_l)).
 */
function hitungBatasMlPh({ ph_maks_ml = 0, volume_l = 0 } = {}) {
  const manual = Math.round(Number(ph_maks_ml) || 0);
  if (manual > 0) return jepit(manual, 1, 200);
  const vol = Math.max(0, Number(volume_l) || 0);
  return Math.max(5, Math.round(0.2 * vol));
}

/**
 * Kalkulator Uji Lab EC (1 liter air atau volume bebas):
 * Kenaikan per mL pada 1 L = ((akhir - awal) × volume) / (ml_a + ml_b).
 */
function hitungUjiLabEc({ awal, akhir, volume = 1, ml_a, ml_b } = {}) {
  const pAwal = Number(awal);
  const pAkhir = Number(akhir);
  const vol = Number(volume);
  const a = Number(ml_a);
  const b = Number(ml_b);
  const errors = {};
  if (!Number.isFinite(pAwal) || pAwal < 0) errors.awal = ['ppm awal harus angka ≥ 0.'];
  if (!Number.isFinite(pAkhir) || pAkhir <= 0) errors.akhir = ['ppm akhir harus angka > 0.'];
  else if (Number.isFinite(pAwal) && pAkhir <= pAwal) errors.akhir = ['Bacaan ppm akhir harus lebih tinggi dari ppm awal.'];
  if (!Number.isFinite(vol) || vol < 0.1 || vol > 1000) errors.volume = ['Volume air uji harus 0,1–1000 L.'];
  if (!Number.isFinite(a) || a <= 0) errors.ml_a = ['Takaran A (mL) harus > 0.'];
  if (!Number.isFinite(b) || b <= 0) errors.ml_b = ['Takaran B (mL) harus > 0.'];
  if (Object.keys(errors).length) return { ok: false, errors, ppm_per_ml: null };
  const totalMl = a + b;
  const naik = pAkhir - pAwal;
  const ppmPerMl = bulat((naik * vol) / totalMl, 2);
  return {
    ok: true,
    errors: {},
    awal: pAwal,
    akhir: pAkhir,
    volume: vol,
    ml_a: a,
    ml_b: b,
    naik_ppm: bulat(naik, 1),
    total_ml: bulat(totalMl, 2),
    ppm_per_ml: ppmPerMl,
  };
}

/**
 * Kalkulator Uji Lab pH (pH up terpisah dari pH down):
 * mL per 1 satuan pH per 1 L = ml / (|delta_ph| × volume).
 */
function hitungUjiLabPh({ arah = 'up', volume = 1, delta_ph, ml } = {}) {
  const jenis = String(arah).toLowerCase() === 'down' ? 'down' : 'up';
  const vol = Number(volume);
  const dph = Math.abs(Number(delta_ph));
  const jmlMl = Number(ml);
  const errors = {};
  if (!['up', 'down'].includes(String(arah).toLowerCase())) errors.arah = ['Pilih pH up atau pH down.'];
  if (!Number.isFinite(vol) || vol < 0.1 || vol > 1000) errors.volume = ['Volume air uji harus 0,1–1000 L.'];
  if (!Number.isFinite(dph) || dph <= 0 || dph > 10) errors.delta_ph = ['Perubahan pH harus > 0 dan ≤ 10.'];
  if (!Number.isFinite(jmlMl) || jmlMl <= 0) errors.ml = ['Larutan yang dipakai (mL) harus > 0.'];
  if (Object.keys(errors).length) return { ok: false, errors, ml_per_ph_l: null };
  const mlPerPhL = bulat(jmlMl / (dph * vol), 3);
  return {
    ok: true,
    errors: {},
    arah: jenis,
    param: jenis === 'up' ? 'ph_up_ml_per_ph_l' : 'ph_down_ml_per_ph_l',
    volume: vol,
    delta_ph: bulat(dph, 2),
    ml: bulat(jmlMl, 2),
    ml_per_ph_l: mlPerPhL,
  };
}

/**
 * Kalkulator kalibrasi pompa (gelas ukur): laju = ml ÷ detik (mL/detik).
 */
function hitungLajuPompa({ pompa = 'a', detik = 60, ml } = {}) {
  const kode = String(pompa).toLowerCase();
  const petaParam = {
    a: 'laju_pompa_a_mls',
    b: 'laju_pompa_b_mls',
    ph_up: 'laju_pompa_ph_up_mls',
    ph_down: 'laju_pompa_ph_down_mls',
  };
  const d = Number(detik);
  const vMl = Number(ml);
  const errors = {};
  if (!petaParam[kode]) errors.pompa = ['Pompa harus salah satu dari: a, b, ph_up, ph_down.'];
  if (!Number.isFinite(d) || d < 5 || d > 300) errors.detik = ['Lama nyala harus 5–300 detik.'];
  if (!Number.isFinite(vMl) || vMl <= 0 || vMl > 5000) errors.ml = ['Hasil takar (mL) harus > 0.'];
  if (Object.keys(errors).length) return { ok: false, errors, laju: null };
  const laju = bulat(vMl / d, 2);
  return {
    ok: true,
    errors: {},
    pompa: kode,
    param: petaParam[kode],
    detik: Math.round(d),
    ml: bulat(vMl, 2),
    laju,
  };
}

/**
 * Pratinjau dosis A+B sesuai rumus Perancangan v4.1 Bab 5.2:
 *  - kekurangan = max(0, ec_setpoint - ec_sekarang)
 *  - dosis_ppm  = min(max_ppm_dosing, round(kekurangan × persen_dosing / 100))
 *  - total_ml   = round(dosis_ppm × volume_l / ppm_per_ml)
 *  - durasi A/B = round((total_ml / 2) / laju)
 */
function hitungPratinjauDosis({
  ec_sekarang = 0,
  ec_setpoint = 0,
  persen_dosing = 65,
  max_ppm_dosing = 300,
  volume_l = 0,
  ppm_per_ml = 100.7,
  laju_a = 1.0,
  laju_b = 2.1,
} = {}) {
  const now = Math.max(0, Number(ec_sekarang) || 0);
  const target = Math.max(0, Number(ec_setpoint) || 0);
  const persen = jepit(Number(persen_dosing) || 65, 50, 90);
  const maksPpm = jepit(Number(max_ppm_dosing) || 300, 50, 300);
  const vol = Math.max(0, Number(volume_l) || 0);
  const ppmMl = Math.max(0.1, Number(ppm_per_ml) || 100.7);
  const vLajuA = Math.max(0, Number(laju_a) || 0);
  const vLajuB = Math.max(0, Number(laju_b) || 0);

  const kurang = Math.max(0, target - now);
  const dosisPpm = Math.min(maksPpm, Math.round(kurang * (persen / 100)));
  const totalMl = vol > 0 && ppmMl > 0 ? Math.round((dosisPpm * vol) / ppmMl) : 0;
  const mlPerPompa = bulat(totalMl / 2, 1);
  const durasiA = vLajuA > 0 ? Math.round(mlPerPompa / vLajuA) : 0;
  const durasiB = vLajuB > 0 ? Math.round(mlPerPompa / vLajuB) : 0;

  return {
    ec_sekarang: Math.round(now),
    ec_setpoint: Math.round(target),
    kurang_ppm: Math.round(kurang),
    persen_dosing: persen,
    dosis_ppm: dosisPpm,
    total_ml: totalMl,
    ml_per_pompa: mlPerPompa,
    durasi_a_detik: durasiA,
    durasi_b_detik: durasiB,
  };
}

/**
 * Cek kestabilan dari maksimal 5 bacaan terakhir (Perancangan v4.1 Bab 7):
 *  - pH: minimal 3 bacaan, sebaran (max - min) ≤ 0,06 pH
 *  - ec_ppm: minimal 3 bacaan, sebaran ≤ 20 ppm (setara 40 µS/cm)
 */
function cekStabilitasSensor(daftarNilai = [], jenis = 'ec_ppm') {
  const angkaSah = (Array.isArray(daftarNilai) ? daftarNilai : [])
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v))
    .slice(0, 5);
  const batas = jenis === 'ph' ? 0.06 : jenis === 'ec_us' ? 40 : 20;
  if (angkaSah.length < 3) {
    return { stabil: false, n: angkaSah.length, sebaran: null, batas };
  }
  const sebaran = bulat(Math.max(...angkaSah) - Math.min(...angkaSah), jenis === 'ph' ? 3 : 1);
  return {
    stabil: sebaran <= batas,
    n: angkaSah.length,
    sebaran,
    batas,
  };
}

/**
 * Deteksi kecurigaan air dikuras/diganti: EC turun ≥ 200 ppm dan ≥ 30%
 * ketika alat tidak sedang mengisi air / mengencerkan.
 */
function deteksiAirDiganti({ ec_lama_ppm, ec_baru_ppm, sedang_isi_atau_encer = false } = {}) {
  if (sedang_isi_atau_encer) return { terdeteksi: false, turun_ppm: 0, turun_persen: 0 };
  const lama = Number(ec_lama_ppm);
  const baru = Number(ec_baru_ppm);
  if (!Number.isFinite(lama) || !Number.isFinite(baru) || lama <= 0 || baru >= lama) {
    return { terdeteksi: false, turun_ppm: 0, turun_persen: 0 };
  }
  const turun = Math.round(lama - baru);
  const persen = bulat((turun / lama) * 100, 1);
  return {
    terdeteksi: turun >= 200 && persen >= 30,
    turun_ppm: turun,
    turun_persen: persen,
  };
}

module.exports = {
  BAWAAN_V41,
  hitungSirkulasi,
  hitungBatasMlPh,
  hitungUjiLabEc,
  hitungUjiLabPh,
  hitungLajuPompa,
  hitungPratinjauDosis,
  cekStabilitasSensor,
  deteksiAirDiganti,
};

