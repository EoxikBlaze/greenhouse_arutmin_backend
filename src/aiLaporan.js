'use strict';
/**
 * Pembuat laporan monitoring GARAP AI — fungsi murni: insight (aiInsight.susunInsight) → laporan.
 * Semua angka berasal dari hitungan deterministik; kalimat dari templat, tanpa LLM.
 * Isi laporan berstatus REKOMENDASI pemeriksaan untuk operator, tidak pernah perintah alat.
 */
const JENIS = { '1j': 'per_jam', '24j': 'harian', '7h': 'mingguan' };
const KELENGKAPAN_MIN_PERSEN = 80;
const ANOMALI_PROBE = ['di_luar_wajar', 'lompatan', 'macet'];

const sat = (s) => (s.satuan ? ` ${s.satuan}` : '');
const rentang = (t) => `${t.min}–${t.max}`;

function kalimatTarget(s) {
  const { status, selisih } = s.terhadap_target;
  if (status === 'dalam') return `dalam target ${rentang(s.target)}`;
  if (status === 'di_bawah') return `di bawah target ${rentang(s.target)} (selisih ${selisih}${sat(s)})`;
  if (status === 'di_atas') return `di atas target ${rentang(s.target)} (selisih +${selisih}${sat(s)})`;
  return 'target belum diatur';
}

function kalimatSensor(s) {
  const st = s.statistik;
  if (st.n === 0) return `${s.label}: tidak ada data pada periode ini.`;
  const arah = st.arah === 'stabil'
    ? 'stabil'
    : `${st.arah} ${Math.abs(st.perubahan_persen)}% (${st.awal} → ${st.akhir}${sat(s)})`;
  return `${s.label}: rata-rata ${st.rata}${sat(s)} (min ${st.min}, maks ${st.maks}), ${arah}; ${kalimatTarget(s)}; kelengkapan data ${st.kelengkapan_persen}%.`;
}

function hitungAnomali(sensor) {
  const per = {};
  for (const s of sensor) for (const a of s.anomali) per[a.jenis] = (per[a.jenis] || 0) + 1;
  return { total: Object.values(per).reduce((a, b) => a + b, 0), per_jenis: per };
}

function tindakLanjutSensor(s, realTime) {
  const jenis = new Set(s.anomali.map((a) => a.jenis));
  const hasil = [];
  if (jenis.has('tanpa_data')) return [`${s.label}: tidak ada bacaan; periksa sensor dan kabelnya.`];
  if (ANOMALI_PROBE.some((j) => jenis.has(j))) {
    hasil.push(`${s.label}: ada bacaan tidak wajar (anomali data); periksa probe, kabel, dan kalibrasi sebelum menyimpulkan kondisi larutan.`);
  }
  if (jenis.has('jeda')) hasil.push(`${s.label}: ada selang tanpa data; periksa daya alat dan koneksi MQTT.`);
  const target = s.terhadap_target.status;
  // data basi bukan kondisi sekarang: jangan menyarankan koreksi larutan dari angka lama
  if (realTime && (target === 'di_bawah' || target === 'di_atas')) {
    hasil.push(`${s.label} ${s.statistik.akhir}${sat(s)} ${target === 'di_bawah' ? 'di bawah' : 'di atas'} target ${rentang(s.target)}; periksa larutan dan sensor, lalu bila perlu ajukan koreksi lewat alur persetujuan dosing.`);
  }
  if (s.statistik.kelengkapan_persen < KELENGKAPAN_MIN_PERSEN) {
    hasil.push(`${s.label}: kelengkapan data ${s.statistik.kelengkapan_persen}%; angka periode ini kurang mewakili.`);
  }
  return hasil;
}

function tindakLanjut(insight) {
  if (insight.umur_data_detik === null) return ['Tidak ada data sensor pada periode ini; periksa alat sensor dan koneksinya.'];
  const awal = insight.real_time
    ? []
    : [`Data terakhir ${Math.round(insight.umur_data_detik / 60)} menit lalu — bukan kondisi saat ini. Periksa alat sensor dan koneksi.`];
  return [...awal, ...insight.sensor.flatMap((s) => tindakLanjutSensor(s, insight.real_time))];
}

function kalimatTambahan({ alert, perintah }) {
  const hasil = [];
  if (alert) hasil.push(`Alert: ${alert.total} alert pada periode ini, ${alert.aktif} belum ditangani, ${alert.kritis} kritis.`);
  if (perintah && perintah.length) {
    hasil.push(`Aktivitas alat (semua perangkat): ${perintah.map((p) => `${p.tipe} ${p.status} ${p.jumlah}×`).join(', ')}.`);
  } else if (perintah) {
    hasil.push('Aktivitas alat (semua perangkat): tidak ada perintah tercatat.');
  }
  return hasil;
}

/**
 * @param {object} insight   keluaran aiInsight.susunInsight
 * @param {{alert?:{total:number,aktif:number,kritis:number}, perintah?:{tipe:string,status:string,jumlah:number}[]}} tambahan
 */
function susunLaporan(insight, tambahan = {}) {
  const ringkasan = [...insight.sensor.map(kalimatSensor), ...kalimatTambahan(tambahan)];
  const lanjut = tindakLanjut(insight);
  const judul = `Laporan monitoring ${insight.label_periode}`;
  return {
    jenis: JENIS[insight.periode],
    judul,
    periode: insight.periode,
    dari_ms: insight.dari_ms,
    sampai_ms: insight.sampai_ms,
    data_terakhir_ms: insight.data_terakhir_ms,
    real_time: insight.real_time,
    sumber: 'deterministik',
    sifat: 'rekomendasi',
    ringkasan,
    anomali: hitungAnomali(insight.sensor),
    tindak_lanjut: lanjut,
    teks: [judul, ...ringkasan, 'Tindak lanjut:', ...(lanjut.length ? lanjut : ['Tidak ada; lanjutkan pemantauan.'])].join('\n'),
  };
}

module.exports = { susunLaporan };
