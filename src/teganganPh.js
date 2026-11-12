'use strict';
/**
 * Tegangan mentah probe pH terakhir dari alat (kolom `ph_volt` di topik data, firmware gabungan-0.6 ke atas).
 * Dipakai kalibrasi dua titik: firmware menyimpan TEGANGAN di buffer 7,0 dan 4,0, bukan bacaan pH.
 * shortcut: hanya di memori dan satu alat; hilang saat layanan dimulai ulang lalu terisi lagi ±5 dtk.
 *           Pindahkan ke tabel bila ada lebih dari satu probe pH.
 */
const VOLT_MIN = 0;
const VOLT_MAKS = 5;
let terakhir = null; // { volt, pada }

const sah = (v) => typeof v === 'number' && Number.isFinite(v) && v > VOLT_MIN && v < VOLT_MAKS;

function catat(volt, pada = Date.now()) {
  if (sah(volt)) terakhir = { volt, pada };
}

/** Tegangan terakhir bila umurnya ≤ maksDetik; selain itu null (jangan kalibrasi dari angka basi). */
function terbaru(maksDetik = 15, kini = Date.now()) {
  if (!terakhir || kini - terakhir.pada > maksDetik * 1000) return null;
  return terakhir.volt;
}

module.exports = { catat, terbaru, sah };
