'use strict';
/**
 * Kurva naik harian PER BATCH (kolom semais.kurva_*; rumus di presetDosing.naikHarian).
 * - Mulai semai: kurva tanaman disalin ke batch (boleh diubah di dialog Mulai Semai).
 * - Diubah sebelum pindah netpot: seluruh kurva diganti.
 * - Diubah setelah pindah netpot: target HARI INI dipertahankan, lalu naik/turun rata ke target baru
 *   (tidak ada lompatan; hitungan hari semai → panen tidak berubah).
 */
const { one } = require('./db');
const { naikHarian, naikDariSemai, hariSemai, kurvaBatch } = require('./presetDosing');

/** Batas kenaikan per hari: alat maksimal menaikkan 150 ppm per dosing (Firmware v6 §7.3, maks_ppm_sekali). */
const MAKS_NAIK_PER_HARI = 150;
const RENTANG_PPM = [50, 2500];
const RENTANG_HARI = [1, 365];

function bulatDalam(v, [min, max]) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}
/** pH 4,0–8,5 (rentang firmware); koma boleh. */
function phDalam(v) {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim().replace(',', '.')) : NaN;
  return Number.isFinite(n) && n >= 4 && n <= 8.5 ? Math.round(n * 100) / 100 : null;
}

const ISIAN_PPM = [['ppm_awal', RENTANG_PPM], ['ppm_target', RENTANG_PPM], ['hari_capai', RENTANG_HARI],
  ['ppm_semai', RENTANG_PPM], ['ppm_peremajaan', RENTANG_PPM], ['ppm_pendewasaan', RENTANG_PPM]];

/**
 * Validasi isian kurva. Field yang tidak dikirim = null (dipakai bawaan).
 * @returns {{nilai: Record<string, number|string|null>, errors: Record<string,string[]>}}
 */
function bacaIsian(b) {
  const errors = {};
  const nilai = {};
  const kosong = (k) => b?.[k] === undefined || b[k] === null || b[k] === '';
  for (const [k, rentang] of ISIAN_PPM) {
    if (kosong(k)) { nilai[k] = null; continue; }
    nilai[k] = bulatDalam(b[k], rentang);
    if (nilai[k] == null) errors[k] = [`${k} harus bilangan bulat ${rentang[0]}–${rentang[1]}.`];
  }
  for (const k of ['ph_min', 'ph_max']) {
    if (kosong(k)) { nilai[k] = null; continue; }
    nilai[k] = phDalam(b[k]);
    if (nilai[k] == null) errors[k] = ['pH harus 4,0–8,5.'];
  }
  nilai.cara_naik = kosong('cara_naik') ? null : b.cara_naik;
  if (nilai.cara_naik != null && !['harian', 'tahap'].includes(nilai.cara_naik)) errors.cara_naik = ['Pilih per hari atau per siklus.'];
  return { nilai, errors };
}

/** Rentang pH: keduanya kosong, atau keduanya terisi dengan selisih ≥ 0,2 (Kontrak §6.2 SEMAI). */
function cekPh(min, max) {
  if (min == null && max == null) return null;
  if (min == null || max == null) return { ph_max: ['Isi pH min dan pH maks sekaligus.'] };
  if (max - min < 0.2) return { ph_max: ['pH maks harus ≥ pH min + 0,2.'] };
  return null;
}

/**
 * Resep batch baru. Cara naik (`cara_naik`: harian = per hari, tahap = per siklus) DIPILIH saat Mulai Semai;
 * angkanya dari resep Master Jenis Tanaman, boleh ditimpa isian dialog untuk batch ini saja.
 * Tanpa pilihan: per hari bila resep per hari lengkap, selainnya per siklus. kolom null = tanaman tanpa resep.
 * @returns {{kolom: object|null, errors: object}}
 */
