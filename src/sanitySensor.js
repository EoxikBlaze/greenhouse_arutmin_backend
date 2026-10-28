'use strict';
/**
 * BATAS KEWAJARAN SENSOR — mendeteksi bacaan yang tidak masuk akal (probe lepas, kabel putus), BUKAN target
 * tanaman dan BUKAN batas operasi dosing (itu di preset: parameter.batas_operasi, src/gerbangDosis.js).
 *
 * Sumber nilai: Perancangan FINAL §4.1 & §9 ("Sanity check sensor"). Belum dicocokkan dengan spesifikasi
 * rentang ukur probe yang terpasang (K4) — jangan dianggap hasil kalibrasi. Kolom sensor_thresholds.sanity_*
 * memuat angka yang sama tetapi belum dibaca kode.
 * Dipindah dari otomasi.js (Fase 3B.3) saat logika dosing lama dihapus.
 */

/** Bacaan terakhir lebih tua dari ini = sensor basi/terputus. */
const SENSOR_BASI_DETIK = 120;

const SANITY = { ph: [3, 9], tds: [50, 2500], suhuAir: [5, 45] };

/** Bacaan mustahil → teks sebab; wajar → null. Nilai yang tidak dikirim (null) tidak diperiksa. */
function bacaanMustahil({ ph, tds, suhuAir }) {
  const luar = (v, [min, max]) => v != null && (!Number.isFinite(v) || v < min || v > max);
  if (luar(ph, SANITY.ph)) return `pH ${ph} di luar rentang wajar ${SANITY.ph.join('–')}`;
  if (luar(tds, SANITY.tds)) return `TDS ${tds} ppm di luar rentang wajar ${SANITY.tds.join('–')} ppm`;
  if (luar(suhuAir, SANITY.suhuAir)) return `suhu air ${suhuAir} °C di luar rentang wajar ${SANITY.suhuAir.join('–')} °C`;
  return null;
}

module.exports = { SANITY, SENSOR_BASI_DETIK, bacaanMustahil };
