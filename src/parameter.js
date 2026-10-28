'use strict';
/**
 * Pembaca parameter keselamatan yang MEMBEDAKAN status (Fase 3B).
 *
 * Dibuat karena aktuator.bacaKonfig() memakai Number(nilai): NULL → 0 dan '' → 0, sehingga
 * "belum diputuskan" tidak bisa dibedakan dari nol yang sah. Modul ini tidak pernah mengisi
 * nilai pengganti: parameter yang tidak SIAP membuat operasi yang membutuhkannya DITOLAK.
 *
 * Status:
 *   TIDAK_ADA          baris parameter tidak ada
 *   NULL               baris ada, nilai belum diisi (belum diputuskan)
 *   TIDAK_VALID        nilai bukan angka hingga / di luar rentang tipe / bukan bulat bila wajib
 *   BELUM_TERVALIDASI  nilai sah secara tipe, tetapi tervalidasi = false
 *   SIAP               nilai sah + tervalidasi (boleh dipakai operasi keselamatan)
 *
 * Rentang di ATURAN hanya batas kewajaran TIPE (mis. persen 0–100, jam > 0) untuk menangkap
 * salah ketik — BUKAN nilai agronomis/keselamatan yang diusulkan.
 */
const { q } = require('./db');

const POS = { min: 0, max: Number.MAX_SAFE_INTEGER, min_eksklusif: true }; // besaran fisik > 0
const HITUNG = { min: 1, max: Number.MAX_SAFE_INTEGER, bulat: true };   // hitungan ≥ 1
const ATURAN = {
  konfigurasi_dosis: {
    persen_ronde_dosis: { min: 0, max: 100, min_eksklusif: true },
    maks_ppm_per_suntikan: POS, maks_ms_per_suntikan: POS, maks_ml_per_suntikan: POS, maks_ml_ph_per_suntikan: POS,
    maks_volume_ab_hari_ml: POS, maks_volume_ph_hari_ml: POS, maks_ml_bilas_per_perintah: POS, ml_ph_per_langkah: POS,
    faktor_ppm_per_ec: POS, ppm_per_detik_pulsa: POS, faktor_skala_dosis_dft: POS, k_faktor: POS,
    maks_suntikan_per_kejadian: HITUNG, maks_kejadian_per_hari: HITUNG, peringatan_dini_kejadian: HITUNG, antrian_alert_maks: HITUNG,
    maks_retry_ec: { min: 0, max: Number.MAX_SAFE_INTEGER, bulat: true }, maks_retry_ph: { min: 0, max: Number.MAX_SAFE_INTEGER, bulat: true },
    deadband_ec_ppm: { min: 0, max: Number.MAX_SAFE_INTEGER }, deadband_ec_ms: { min: 0, max: Number.MAX_SAFE_INTEGER },
    deadband_ph: { min: 0, max: 14 },
    maks_gagal_berturut: { min: 1, max: 4, bulat: true }, // CHECK persetujuan_dosing: maks_percobaan 1–4
    maks_masa_persetujuan_menit: { min: 1, max: 10080, bulat: true },
    min_progres_persen: { min: 0, max: 100, min_eksklusif: true },
    maks_lampau_persen: { min: 0, max: 100, min_eksklusif: true },
    wajib_firmware_v03: { min: 0, max: 1, bulat: true },
    stabil_toleransi_ph: { min: 0, max: 14, min_eksklusif: true },
    stabil_toleransi_tds_ppm: { min: 0, max: 5000, min_eksklusif: true },
  },
  timing_operasi: {
    monitoring_menit: POS, jeda_ab_menit: POS, jeda_a_ke_bilas_detik: POS, jeda_pasca_bilas_detik: POS, volume_bilas_ml: POS,
    isi_botol_timeout_detik: POS, isi_botol_normal_detik: POS, ronde_dosing_menit: POS, jeda_pasca_isi_air_menit: POS,
    isi_air_timeout_menit: POS, gap_besar_menit: POS, baca_stabil_timeout_detik: POS, mixing_menit: POS,
    median_pembacaan_n: HITUNG, reset_counter_jam: { min: 0, max: 23, bulat: true },
    stabil_menit: { min: 1, max: 1440, bulat: true },
    stabil_n_bacaan: { min: 2, max: 1000, bulat: true },
    konfirmasi_tandon_jam: { min: 0, max: 168, min_eksklusif: true },
    konfirmasi_peremajaan_jam_ke: { min: 1, max: 2160, bulat: true },
    konfirmasi_peremajaan_batas_jam: { min: 0, max: 168, min_eksklusif: true },
    ulang_konfirmasi_jam: { min: 0, max: 168, min_eksklusif: true },
    pengingat_konfirmasi_jam: { min: 0, max: 168, min_eksklusif: true },
    limit_batas_ons_pompa: { min: 0, max: 3600, min_eksklusif: true },
  },
};
// parameter lain di kedua tabel: cukup angka hingga ≥ 0
const ATURAN_UMUM = { min: 0, max: Number.MAX_SAFE_INTEGER };