function kurvaAwal(tanaman, isian) {
  const { nilai, errors } = bacaIsian(isian);
  if (Object.keys(errors).length) return { kolom: null, errors };
  const pilih = (k) => nilai[k] ?? (tanaman?.[k] == null ? null : Number(tanaman[k]));
  const adaHarian = pilih('ppm_awal') != null && pilih('ppm_target') != null && pilih('hari_capai') != null;
  const adaTahap = pilih('ppm_semai') != null;
  const cara = nilai.cara_naik ?? (adaHarian || !adaTahap ? 'harian' : 'tahap');
  const ph = { kurva_ph_min: pilih('ph_min'), kurva_ph_max: pilih('ph_max') };
  const galatPh = cekPh(ph.kurva_ph_min, ph.kurva_ph_max);
  if (galatPh) return { kolom: null, errors: galatPh };
  if (cara === 'tahap') {
    const t = { kurva_ppm_semai: pilih('ppm_semai'), kurva_ppm_peremajaan: pilih('ppm_peremajaan'), kurva_ppm_pendewasaan: pilih('ppm_pendewasaan') };
    if (Object.values(t).some((v) => v == null)) {
      return { kolom: null, errors: { cara_naik: ['Resep per siklus belum diisi: isi ppm Semai, Peremajaan, dan Pendewasaan.'] } };
    }
    return { kolom: { kurva_cara: 'tahap', ...t, ...ph }, errors: {} };
  }
  const awal = pilih('ppm_awal');
  const target = pilih('ppm_target');
  const capai = pilih('hari_capai');
  if (awal == null && target == null && capai == null) {
    if (nilai.cara_naik === 'harian') return { kolom: null, errors: { cara_naik: ['Resep per hari belum diisi: isi ppm awal, ppm akhir, dan hari capai.'] } };
    return { kolom: ph.kurva_ph_min != null ? { kurva_cara: 'harian', ...ph } : null, errors: {} };
  }
  if (awal == null || target == null || capai == null) {
    return { kolom: null, errors: { kurva: ['Isi ppm awal, ppm target, dan hari capai sekaligus.'] } };
  }
  if (awal > target) return { kolom: null, errors: { ppm_target: ['ppm target harus ≥ ppm awal.'] } };
  return {
    kolom: {
      kurva_cara: 'harian', kurva_ppm_awal: awal, kurva_ppm_target: target, kurva_hari_capai: capai,
      kurva_mulai_hari: 0, kurva_mulai_ppm: awal, ...ph,
    },
    errors: {},
  };
}

/**
 * Rencana perubahan kurva batch yang sedang berjalan (fungsi murni; diuji di test/kurvaNutrisi.test.js).
 * @param {object} batch baris batch (tahap, hari_netpot, kurva_* / ppm_* tanaman)
 * @returns {{kolom?: object, errors?: object, peringatan?: string|null, target_hari_ini?: number|null}}
 */
