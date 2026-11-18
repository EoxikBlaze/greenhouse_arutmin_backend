'use strict';
/**
 * Analisis AI harian (dijadwalkan 07.00 WIB) — HANYA MEMBACA data dan menyusun laporan deterministik.
 * Tanpa LLM: semua angka dari hitungan server, kalimat dari templat. Isi berstatus REKOMENDASI untuk operator;
 * analisis ini tidak pernah menjalankan alat. Penyimpanan ada di src/analisisHarianRepo.js (bukan berkas AI).
 */
const { susunLaporan } = require('./aiLaporan');

const SENSOR_TERKINI = [
  { kunci: 'ph', label: 'pH', satuan: '' },
  { kunci: 'tds', label: 'TDS', satuan: 'ppm' },
  { kunci: 'waterTemp', label: 'Suhu air', satuan: '°C' },
  { kunci: 'airTemp', label: 'Suhu udara', satuan: '°C' },
  { kunci: 'humidity', label: 'Kelembapan udara', satuan: '%' },
];
const NAMA_ANOMALI = {
  di_luar_wajar: 'di luar rentang wajar', lompatan: 'lompatan', macet: 'macet (nilai tidak berubah)',
  jeda: 'jeda data', tanpa_data: 'tanpa data', basi: 'data basi',
};
const SARAN_TETAP = 'Koreksi nutrisi/pH hanya boleh diajukan lewat alur persetujuan dosing. Analisis ini tidak menjalankan alat apa pun.';

const sat = (s) => (s ? ` ${s}` : '');
const ada = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

function kalimatTerkini(def, sensor, ambang, tersedia) {
  const v = sensor ? sensor[def.kunci] : null;
  if (!tersedia || !ada(v)) return `${def.label}: tidak tersedia.`;
  const th = ambang?.[def.kunci];
  const n = Number(v);
  if (!th || (th.min == null && th.max == null)) return `${def.label}: ${n}${sat(def.satuan)} (target belum diatur).`;
  let status = 'dalam target';
  if (th.min != null && n < Number(th.min)) status = 'DI BAWAH target';
  else if (th.max != null && n > Number(th.max)) status = 'DI ATAS target';
  return `${def.label}: ${n}${sat(def.satuan)} — ${status} ${th.min ?? '-'}–${th.max ?? '-'}.`;
}

function bagianTerkini(insight, data) {
  const tersedia = insight.real_time === true && !!data.sensor;
  const butir = SENSOR_TERKINI.map((d) => kalimatTerkini(d, data.sensor, data.ambang, tersedia));
  if (!tersedia) {
    butir.unshift(insight.umur_data_detik == null
      ? 'Tidak ada bacaan sensor dalam 24 jam terakhir; nilai terkini tidak tersedia.'
      : `Bacaan terakhir ${Math.round(insight.umur_data_detik / 60)} menit lalu (basi); nilai terkini tidak tersedia.`);
  }
  return butir;
}

function bagianAnomali(insight) {
  const butir = [];
  if (insight.umur_data_detik != null && !insight.real_time) {
    butir.push(`Data sensor basi: bacaan terakhir ${Math.round(insight.umur_data_detik / 60)} menit lalu.`);
  }
  for (const s of insight.sensor) {
    const per = {};
    for (const a of s.anomali) per[a.jenis] = (per[a.jenis] || 0) + 1;
    const teks = Object.entries(per).map(([j, n]) => `${NAMA_ANOMALI[j] || j} ${n}×`);
    if (teks.length) butir.push(`${s.label}: ${teks.join(', ')}.`);
  }
  return butir.length ? butir : ['Tidak ada anomali terdeteksi dalam 24 jam terakhir.'];
}

function bagianAlert(barisAlert24, alertTerbuka) {
  const butir = barisAlert24 ? [barisAlert24] : [];
  const terbuka = alertTerbuka || { total: 0, terbaru: [] };
  butir.push(terbuka.total > 0 ? `${terbuka.total} alert masih terbuka.` : 'Tidak ada alert terbuka.');
  for (const a of terbuka.terbaru || []) {
    butir.push(`• ${a.type}${a.value ? ` (${a.value})` : ''} — ${a.severity || 'info'}`);
  }
  return butir;
}

function bagianTahap(tahap, panen) {
  const butir = (tahap || []).map((x) => {
    const rinci = [x.nama_tanaman, x.status];
    if (x.hari_berjalan != null) rinci.push(`hari ke-${x.hari_berjalan}`);
    if (x.sisa_hari != null) rinci.push(x.sisa_hari < 0 ? `lewat ${-x.sisa_hari} hari` : `sisa ${x.sisa_hari} hari`);
    return `Tahap ${x.tahap}: ${rinci.filter(Boolean).join(', ')}.`;
  });
  if (!butir.length) butir.push('Belum ada data tahap tanam.');
  butir.push(panen
    ? `Panen terakhir ${panen.tgl_panen}${panen.nama_tanaman ? ` (${panen.nama_tanaman})` : ''}: ${panen.panen_berhasil} berhasil, ${panen.panen_gagal ?? 0} gagal.`
    : 'Belum ada panen tercatat.');
  return butir;
}

