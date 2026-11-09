'use strict';
/**
 * Fungsi murni analitik (tanpa DB) — prediksi panen, tren sensor, saran dosis, CSV.
 * Saran dosis hanya SARAN TEKS: tidak membuat angka dosis dan tidak mengeksekusi apa pun
 * (gerbang eksekusi tetap di gerbangDosis.js).
 */

const URUTAN_TAHAP = ['semai', 'peremajaan', 'pendewasaan'];
const MS_HARI = 86_400_000;
const AMBANG_SEGERA_HARI = 3;
const MIN_TITIK_TREN = 3;

/** Tanggal kalender LOKAL → ms UTC tengah malam. pg mengembalikan kolom `date` sebagai tengah malam
 *  waktu lokal, jadi komponen UTC bisa mundur sehari (WITA +8); string 'YYYY-MM-DD' dibaca apa adanya. */
const hariUtc = (v) => {
  const m = typeof v === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = v instanceof Date ? v : new Date(v);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
};
const isoTanggal = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Perkiraan tanggal panen sebuah batch yang sedang berjalan.
 * = tgl mulai tahap sekarang + durasi tahap sekarang + durasi semua tahap sesudahnya.
 * Durasi kosong (belum diatur di sikluses) → tidak ada perkiraan (tidak dikarang).
 */
function prediksiPanen({ tipe, mulai }, durasi, hariIni = new Date()) {
  const idx = URUTAN_TAHAP.indexOf(tipe);
  if (idx < 0 || !mulai) return null;
  const sisa = URUTAN_TAHAP.slice(idx).map((t) => durasi?.[t]);
  if (sisa.some((n) => n === null || n === undefined || !Number.isFinite(Number(n)) || Number(n) < 0)) return null;
  const totalHari = sisa.reduce((a, n) => a + Number(n), 0);
  const panenMs = hariUtc(mulai) + totalHari * MS_HARI;
  const sisaHari = Math.round((panenMs - hariUtc(hariIni)) / MS_HARI);
  let status = 'sesuai';
  if (sisaHari < 0) status = 'terlambat';
  else if (sisaHari <= AMBANG_SEGERA_HARI) status = 'segera';
  return { tgl_prediksi: isoTanggal(panenMs), sisa_hari: sisaHari, status };
}

/** Kemiringan regresi linear (satuan per jam). null bila titik kurang / waktu tak bervariasi. */
function tren(titik) {
  const t = (titik || []).filter((p) => Number.isFinite(p?.t) && Number.isFinite(p?.v));
  if (t.length < MIN_TITIK_TREN) return null;
  const n = t.length;
  const t0 = t[0].t;
  const xs = t.map((p) => (p.t - t0) / 3_600_000);
  const sx = xs.reduce((a, b) => a + b, 0);
  const sy = t.reduce((a, p) => a + p.v, 0);
  const sxx = xs.reduce((a, x) => a + x * x, 0);
  const sxy = xs.reduce((a, x, i) => a + x * t[i].v, 0);
  const pembagi = n * sxx - sx * sx;
  if (pembagi === 0) return null;
  return (n * sxy - sx * sy) / pembagi;
}

const NAMA_SENSOR = { ph: 'pH', tds: 'TDS' };
const SATUAN_SENSOR = { ph: '', tds: ' ppm' };

/**
 * Saran dari nilai terakhir + tren terhadap ambang (min/max dari sensor_thresholds).
 * status: 'aman' | 'perhatian' (menuju batas) | 'di_luar' | 'data_kurang'.
 */
function saranSensor(sensor, nilai, kemiringanPerJam, ambang, jendelaJam) {
  const nama = NAMA_SENSOR[sensor] || sensor;
  const sat = SATUAN_SENSOR[sensor] || '';
  if (!Number.isFinite(nilai) || !ambang || ambang.min == null || ambang.max == null) {
    return { sensor, status: 'data_kurang', saran: `Data ${nama} atau ambangnya belum cukup untuk memberi saran.` };
  }
  const { min, max } = ambang;
  if (nilai < min) {
    return { sensor, status: 'di_luar', nilai, saran: `${nama} ${nilai}${sat} di bawah batas bawah ${min}${sat}. Periksa sensor dan larutan; bila memang rendah, ajukan koreksi lewat alur persetujuan dosing.` };
  }
  if (nilai > max) {
    return { sensor, status: 'di_luar', nilai, saran: `${nama} ${nilai}${sat} di atas batas atas ${max}${sat}. Periksa sensor dan larutan; bila memang tinggi, pertimbangkan pengenceran dengan air setelah dikonfirmasi pengelola.` };
  }
  if (kemiringanPerJam == null) {
    return { sensor, status: 'aman', nilai, saran: `${nama} ${nilai}${sat} dalam rentang ${min}–${max}${sat}. Belum cukup data untuk membaca tren.` };
  }
  const menujuBatas = kemiringanPerJam > 0 ? max : min;
  const jarak = Math.abs(menujuBatas - nilai);
  const jam = Math.abs(kemiringanPerJam) > 1e-9 ? jarak / Math.abs(kemiringanPerJam) : Infinity;
  const arah = kemiringanPerJam > 0 ? 'naik' : 'turun';
  if (Number.isFinite(jam) && jam <= jendelaJam) {
    return {
      sensor, status: 'perhatian', nilai, tren_per_jam: kemiringanPerJam, perkiraan_jam_ke_batas: Math.round(jam * 10) / 10,
      saran: `${nama} ${nilai}${sat} sedang ${arah} dan diperkirakan menyentuh batas ${menujuBatas}${sat} dalam ±${Math.round(jam)} jam. Siapkan koreksi lewat alur persetujuan dosing; jangan dosis manual tanpa konfirmasi.`,
    };
  }
  return { sensor, status: 'aman', nilai, tren_per_jam: kemiringanPerJam, saran: `${nama} ${nilai}${sat} stabil dalam rentang ${min}–${max}${sat}.` };
}

/** Sel CSV aman: kutip, dan netralkan awalan rumus (= + - @) agar tidak jadi rumus di Excel. */
function sel(v) {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s))) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Baris CSV + BOM UTF-8 (agar Excel membaca huruf Indonesia dengan benar). */
function keCsv(kolom, baris) {
  const lines = [kolom.map(sel).join(',')];
  for (const b of baris) lines.push(kolom.map((k) => sel(b[k])).join(','));
  return '﻿' + lines.join('\n');
}

module.exports = { prediksiPanen, tren, saranSensor, keCsv, sel, URUTAN_TAHAP, MIN_TITIK_TREN };
