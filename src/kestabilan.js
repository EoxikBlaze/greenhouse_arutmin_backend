'use strict';
/**
 * EVALUASI KESTABILAN TANDON (Fase 3B.1) — fungsi murni, tanpa DB dan tanpa parameter bawaan.
 *
 * Kestabilan dinilai dari WAKTU PENGAMATAN, bukan jumlah baris: monitorings menyimpan bacaan identik
 * sebagai satu baris (updated_at disegarkan, n_konfirmasi bertambah, celah_maks_detik = jeda terpanjang
 * antar penerimaan). Satu baris = interval [created_at, updated_at] yang benar-benar teramati.
 *
 * Bukti stabil hanya bila SEMUA terpenuhi:
 *  1. bacaan terakhir segar (umur ≤ basiDetik);
 *  2. seluruh jendela [sekarang − jendelaDetik, sekarang] tertutup pengamatan (baris pertama mulai ≤ awal jendela);
 *  3. tidak ada celah > basiDetik: di dalam baris (celah_maks_detik) maupun antar baris;
 *  4. setiap baris punya data konfirmasi (n_konfirmasi & celah_maks_detik bukan NULL — baris lama tidak dihitung);
 *  5. setiap bacaan sah (pH & TDS ada, lolos sanity) dan di dalam pita target;
 *  6. opsional: fluktuasi (maks − min) ≤ toleransi; jumlah penerimaan ≥ minKonfirmasi.
 * Batas konservatif: celah_maks_detik berlaku untuk seluruh umur baris, termasuk sebelum jendela.
 */
const { bacaanMustahil } = require('./sanitySensor');

const ms = (v) => (v instanceof Date ? v.getTime() : new Date(v).getTime());
const n = (v) => (v == null ? null : Number(v));

/**
 * @param {Array<{created_at, updated_at, ph, tds, waterTemp, n_konfirmasi, celah_maks_detik}>} baris urut created_at naik;
 *   cukup baris yang updated_at ≥ awal jendela
 * @param {{sekarangMs:number, jendelaDetik:number, basiDetik:number,
 *          pita:{ec_min:number, ec_max:number, ph_min:number, ph_max:number},
 *          toleransi?:{ph:number, tds:number}|null, minKonfirmasi?:number|null}} o
 * @returns {{stabil:boolean, alasan:string|null, konfirmasi?:number, rentang?:object}}
 */
function evaluasiKestabilan(baris, o) {
  const tidak = (alasan) => ({ stabil: false, alasan });
  for (const k of ['sekarangMs', 'jendelaDetik', 'basiDetik']) {
    if (!Number.isFinite(o?.[k]) || o[k] <= 0) throw new Error(`evaluasiKestabilan: ${k} wajib angka > 0`);
  }
  if (!o.pita || !['ec_min', 'ec_max', 'ph_min', 'ph_max'].every((k) => Number.isFinite(o.pita[k]))) {
    throw new Error('evaluasiKestabilan: pita target tidak lengkap');
  }
  if (!baris?.length) return tidak('belum ada bacaan');
  const awal = o.sekarangMs - o.jendelaDetik * 1000;
  const akhir = baris.at(-1);
  const umur = (o.sekarangMs - ms(akhir.updated_at ?? akhir.created_at)) / 1000;
  if (umur > o.basiDetik) return tidak(`sensor basi/terputus (bacaan terakhir ${Math.round(umur)} dtk lalu)`);
  if (ms(baris[0].created_at) > awal) {
    return tidak(`durasi pengamatan belum terpenuhi (kurang ${Math.ceil((ms(baris[0].created_at) - awal) / 1000)} dtk)`);
  }
  let konfirmasi = 0;
  const r = { ph: [Infinity, -Infinity], tds: [Infinity, -Infinity] };
  for (let i = 0; i < baris.length; i += 1) {
    const b = baris[i];
    if (b.n_konfirmasi == null || b.celah_maks_detik == null) return tidak('bacaan tanpa data konfirmasi (sebelum pencatatan pengamatan) tidak dihitung');
    if (n(b.celah_maks_detik) > o.basiDetik) return tidak(`celah data ${b.celah_maks_detik} dtk di dalam satu bacaan`);
    if (i > 0) {
      const celah = (ms(b.created_at) - ms(baris[i - 1].updated_at ?? baris[i - 1].created_at)) / 1000;
      if (celah > o.basiDetik) return tidak(`celah data ${Math.round(celah)} dtk antar bacaan`);
    }
    const ph = n(b.ph);
    const tds = n(b.tds);
    if (ph == null || tds == null) return tidak('bacaan pH/TDS tidak lengkap');
    const mustahil = bacaanMustahil({ ph, tds, suhuAir: n(b.waterTemp) });
    if (mustahil) return tidak(`bacaan tidak valid: ${mustahil}`);
    if (tds < o.pita.ec_min || tds > o.pita.ec_max || ph < o.pita.ph_min || ph > o.pita.ph_max) {
      return tidak(`bacaan (pH ${ph}, TDS ${tds}) di luar pita target`);
    }
    r.ph = [Math.min(r.ph[0], ph), Math.max(r.ph[1], ph)];
    r.tds = [Math.min(r.tds[0], tds), Math.max(r.tds[1], tds)];
    if (ms(b.created_at) >= awal) konfirmasi += n(b.n_konfirmasi);
    else {
      // baris yang mulai sebelum jendela: jeda antar penerimaan ≤ celah_maks → minimal floor(overlap / celah) penerimaan di jendela
      const overlap = (ms(b.updated_at ?? b.created_at) - awal) / 1000;
      const batasBawah = n(b.n_konfirmasi) > 1 ? Math.floor(overlap / Math.max(1, n(b.celah_maks_detik))) : 0;
      konfirmasi += Math.min(n(b.n_konfirmasi), Math.max(1, batasBawah));
    }
  }
  if (o.toleransi) {
    if (r.ph[1] - r.ph[0] > o.toleransi.ph) return tidak(`fluktuasi pH ${(r.ph[1] - r.ph[0]).toFixed(2)} melebihi toleransi`);
    if (r.tds[1] - r.tds[0] > o.toleransi.tds) return tidak(`fluktuasi TDS ${r.tds[1] - r.tds[0]} ppm melebihi toleransi`);
  }
  if (o.minKonfirmasi != null && konfirmasi < o.minKonfirmasi) return tidak(`baru ${konfirmasi} penerimaan bacaan (butuh ${o.minKonfirmasi})`);
  return { stabil: true, alasan: null, konfirmasi, rentang: r };
}

module.exports = { evaluasiKestabilan };
