'use strict';
/**
 * GERBANG DOSIS (Fase 3B.3) — menilai apakah dosing BOLEH DIPERTIMBANGKAN untuk sebuah siklus.
 * Empat konsep sengaja terpisah (tidak dicampur jadi satu parameter):
 *   1. batas kewajaran sensor   → src/sanitySensor.js (bacaan masuk akal?)
 *   2. target tanaman           → preset_versi.parameter.tahap.*  (ke mana larutan diarahkan)
 *   3. BATAS OPERASI tanaman    → preset_versi.parameter.batas_operasi (di luar ini dosing tidak boleh dipertimbangkan)
 *   4. batas dosis & aktuator   → konfigurasi_dosis / aktuator.js / firmware
 * Tidak ada nilai bawaan: batas_operasi wajib diisi admin pada versi preset dan versinya TERVALIDASI.
 *
 * Aturan "3 bacaan mustahil berturut-turut" (dulu di otomasi.js): gerbang menambah alasan 'sensor_rusak_3x' dan
 * wajib_lock = true. Gerbang SENDIRI tidak mengunci (dipanggil juga dari GET diagnostik); langkah eksekusi alur 3C
 * WAJIB memanggil aktuator.kunciPenampung bila wajib_lock — itu syarat gerbang 3C.
 *
 * EKSEKUSI_DIIZINKAN = false: keputusan pemilik — sampai parameter, rumus, kalibrasi & firmware tervalidasi,
 * gerbang SELALU menolak eksekusi walau semua syarat lain terpenuhi. Mengubahnya butuh perubahan kode + review.
 */
const { q } = require('./db');
const { bacaanMustahil, SENSOR_BASI_DETIK } = require('./sanitySensor');

const EKSEKUSI_DIIZINKAN = false;
const KUNCI_BATAS = ['tds_min_ppm', 'tds_max_ppm', 'ph_min', 'ph_max'];

/** Validasi bentuk batas_operasi (rentang tipe, bukan nilai agronomis). null = tidak diisi. */
function validasiBatasOperasi(b) {
  if (b === undefined || b === null) return { ok: true, nilai: null };
  if (typeof b !== 'object' || Array.isArray(b)) return { ok: false, galat: 'batas_operasi harus objek' };
  const lain = Object.keys(b).filter((k) => !KUNCI_BATAS.includes(k));
  if (lain.length) return { ok: false, galat: `kunci tidak dikenal: ${lain.join(', ')}` };
  const v = {};
  for (const k of KUNCI_BATAS) {
    const n = b[k];
    if (typeof n !== 'number' || !Number.isFinite(n)) return { ok: false, galat: `${k} wajib angka` };
    v[k] = n;
  }
  if (v.tds_min_ppm < 0 || v.tds_max_ppm > 10000 || v.tds_min_ppm >= v.tds_max_ppm) return { ok: false, galat: 'TDS: 0 ≤ min < max ≤ 10000 ppm' };
  if (v.ph_min < 0 || v.ph_max > 14 || v.ph_min >= v.ph_max) return { ok: false, galat: 'pH: 0 ≤ min < max ≤ 14' };
  return { ok: true, nilai: v };
}

/**
 * Evaluasi murni. preset = baris preset_versi {id, versi, status_validasi, parameter} atau null.
 * bacaan = {ph, tds, waterTemp, umurDetik} atau null.
 * @returns {{boleh:boolean, alasan:string[], batas:object|null}}
 */
function evaluasiGerbang({ preset, bacaan, riwayat = [] }) {
  const alasan = [];
  // riwayat = 3 bacaan terakhir (terbaru dulu); semuanya mustahil → sensor dicurigai rusak
  const mustahil3 = riwayat.length >= 3 && riwayat.slice(0, 3).every((r) => bacaanMustahil({
    ph: r.ph == null ? null : Number(r.ph), tds: r.tds == null ? null : Number(r.tds), suhuAir: r.waterTemp == null ? null : Number(r.waterTemp),
  }));
  if (mustahil3) alasan.push('sensor_rusak_3x');
  let batas = null;
  if (!preset) alasan.push('preset_tidak_ada');
  else {
    if (preset.status_validasi !== 'TERVALIDASI') alasan.push('preset_belum_tervalidasi');
    const b = validasiBatasOperasi(preset.parameter?.batas_operasi);
    if (!b.ok) alasan.push('batas_operasi_tidak_sah');
    else if (!b.nilai) alasan.push('batas_operasi_belum_ada');
    else batas = b.nilai;
  }
  const n = (v) => (v == null ? null : Number(v));
  if (!bacaan) alasan.push('bacaan_tidak_ada');
  else {
    const ph = n(bacaan.ph);
    const tds = n(bacaan.tds);
    if (bacaan.umurDetik == null || bacaan.umurDetik > SENSOR_BASI_DETIK) alasan.push('sensor_basi');
    if (ph == null || tds == null) alasan.push('bacaan_tidak_lengkap');
    else if (bacaanMustahil({ ph, tds, suhuAir: n(bacaan.waterTemp) })) alasan.push('bacaan_tidak_wajar');
    else if (batas && (tds < batas.tds_min_ppm || tds > batas.tds_max_ppm || ph < batas.ph_min || ph > batas.ph_max)) {
      alasan.push('di_luar_batas_operasi');
    }
  }
  if (!EKSEKUSI_DIIZINKAN) alasan.push('eksekusi_dosis_diblokir');
  return { boleh: alasan.length === 0, alasan, batas, wajib_lock: mustahil3 };
}

/**
 * Gerbang untuk siklus: memakai versi preset DARI SNAPSHOT siklus (bukan versi aktif sekarang), dengan status
 * validasi terkini versi itu (isi versi beku; validasi bisa menyusul), dan bacaan terakhir penampung siklus.
 */
async function gerbangSiklus(idSiklus) {
  const s = (await q('SELECT id, id_meja_semai, id_preset_versi, mode_target FROM siklus_budidaya WHERE id = $1', [idSiklus]))[0];
  if (!s) return null;
  const preset = s.id_preset_versi
    ? (await q('SELECT id, versi, status_validasi, parameter FROM preset_versi WHERE id = $1', [s.id_preset_versi]))[0] ?? null
    : null;
  const riwayat = s.id_meja_semai == null ? [] : await q(
    `SELECT ph, tds, "waterTemp", extract(epoch FROM now() - coalesce(updated_at, created_at)) AS umur
       FROM monitorings WHERE id_meja = $1 ORDER BY created_at DESC, id DESC LIMIT 3`, [s.id_meja_semai]);
  const m = riwayat[0];
  const hasil = evaluasiGerbang({ preset, riwayat, bacaan: m ? { ph: m.ph, tds: m.tds, waterTemp: m.waterTemp, umurDetik: Number(m.umur) } : null });
  return { id_siklus: Number(s.id), id_preset_versi: s.id_preset_versi == null ? null : Number(s.id_preset_versi), ...hasil };
}

module.exports = { EKSEKUSI_DIIZINKAN, validasiBatasOperasi, evaluasiGerbang, gerbangSiklus };