function rencanaUbah(batch, isian) {
  const { nilai, errors } = bacaIsian(isian);
  if (Object.keys(errors).length) return { errors };
  const ph = {
    kurva_ph_min: nilai.ph_min ?? (batch.kurva_ph_min == null ? null : Number(batch.kurva_ph_min)),
    kurva_ph_max: nilai.ph_max ?? (batch.kurva_ph_max == null ? null : Number(batch.kurva_ph_max)),
  };
  const galatPh = cekPh(ph.kurva_ph_min, ph.kurva_ph_max);
  if (galatPh) return { errors: galatPh };
  if (batch.kurva_cara === 'tahap') {
    // per tahap: ppm memang tetap per tahap; angka tahap berjalan berlaku mulai kiriman TARGET berikutnya
    const t = {
      kurva_ppm_semai: nilai.ppm_semai ?? Number(batch.kurva_ppm_semai),
      kurva_ppm_peremajaan: nilai.ppm_peremajaan ?? Number(batch.kurva_ppm_peremajaan),
      kurva_ppm_pendewasaan: nilai.ppm_pendewasaan ?? Number(batch.kurva_ppm_pendewasaan),
    };
    if (Object.values(t).some((v) => !Number.isFinite(v))) return { errors: { kurva: ['Isi ppm Semai, Peremajaan, dan Pendewasaan.'] } };
    return { kolom: { ...t, ...ph }, peringatan: null, target_hari_ini: null };
  }
  const lama = kurvaBatch(batch);
  const target = nilai.ppm_target ?? lama?.akhir ?? null;
  const capai = nilai.hari_capai ?? lama?.lama ?? null;
  if (target == null || capai == null) return { errors: { kurva: ['Isi ppm target dan hari capai.'] } };

  // Hari dihitung sejak Mulai Semai. Hari pertama (h = 0): kurva diganti seluruhnya; sesudahnya lanjut dari target hari ini.
  const h = hariSemai(batch) ?? 0;
  if (h === 0) {
    const awal = nilai.ppm_awal ?? lama?.awal ?? null;
    if (awal == null) return { errors: { ppm_awal: ['Isi ppm awal (ppm di hari pertama semai).'] } };
    if (awal > target) return { errors: { ppm_target: ['ppm target harus ≥ ppm awal.'] } };
    return {
      kolom: { kurva_cara: 'harian', kurva_ppm_awal: awal, kurva_ppm_target: target, kurva_hari_capai: capai, kurva_mulai_hari: 0, kurva_mulai_ppm: awal, ...ph },
      peringatan: null, target_hari_ini: null,
    };
  }

  // batch lama (rumus sejak pindah netpot) ikut dialihkan ke hitungan sejak Mulai Semai dengan melanjutkan dari target hari ini
  const kini = (batch.kurva_cara === 'harian' ? naikDariSemai(batch) : naikHarian(batch))?.target_hari_ini ?? lama?.awal ?? null;
  if (kini == null) return { errors: { kurva: ['Target hari ini tidak diketahui; isi kurva tanaman dulu.'] } };
  if (capai <= h) {
    return { errors: { hari_capai: [`Hari capai harus lebih dari ${h} (hari ke-${h} sejak mulai semai sekarang).`] } };
  }
  const perHari = (target - kini) / (capai - h);
  if (perHari > MAKS_NAIK_PER_HARI) {
    return { errors: { ppm_target: [`Kenaikan ${Math.round(perHari)} ppm/hari terlalu cepat (maks ${MAKS_NAIK_PER_HARI}); tambah hari capai.`] } };
  }
  return {
    kolom: {
      kurva_cara: 'harian', kurva_ppm_awal: lama?.awal ?? kini, kurva_ppm_target: target, kurva_hari_capai: capai,
      kurva_mulai_hari: h, kurva_mulai_ppm: kini, ...ph,
    },
    peringatan: target < kini
      ? `Target turun dari ${kini} ppm: alat harus mengencerkan, dan hanya bisa bila air di penampung SEDANG (bukan PENUH).`
      : null,
    target_hari_ini: kini,
  };
}

/** Batch (akar = id_semai) beserta tahap berjalan, hari sejak Mulai Semai, dan hari sejak pindah netpot. */
async function bacaBatch(idSemai) {
  return one(`
    SELECT s.id_semai, s.status AS status_semai, s.id_meja, s.kurva_ppm_awal, s.kurva_ppm_target, s.kurva_hari_capai,
           s.kurva_mulai_hari, s.kurva_mulai_ppm, s.kurva_cara, s.kurva_ppm_semai, s.kurva_ppm_peremajaan,
           s.kurva_ppm_pendewasaan, s.kurva_ph_min, s.kurva_ph_max, t.ppm_awal, t.ppm_target, t.hari_capai,
           CASE WHEN d.status = 'proses' THEN 'Pendewasaan' WHEN p.status = 'proses' THEN 'Peremajaan'
                WHEN s.status = 'proses' THEN 'Semai' ELSE NULL END AS tahap,
           current_date - s.tgl_awal_semai::date AS hari_semai,
           current_date - coalesce(p.tgl_awal_peremajaan, d.tgl_awal_pendewasaan)::date AS hari_netpot
      FROM semais s LEFT JOIN tanamen t ON t.id_tanaman = s.id_tanaman
      LEFT JOIN LATERAL (SELECT * FROM peremajaans x WHERE x.id_semai = s.id_semai ORDER BY x.id_peremajaan DESC LIMIT 1) p ON true
      LEFT JOIN LATERAL (SELECT * FROM pendewasaans y WHERE y.id_peremajaan = p.id_peremajaan ORDER BY y.id_pendewasaan DESC LIMIT 1) d ON true
     WHERE s.id_semai = $1`, [idSemai]);
}

module.exports = { bacaIsian, kurvaAwal, rencanaUbah, bacaBatch, MAKS_NAIK_PER_HARI };