/** Tafsir nilai mentah (pg numeric → string) tanpa pernah mengubah NULL/'' menjadi 0. */
function tafsir(mentah, aturan = ATURAN_UMUM) {
  if (mentah === null || mentah === undefined) return { status: 'NULL', nilai: null, alasan: 'nilai belum diisi' };
  if (typeof mentah === 'string' && mentah.trim() === '') return { status: 'TIDAK_VALID', nilai: null, alasan: 'nilai kosong' };
  if (typeof mentah !== 'string' && typeof mentah !== 'number') return { status: 'TIDAK_VALID', nilai: null, alasan: 'tipe nilai tidak dikenal' };
  const n = Number(mentah);
  if (!Number.isFinite(n)) return { status: 'TIDAK_VALID', nilai: null, alasan: 'bukan angka hingga' };
  if (aturan.bulat && !Number.isInteger(n)) return { status: 'TIDAK_VALID', nilai: null, alasan: 'harus bilangan bulat' };
  const bawah = aturan.min_eksklusif ? n <= aturan.min : n < aturan.min;
  if (bawah || n > aturan.max) {
    return { status: 'TIDAK_VALID', nilai: null, alasan: `di luar rentang ${aturan.min_eksklusif ? '>' : '≥'} ${aturan.min} dan ≤ ${aturan.max}` };
  }
  return { status: 'SAH', nilai: n, alasan: null };
}

/** Status lengkap satu baris parameter. */
function statusBaris(tabel, param, baris) {
  if (!baris) return { tabel, param, status: 'TIDAK_ADA', nilai: null, alasan: 'parameter tidak ada' };
  const t = tafsir(baris.nilai, ATURAN[tabel]?.[param]);
  const dasar = { tabel, param, satuan: baris.satuan ?? null, sumber: baris.sumber ?? null, catatan_validasi: baris.catatan_validasi ?? null };
  if (t.status !== 'SAH') return { ...dasar, status: t.status, nilai: null, alasan: t.alasan };
  if (!baris.tervalidasi) return { ...dasar, status: 'BELUM_TERVALIDASI', nilai: t.nilai, alasan: 'belum divalidasi' };
  return { ...dasar, status: 'SIAP', nilai: t.nilai, alasan: null };
}

/**
 * Baca status parameter. runner = fungsi query (default pool; berikan client transaksi bila perlu).
 * @param {{konfigurasi_dosis?: string[], timing_operasi?: string[]}} minta
 * @returns {Promise<Record<string, object>>} peta param → status
 */
async function bacaParameter(minta, runner = q) {
  const out = {};
  for (const tabel of ['konfigurasi_dosis', 'timing_operasi']) {
    const daftar = minta[tabel] || [];
    if (!daftar.length) continue;
    const res = await runner(
      `SELECT param, nilai, satuan, sumber, tervalidasi, catatan_validasi FROM ${tabel} WHERE param = ANY($1::text[])`, [daftar]);
    const rows = res.rows ?? res;
    const peta = new Map(rows.map((r) => [r.param, r]));
    for (const p of daftar) out[p] = statusBaris(tabel, p, peta.get(p));
  }
  return out;
}

class ParameterBelumSiap extends Error {
  constructor(daftar) {
    super(`Parameter belum siap: ${daftar.map((d) => `${d.param} (${d.status})`).join(', ')}. Operasi ditolak sampai parameter diisi dan divalidasi.`);
    this.status = 409;
    this.kode = 'parameter_belum_siap';
    this.parameter = daftar.map(({ param, status, alasan }) => ({ param, status, alasan }));
  }
}

/** Nilai parameter yang SIAP, atau lempar ParameterBelumSiap. */
async function wajibSiap(minta, runner = q) {
  const st = await bacaParameter(minta, runner);
  const belum = Object.values(st).filter((s) => s.status !== 'SIAP');
  if (belum.length) throw new ParameterBelumSiap(belum);
  return Object.fromEntries(Object.entries(st).map(([k, v]) => [k, v.nilai]));
}

/** Nilai bila SIAP, selain itu null (untuk fitur opsional: null = fitur tidak berjalan). */
async function nilaiBilaSiap(minta, runner = q) {
  const st = await bacaParameter(minta, runner);
  return Object.fromEntries(Object.entries(st).map(([k, v]) => [k, v.status === 'SIAP' ? v.nilai : null]));
}

/** Daftar parameter yang TIDAK terisi/sah (TIDAK_ADA, NULL, TIDAK_VALID). BELUM_TERVALIDASI dianggap terisi. */
async function tidakTerisi(minta, runner = q) {
  const st = await bacaParameter(minta, runner);
  return Object.values(st).filter((s) => !['SIAP', 'BELUM_TERVALIDASI'].includes(s.status));
}

/** Semua parameter yang diatur ATURAN (untuk laporan status). */
const SEMUA = Object.fromEntries(Object.entries(ATURAN).map(([t, a]) => [t, Object.keys(a)]));

module.exports = { ATURAN, tafsir, statusBaris, bacaParameter, wajibSiap, nilaiBilaSiap, tidakTerisi, ParameterBelumSiap, SEMUA };
