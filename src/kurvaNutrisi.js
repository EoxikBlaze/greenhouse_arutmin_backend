'use strict';
/**
 * Kurva naik harian PER BATCH (kolom semais.kurva_*; rumus di presetDosing.naikHarian).
 * - Mulai semai: kurva tanaman disalin ke batch (boleh diubah di dialog Mulai Semai).
 * - Diubah sebelum pindah netpot: seluruh kurva diganti.
 * - Diubah setelah pindah netpot: target HARI INI dipertahankan, lalu naik/turun rata ke target baru
 *   (tidak ada lompatan; hitungan hari semai → panen tidak berubah).
 */
const { one } = require('./db');
const { naikHarian, kurvaBatch } = require('./presetDosing');

/** Batas kenaikan per hari: alat maksimal menaikkan 150 ppm per dosing (Firmware v6 §7.3, maks_ppm_sekali). */
const MAKS_NAIK_PER_HARI = 150;
const RENTANG_PPM = [50, 2500];
const RENTANG_HARI = [1, 365];

function bulatDalam(v, [min, max]) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}

/**
 * Validasi isian kurva. Field yang tidak dikirim = null (dipakai bawaan).
 * @returns {{nilai: {ppm_awal: number|null, ppm_target: number|null, hari_capai: number|null}, errors: Record<string,string[]>}}
 */
function bacaIsian(b) {
  const errors = {};
  const nilai = {};
  for (const [k, rentang, nama] of [['ppm_awal', RENTANG_PPM, 'ppm'], ['ppm_target', RENTANG_PPM, 'ppm'], ['hari_capai', RENTANG_HARI, 'hari']]) {
    if (b?.[k] === undefined || b[k] === null || b[k] === '') { nilai[k] = null; continue; }
    nilai[k] = bulatDalam(b[k], rentang);
    if (nilai[k] == null) errors[k] = [`${k} harus bilangan bulat ${rentang[0]}–${rentang[1]} ${nama}.`];
  }
  return { nilai, errors };
}

/**
 * Kurva awal batch baru: isian dialog menimpa kurva tanaman. null = tanaman belum punya kurva dan isian kosong.
 * @returns {{kolom: object|null, errors: object}}
 */
function kurvaAwal(tanaman, isian) {
  const { nilai, errors } = bacaIsian(isian);
  if (Object.keys(errors).length) return { kolom: null, errors };
  const awal = nilai.ppm_awal ?? tanaman?.ppm_awal ?? null;
  const target = nilai.ppm_target ?? tanaman?.ppm_target ?? null;
  const capai = nilai.hari_capai ?? tanaman?.hari_capai ?? null;
  if (awal == null && target == null && capai == null) return { kolom: null, errors: {} };
  if (awal == null || target == null || capai == null) {
    return { kolom: null, errors: { kurva: ['Isi ppm awal, ppm target, dan hari capai sekaligus.'] } };
  }
  if (Number(awal) > Number(target)) return { kolom: null, errors: { ppm_target: ['ppm target harus ≥ ppm awal.'] } };
  return {
    kolom: { kurva_ppm_awal: Number(awal), kurva_ppm_target: Number(target), kurva_hari_capai: Number(capai), kurva_mulai_hari: 0, kurva_mulai_ppm: Number(awal) },
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
  const lama = kurvaBatch(batch);
  const target = nilai.ppm_target ?? lama?.akhir ?? null;
  const capai = nilai.hari_capai ?? lama?.lama ?? null;
  if (target == null || capai == null) return { errors: { kurva: ['Isi ppm target dan hari capai.'] } };

  const sudahNetpot = batch.tahap !== 'Semai' && batch.hari_netpot != null;
  if (!sudahNetpot) {
    const awal = nilai.ppm_awal ?? lama?.awal ?? null;
    if (awal == null) return { errors: { ppm_awal: ['Isi ppm awal (ppm saat pindah netpot).'] } };
    if (awal > target) return { errors: { ppm_target: ['ppm target harus ≥ ppm awal.'] } };
    return {
      kolom: { kurva_ppm_awal: awal, kurva_ppm_target: target, kurva_hari_capai: capai, kurva_mulai_hari: 0, kurva_mulai_ppm: awal },
      peringatan: null, target_hari_ini: null,
    };
  }

  const h = Math.max(0, Number(batch.hari_netpot));
  const kini = naikHarian(batch)?.target_hari_ini ?? lama?.awal ?? null;
  if (kini == null) return { errors: { kurva: ['Target hari ini tidak diketahui; isi kurva tanaman dulu.'] } };
  if (capai <= h) {
    return { errors: { hari_capai: [`Hari capai harus lebih dari ${h} (hari sejak pindah netpot sekarang).`] } };
  }
  const perHari = (target - kini) / (capai - h);
  if (perHari > MAKS_NAIK_PER_HARI) {
    return { errors: { ppm_target: [`Kenaikan ${Math.round(perHari)} ppm/hari terlalu cepat (maks ${MAKS_NAIK_PER_HARI}); tambah hari capai.`] } };
  }
  return {
    kolom: {
      kurva_ppm_awal: lama?.awal ?? kini, kurva_ppm_target: target, kurva_hari_capai: capai,
      kurva_mulai_hari: h, kurva_mulai_ppm: kini,
    },
    peringatan: target < kini
      ? `Target turun dari ${kini} ppm: alat harus mengencerkan, dan hanya bisa bila air di penampung SEDANG (bukan PENUH).`
      : null,
    target_hari_ini: kini,
  };
}

/** Batch (akar = id_semai) beserta tahap berjalan dan hari sejak pindah netpot. */
async function bacaBatch(idSemai) {
  return one(`
    SELECT s.id_semai, s.status AS status_semai, s.id_meja, s.kurva_ppm_awal, s.kurva_ppm_target, s.kurva_hari_capai,
           s.kurva_mulai_hari, s.kurva_mulai_ppm, t.ppm_awal, t.ppm_target, t.hari_capai,
           CASE WHEN d.status = 'proses' THEN 'Pendewasaan' WHEN p.status = 'proses' THEN 'Peremajaan'
                WHEN s.status = 'proses' THEN 'Semai' ELSE NULL END AS tahap,
           current_date - coalesce(p.tgl_awal_peremajaan, d.tgl_awal_pendewasaan)::date AS hari_netpot
      FROM semais s LEFT JOIN tanamen t ON t.id_tanaman = s.id_tanaman
      LEFT JOIN LATERAL (SELECT * FROM peremajaans x WHERE x.id_semai = s.id_semai ORDER BY x.id_peremajaan DESC LIMIT 1) p ON true
      LEFT JOIN LATERAL (SELECT * FROM pendewasaans y WHERE y.id_peremajaan = p.id_peremajaan ORDER BY y.id_pendewasaan DESC LIMIT 1) d ON true
     WHERE s.id_semai = $1`, [idSemai]);
}

module.exports = { bacaIsian, kurvaAwal, rencanaUbah, bacaBatch, MAKS_NAIK_PER_HARI };
