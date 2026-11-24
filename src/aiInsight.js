'use strict';
/**
 * Penyusun insight monitoring untuk GARAP AI — fungsi murni: baris sensor → fakta terstruktur.
 * Hanya membaca dan menghitung. Tidak ada rekomendasi dosis dan tidak ada perintah alat.
 */
const { ringkasPeriode, bandingTarget } = require('./aiStatistik');
const { deteksiAnomali } = require('./aiAnomali');
const { SENSOR_BASI_DETIK } = require('./sanitySensor');

/** kolom monitorings → kunci rentang wajar (sanitySensor.SANITY), label, satuan */
const SENSOR = [
  { kolom: 'ph', kunci: 'ph', label: 'pH', satuan: '' },
  { kolom: 'tds', kunci: 'tds', label: 'TDS', satuan: 'ppm' },
  { kolom: 'waterTemp', kunci: 'suhuAir', label: 'Suhu air', satuan: '°C' },
  { kolom: 'airTemp', kunci: 'airTemp', label: 'Suhu udara', satuan: '°C' },
  { kolom: 'humidity', kunci: 'humidity', label: 'Kelembapan udara', satuan: '%' },
];

/** Periode yang dilayani. 7 hari diagregasi per 5 menit di SQL agar tidak menarik ±120 ribu baris. */
const PERIODE = {
  '1j': { label: '1 jam terakhir', detik: 3600, resolusiDetik: 5 },
  '24j': { label: '24 jam terakhir', detik: 86_400, resolusiDetik: 5 },
  '7h': { label: '7 hari terakhir', detik: 604_800, resolusiDetik: 300 },
};

const MAKS_ANOMALI = 20;
const angka = (v) => (v === null || v === undefined ? null : Number(v));

/**
 * @param {object[]} baris      baris monitorings urut naik, tiap baris punya t (ms) + kolom sensor
 * @param {{periode:string, sekarangMs:number, ambang?:object}} opsi  ambang = peta sensor_thresholds
 */
function susunInsight(baris, { periode, sekarangMs, ambang = {} }) {
  const p = PERIODE[periode];
  const dariMs = sekarangMs - p.detik * 1000;
  const terakhir = baris.length ? baris[baris.length - 1].t : null;
  const umurDetik = terakhir === null ? null : Math.round((sekarangMs - terakhir) / 1000);
  const sensor = SENSOR.map((s) => {
    const titik = baris.map((b) => ({ t: b.t, v: angka(b[s.kolom]) }));
    const statistik = ringkasPeriode(titik, { dariMs, sampaiMs: sekarangMs, intervalDetik: p.resolusiDetik });
    const anomali = deteksiAnomali(titik, { sensor: s.kunci, sekarangMs, intervalDetik: p.resolusiDetik });
    return {
      sensor: s.kolom, label: s.label, satuan: s.satuan, statistik,
      target: ambang[s.kolom] ?? null,
      terhadap_target: bandingTarget(statistik.akhir, ambang[s.kolom]),
      jumlah_anomali: anomali.length,
      anomali: anomali.slice(-MAKS_ANOMALI),
    };
  });
  return {
    periode, label_periode: p.label, resolusi_detik: p.resolusiDetik,
    dari_ms: dariMs, sampai_ms: sekarangMs,
    data_terakhir_ms: terakhir, umur_data_detik: umurDetik,
    // data basi tidak boleh dibaca sebagai kondisi saat ini
    real_time: umurDetik !== null && umurDetik <= SENSOR_BASI_DETIK,
    sifat: 'analisis_data', // bukan diagnosis tanaman, bukan perintah
    sensor,
  };
}

module.exports = { susunInsight, PERIODE, SENSOR };
