'use strict';
/**
 * Statistik periode untuk GARAP AI — fungsi murni, tanpa DB, tanpa LLM.
 * Angka di jawaban AI berasal dari sini; LLM hanya menarasikan.
 */
const { tren } = require('./analitik');

const AMBANG_ARAH_PERSEN = 1; // perubahan di bawah ini dianggap stabil
const bulat = (v, digit) => Math.round(v * 10 ** digit) / 10 ** digit;

const KOSONG = {
  n: 0, min: null, maks: null, rata: null, awal: null, akhir: null,
  perubahan_persen: null, tren_per_jam: null, arah: null,
  waktu_pertama: null, waktu_terakhir: null, kelengkapan_persen: 0,
};

/**
 * Ringkas satu deret sensor dalam satu periode.
 * @param {{t:number,v:number|null}[]} titik  t = ms epoch, urut naik
 * @param {{dariMs:number,sampaiMs:number,intervalDetik:number}} periode
 */
function ringkasPeriode(titik, { dariMs, sampaiMs, intervalDetik }) {
  const sah = (titik || []).filter((p) => p && p.t >= dariMs && p.t <= sampaiMs && Number.isFinite(p.v));
  if (sah.length === 0) return { ...KOSONG };
  const nilai = sah.map((p) => p.v);
  const awal = nilai[0];
  const akhir = nilai[nilai.length - 1];
  const perubahan = awal === 0 ? null : bulat(((akhir - awal) / Math.abs(awal)) * 100, 1);
  const harapan = Math.floor((sampaiMs - dariMs) / (intervalDetik * 1000));
  let arah = 'stabil';
  if (perubahan !== null && perubahan > AMBANG_ARAH_PERSEN) arah = 'naik';
  else if (perubahan !== null && perubahan < -AMBANG_ARAH_PERSEN) arah = 'turun';
  return {
    n: sah.length,
    min: Math.min(...nilai),
    maks: Math.max(...nilai),
    rata: bulat(nilai.reduce((a, b) => a + b, 0) / nilai.length, 2),
    awal,
    akhir,
    perubahan_persen: perubahan,
    tren_per_jam: tren(sah),
    arah,
    waktu_pertama: sah[0].t,
    waktu_terakhir: sah[sah.length - 1].t,
    kelengkapan_persen: harapan > 0 ? Math.min(100, bulat((sah.length / harapan) * 100, 1)) : 0,
  };
}

/** Bandingkan nilai dengan target {min,max} dari konfigurasi. Target tidak pernah dikarang di sini. */
function bandingTarget(nilai, target) {
  if (!Number.isFinite(nilai)) return { status: 'tanpa_data', selisih: null };
  if (!target || !Number.isFinite(target.min) || !Number.isFinite(target.max)) return { status: 'tanpa_target', selisih: null };
  if (nilai < target.min) return { status: 'di_bawah', selisih: bulat(nilai - target.min, 2) };
  if (nilai > target.max) return { status: 'di_atas', selisih: bulat(nilai - target.max, 2) };
  return { status: 'dalam', selisih: 0 };
}

module.exports = { ringkasPeriode, bandingTarget };
