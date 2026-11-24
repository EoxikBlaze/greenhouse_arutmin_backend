'use strict';
/**
 * Deteksi anomali DATA sensor — fungsi murni, tanpa DB, tanpa LLM.
 * Semua temuan berkategori 'anomali_data': ini tentang bacaan/alat, BUKAN diagnosis tanaman.
 */
const { SANITY, SENSOR_BASI_DETIK } = require('./sanitySensor');

const INTERVAL_DETIK = 5;  // deploy-pi/firmware/sensor/sensor.ino: INTERVAL_MS = 5000
const JENDELA_MEDIAN = 5;
const KALI_JEDA = 3;       // jeda > 3× interval = data hilang
const MACET_TITIK = 360;   // 30 menit nilai persis sama
// shortcut: ambang lompatan adalah tebakan rekayasa, belum disetel dari data alat nyata;
// setel ulang setelah ada riwayat beberapa hari di greenhouse.
const AMBANG_LOMPAT = { ph: 0.5, tds: 150, suhuAir: 3, airTemp: 5, humidity: 15 };

const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const temuan = (jenis, isi) => ({ jenis, kategori: 'anomali_data', ...isi });

function cariJeda(titik, intervalDetik) {
  const batas = intervalDetik * KALI_JEDA * 1000;
  return titik.slice(1)
    .map((p, i) => ({ dari: titik[i].t, sampai: p.t }))
    .filter((j) => j.sampai - j.dari > batas)
    .map((j) => temuan('jeda', { t: j.dari, durasi_detik: Math.round((j.sampai - j.dari) / 1000), keterangan: 'Tidak ada data masuk pada selang ini (alat atau koneksi terputus).' }));
}

function cariNilaiAneh(sah, sensor) {
  const wajar = SANITY[sensor];
  const ambang = AMBANG_LOMPAT[sensor];
  const hasil = [];
  let sebelumnyaLompat = false;
  sah.forEach((p, i) => {
    if (wajar && (p.v < wajar[0] || p.v > wajar[1])) {
      hasil.push(temuan('di_luar_wajar', { t: p.t, nilai: p.v, keterangan: `Bacaan di luar rentang wajar probe ${wajar[0]}–${wajar[1]}; periksa probe dan kabel.` }));
      sebelumnyaLompat = false;
      return;
    }
    const lompat = ambang != null && i >= JENDELA_MEDIAN
      && Math.abs(p.v - median(sah.slice(i - JENDELA_MEDIAN, i).map((x) => x.v))) > ambang;
    // perubahan tingkat yang menetap hanya dilaporkan sekali, di titik pertamanya
    if (lompat && !sebelumnyaLompat) {
      hasil.push(temuan('lompatan', { t: p.t, nilai: p.v, keterangan: 'Nilai berubah mendadak dibanding bacaan sebelumnya.' }));
    }
    sebelumnyaLompat = lompat;
  });
  return hasil;
}

function cariMacet(sah, macetTitik) {
  if (sah.length < macetTitik) return [];
  const akhir = sah[sah.length - 1];
  const ekor = sah.slice(-macetTitik);
  if (!ekor.every((p) => p.v === akhir.v)) return [];
  return [temuan('macet', { t: ekor[0].t, nilai: akhir.v, keterangan: 'Nilai persis sama terlalu lama; kemungkinan sensor macet. Periksa sebelum menyimpulkan kondisi larutan.' })];
}

/**
 * @param {{t:number,v:number|null}[]} titik  urut naik menurut t (ms epoch)
 * @param {{sensor:string, sekarangMs:number, intervalDetik?:number, macetTitik?:number}} opsi
 * @returns {{jenis:string,kategori:'anomali_data',t?:number,nilai?:number,keterangan:string}[]}
 */
function deteksiAnomali(titik, { sensor, sekarangMs, intervalDetik = INTERVAL_DETIK, macetTitik = MACET_TITIK }) {
  const semua = (titik || []).filter((p) => p && Number.isFinite(p.t));
  const sah = semua.filter((p) => Number.isFinite(p.v));
  if (sah.length === 0) return [temuan('tanpa_data', { keterangan: 'Tidak ada bacaan sensor pada periode ini.' })];
  const terakhir = semua[semua.length - 1].t;
  const umurDetik = Math.round((sekarangMs - terakhir) / 1000);
  const basi = umurDetik > SENSOR_BASI_DETIK
    ? [temuan('basi', { t: terakhir, umur_detik: umurDetik, keterangan: 'Data terakhir sudah lama; ini bukan kondisi saat ini.' })]
    : [];
  return [...cariNilaiAneh(sah, sensor), ...cariJeda(semua, intervalDetik), ...cariMacet(sah, macetTitik), ...basi];
}

module.exports = { deteksiAnomali, AMBANG_LOMPAT, INTERVAL_DETIK };