function bagianPenampung(penampung) {
  if (!penampung || !penampung.length) return ['Data penampung tidak tersedia.'];
  return penampung.map((p) => {
    const rinci = [p.lock ? `terkunci${p.lock_alasan ? ` (${p.lock_alasan})` : ''}` : 'tidak terkunci'];
    if (p.pemeliharaan) rinci.push('mode pemeliharaan');
    if (p.dosis_hari != null) rinci.push(`${p.dosis_hari} kejadian dosis hari ini`);
    if (p.ab_ml_hari != null) rinci.push(`AB ${p.ab_ml_hari} ml hari ini`);
    return `${p.meja}: ${rinci.join(', ')}.`;
  });
}

function bagianLogbook(logbook) {
  const baris = String(logbook || '').split('\n').map((b) => b.trim()).filter(Boolean);
  const isi = baris.filter((b) => b.startsWith('•'));
  return isi.length ? isi : [baris[0] || 'Logbook 7 hari terakhir tidak tersedia.'];
}

function hitungPrioritas(heur, insight, alertKritis) {
  if (heur?.prioritas === 'tinggi' || !insight.real_time || alertKritis > 0) return 'tinggi';
  return heur?.prioritas || 'rendah';
}

/**
 * Fungsi murni: bahan yang sudah dikumpulkan → laporan analisis harian.
 * @param {{tanggal:string, insight:object, alert?:object, perintah?:object[], data:object,
 *          penampung?:object[], logbook?:string, heur?:{keputusan:string, prioritas:string}}} b
 */
function susunAnalisis({ tanggal, insight, alert, perintah, data, penampung, logbook, heur }) {
  const lap = susunLaporan(insight, { alert, perintah });
  const n = insight.sensor.length;
  const tambahan = lap.ringkasan.slice(n);
  const barisAlert = tambahan.find((b) => b.startsWith('Alert:'));
  const barisAlat = tambahan.find((b) => b.startsWith('Aktivitas alat'));
  const prioritas = hitungPrioritas(heur, insight, Number(alert?.kritis) || 0);
  const saran = [...new Set([...(heur?.keputusan ? [`${heur.keputusan}.`] : []), ...lap.tindak_lanjut, SARAN_TETAP])];

  const bagian = [
    { judul: 'Kondisi sensor terkini', butir: bagianTerkini(insight, data) },
    { judul: 'Sensor 24 jam terakhir', butir: lap.ringkasan.slice(0, n) },
    { judul: 'Anomali', butir: bagianAnomali(insight) },
    { judul: 'Alert', butir: bagianAlert(barisAlert, data.alert) },
    { judul: 'Tahap tanam & panen', butir: bagianTahap(data.tahap, data.panen) },
    { judul: 'Penampung', butir: bagianPenampung(penampung) },
    { judul: 'Aktivitas alat 24 jam', butir: [barisAlat || 'Aktivitas alat tidak tersedia.'] },
    { judul: 'Logbook 7 hari', butir: bagianLogbook(logbook) },
    { judul: 'Saran', butir: saran },
  ];
  const judul = `Analisis harian ${tanggal}`;
  const ringkasan = `${heur?.keputusan || 'Pantau kondisi kebun'}${insight.real_time ? '' : ' (data sensor tidak terkini)'}.`;
  return {
    tanggal, judul, sumber: 'deterministik', sifat: 'rekomendasi', prioritas,
    ringkasan_utama: ringkasan,
    bagian,
    teks: [judul, ringkasan, ...bagian.flatMap((b) => ['', `${b.judul}:`, ...b.butir])].join('\n'),
  };
}

/** Kumpulkan data nyata (hanya SELECT) lalu susun. require di dalam fungsi: hindari require melingkar dengan routes/ai. */
async function kumpulDanSusun(tanggal) {
  const ai = require('./routes/ai');
  const { ambilLaporan } = require('./routes/aiInsights');
  const { logbookKebun } = require('./aiLogbook');
  const [lap, data, penampung, logbook] = await Promise.all([
    ambilLaporan('24j', null),
    ai.kumpulData({ id_tanaman: null, id_meja: null }),
    ai.konteksTambahan(),
    logbookKebun().catch(() => null),
  ]);
  return susunAnalisis({ tanggal, ...lap, data, penampung, logbook, heur: ai.heuristik(data) });
}

module.exports = { susunAnalisis, kumpulDanSusun, SARAN_TETAP };
