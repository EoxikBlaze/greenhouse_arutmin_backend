'use strict';
/**
 * Laporan lengkap — GET /laporan/{batch|sensor|dosing|peringatan|kalibrasi} (?dari &sampai [&format=csv]).
 * Tiap laporan = {judul, kolom: [{kunci, label}], baris: [...]} supaya web dan CSV memakai bentuk yang sama.
 * Catatan data: alat hanya melaporkan JUMLAH dosing per hari (bukan mL), jadi laporan dosing memuat jumlah kali.
 */
const { q } = require('./db');
const { statusJadwal } = require('./routes/kalibrasi');

const MAKS_HARI = 92;
const hariMs = 86_400_000;

/** [awal, akhir) UTC dari ?dari/?sampai; bawaan 30 hari terakhir; dibatasi MAKS_HARI. */
function rentangLaporan({ dari, sampai } = {}, sekarang = new Date()) {
  const akhir = new Date((sampai ? Date.parse(`${sampai}T00:00:00Z`) : sekarang.getTime() - (sekarang.getTime() % hariMs)) + hariMs);
  let awal = dari ? new Date(`${dari}T00:00:00Z`) : new Date(akhir.getTime() - 30 * hariMs);
  const batasan = akhir.getTime() - MAKS_HARI * hariMs;
  const terpotong = awal.getTime() < batasan;
  if (terpotong) awal = new Date(batasan);
  return { awal: awal.toISOString(), akhir: akhir.toISOString(), terpotong };
}

const pembulatan = (v, d = 2) => (v == null ? null : Math.round(Number(v) * 10 ** d) / 10 ** d);

async function laporanBatch(r) {
  const baris = await q(
    `SELECT s.id_semai, t.nama_tanaman AS tanaman, m.meja, s.tgl_awal_semai AS mulai, s.status,
            s.jumlah_benih, s.benih_berhasil, s.benih_gagal,
            per.tgl_awal_peremajaan AS peremajaan, de.tgl_awal_pendewasaan AS pendewasaan,
            pa.tgl_panen AS panen, pa.panen_berhasil, pa.panen_gagal,
            (coalesce(pa.tgl_panen::date, current_date) - s.tgl_awal_semai::date) AS hari,
            st.n_baca, st.ppm_rata, st.ppm_min, st.ppm_maks, st.ph_rata, st.ph_min, st.ph_maks,
            dk.ab, dk.ph, dk.encer, dk.isi, pr.peringatan
       FROM semais s
       LEFT JOIN tanamen t ON t.id_tanaman = s.id_tanaman
       LEFT JOIN mejas m ON m.id_meja = s.id_meja
       LEFT JOIN LATERAL (SELECT * FROM peremajaans WHERE id_semai = s.id_semai ORDER BY id_peremajaan LIMIT 1) per ON true
       LEFT JOIN LATERAL (SELECT * FROM pendewasaans WHERE id_peremajaan = per.id_peremajaan ORDER BY id_pendewasaan LIMIT 1) de ON true
       LEFT JOIN LATERAL (SELECT * FROM panens WHERE id_pendewasaan = de.id_pendewasaan ORDER BY id_panen LIMIT 1) pa ON true
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS n_baca, avg(x.tds) AS ppm_rata, min(x.tds) AS ppm_min, max(x.tds) AS ppm_maks,
                avg(x.ph) AS ph_rata, min(x.ph) AS ph_min, max(x.ph) AS ph_maks
           FROM monitorings x
          WHERE x.created_at >= s.tgl_awal_semai AND x.created_at < coalesce(pa.tgl_panen::timestamp + interval '1 day', now())
            AND (x.id_meja = s.id_meja OR x.id_meja IS NULL)) st ON true
       LEFT JOIN LATERAL (
         SELECT count(*) FILTER (WHERE d.jenis = 'AB')::int AS ab, count(*) FILTER (WHERE d.jenis = 'PH')::int AS ph,
                count(*) FILTER (WHERE d.jenis = 'ENCER')::int AS encer, count(*) FILTER (WHERE d.jenis = 'ISI')::int AS isi
           FROM dosing_kejadian d
          WHERE d.terjadi_pada >= s.tgl_awal_semai AND d.terjadi_pada < coalesce(pa.tgl_panen::timestamp + interval '1 day', now())
            AND (d.id_meja = s.id_meja OR d.id_meja IS NULL)) dk ON true
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS peringatan FROM alert_logs a
          WHERE a.created_at >= s.tgl_awal_semai AND a.created_at < coalesce(pa.tgl_panen::timestamp + interval '1 day', now())
            AND (a.id_meja = s.id_meja OR a.id_meja IS NULL)) pr ON true
      WHERE s.tgl_awal_semai >= $1 AND s.tgl_awal_semai < $2
      ORDER BY s.tgl_awal_semai DESC, s.id_semai DESC`, [r.awal, r.akhir]);
  return {
    judul: 'Laporan per batch',
    kolom: [
      ['id_semai', 'Batch'], ['tanaman', 'Tanaman'], ['meja', 'Meja'], ['mulai', 'Mulai semai'], ['peremajaan', 'Peremajaan'],
      ['pendewasaan', 'Pendewasaan'], ['panen', 'Panen'], ['hari', 'Lama (hari)'], ['status', 'Status'],
      ['jumlah_benih', 'Benih'], ['benih_berhasil', 'Benih berhasil'], ['benih_gagal', 'Benih gagal'],
      ['panen_berhasil', 'Panen berhasil'], ['panen_gagal', 'Panen gagal'],
      ['ppm_rata', 'ppm rata-rata'], ['ppm_min', 'ppm min'], ['ppm_maks', 'ppm maks'],
      ['ph_rata', 'pH rata-rata'], ['ph_min', 'pH min'], ['ph_maks', 'pH maks'],
      ['ab', 'Dosing A+B'], ['ph', 'Koreksi pH'], ['encer', 'Pengenceran'], ['isi', 'Isi air'], ['peringatan', 'Peringatan'],
    ].map(([kunci, label]) => ({ kunci, label })),
    baris: baris.map((b) => ({ ...b, ppm_rata: pembulatan(b.ppm_rata, 0), ppm_min: pembulatan(b.ppm_min, 0), ppm_maks: pembulatan(b.ppm_maks, 0),
      ph_rata: pembulatan(b.ph_rata), ph_min: pembulatan(b.ph_min), ph_maks: pembulatan(b.ph_maks) })),
  };
}

async function laporanSensor(r) {
  const amb = Object.fromEntries((await q("SELECT sensor, min, max FROM sensor_thresholds WHERE sensor IN ('ph','tds','waterTemp')")).map((a) => [a.sensor, a]));
  const b = (k) => [Number(amb[k]?.min ?? -1e9), Number(amb[k]?.max ?? 1e9)];
  const [phA, phB] = b('ph'); const [tdA, tdB] = b('tds'); const [tmA, tmB] = b('waterTemp');
  const baris = await q(
    `SELECT (created_at AT TIME ZONE 'UTC')::date AS hari, count(*)::int AS n_baca,
            avg(ph) AS ph_rata, min(ph) AS ph_min, max(ph) AS ph_maks,
            avg(tds) AS ppm_rata, min(tds) AS ppm_min, max(tds) AS ppm_maks,
            avg("waterTemp") AS suhu_air_rata, min("waterTemp") AS suhu_air_min, max("waterTemp") AS suhu_air_maks,
            avg("airTemp") AS suhu_udara_rata, avg(humidity) AS lembap_rata,
            100.0 * count(*) FILTER (WHERE ph BETWEEN $3 AND $4) / NULLIF(count(ph), 0) AS ph_aman_persen,
            100.0 * count(*) FILTER (WHERE tds BETWEEN $5 AND $6) / NULLIF(count(tds), 0) AS ppm_aman_persen,
            100.0 * count(*) FILTER (WHERE "waterTemp" BETWEEN $7 AND $8) / NULLIF(count("waterTemp"), 0) AS suhu_aman_persen
       FROM monitorings WHERE created_at >= $1 AND created_at < $2
      GROUP BY 1 ORDER BY 1 DESC`, [r.awal, r.akhir, phA, phB, tdA, tdB, tmA, tmB]);
  const d = (v, n = 2) => pembulatan(v, n);
  return {
    judul: 'Laporan sensor harian',
    catatan: 'Persen aman memakai Ambang Sensor (bukan batas resep batch).',
    kolom: [
      ['hari', 'Tanggal'], ['n_baca', 'Jumlah bacaan'], ['ph_rata', 'pH rata-rata'], ['ph_min', 'pH min'], ['ph_maks', 'pH maks'],
      ['ppm_rata', 'ppm rata-rata'], ['ppm_min', 'ppm min'], ['ppm_maks', 'ppm maks'],
      ['suhu_air_rata', 'Suhu air rata-rata'], ['suhu_air_min', 'Suhu air min'], ['suhu_air_maks', 'Suhu air maks'],
      ['suhu_udara_rata', 'Suhu udara rata-rata'], ['lembap_rata', 'Kelembapan rata-rata'],
      ['ph_aman_persen', 'pH aman (%)'], ['ppm_aman_persen', 'ppm aman (%)'], ['suhu_aman_persen', 'Suhu air aman (%)'],
    ].map(([kunci, label]) => ({ kunci, label })),
    baris: baris.map((x) => ({
      ...x, ph_rata: d(x.ph_rata), ph_min: d(x.ph_min), ph_maks: d(x.ph_maks), ppm_rata: d(x.ppm_rata, 0), ppm_min: d(x.ppm_min, 0), ppm_maks: d(x.ppm_maks, 0),
      suhu_air_rata: d(x.suhu_air_rata, 1), suhu_air_min: d(x.suhu_air_min, 1), suhu_air_maks: d(x.suhu_air_maks, 1),
      suhu_udara_rata: d(x.suhu_udara_rata, 1), lembap_rata: d(x.lembap_rata, 0),
      ph_aman_persen: d(x.ph_aman_persen, 0), ppm_aman_persen: d(x.ppm_aman_persen, 0), suhu_aman_persen: d(x.suhu_aman_persen, 0),
    })),
  };
}

async function laporanDosing(r) {
  const baris = await q(
    `SELECT (terjadi_pada AT TIME ZONE 'UTC')::date AS hari,
            count(*) FILTER (WHERE jenis = 'AB')::int AS ab, count(*) FILTER (WHERE jenis = 'PH')::int AS ph,
            count(*) FILTER (WHERE jenis = 'ENCER')::int AS encer, count(*) FILTER (WHERE jenis = 'ISI')::int AS isi,
            count(*)::int AS total
       FROM dosing_kejadian WHERE terjadi_pada >= $1 AND terjadi_pada < $2 GROUP BY 1 ORDER BY 1 DESC`, [r.awal, r.akhir]);
  return {
    judul: 'Laporan dosing dan air',
    catatan: 'Jumlah tindakan yang dilakukan alat per hari. Alat tidak melaporkan volume (mL).',
    kolom: [['hari', 'Tanggal'], ['ab', 'Dosing A+B'], ['ph', 'Koreksi pH'], ['encer', 'Pengenceran'], ['isi', 'Isi air'], ['total', 'Total']]
      .map(([kunci, label]) => ({ kunci, label })),
    baris,
  };
}

async function laporanPeringatan(r) {
  const baris = await q(
    `SELECT type AS jenis, max(severity) AS tingkat, count(*)::int AS jumlah,
            count(*) FILTER (WHERE selesai_pada IS NULL)::int AS masih_terbuka,
            round(avg(extract(epoch FROM selesai_pada - created_at) / 60) FILTER (WHERE selesai_pada IS NOT NULL))::int AS rata_menit,
            round(max(extract(epoch FROM selesai_pada - created_at) / 60) FILTER (WHERE selesai_pada IS NOT NULL))::int AS terlama_menit,
            max(created_at) AS terakhir
       FROM alert_logs WHERE created_at >= $1 AND created_at < $2 GROUP BY type ORDER BY count(*) DESC, type`, [r.awal, r.akhir]);
  return {
    judul: 'Laporan peringatan',
    kolom: [['jenis', 'Jenis'], ['tingkat', 'Tingkat'], ['jumlah', 'Jumlah'], ['masih_terbuka', 'Masih terbuka'],
      ['rata_menit', 'Rata-rata lama (menit)'], ['terlama_menit', 'Terlama (menit)'], ['terakhir', 'Terakhir']].map(([kunci, label]) => ({ kunci, label })),
    baris,
  };
}

async function laporanKalibrasi(r) {
  const baris = await q(
    `SELECT k.sensor, k.terakhir_dikalibrasi, k.periode_hari_min, k.periode_hari_max,
            (SELECT count(*)::int FROM kalibrasi_log l WHERE l.sensor = k.sensor AND l.dilakukan_pada >= $1 AND l.dilakukan_pada < $2) AS jumlah
       FROM kalibrasi_sensor k WHERE k.sensor IN ('ph', 'ec', 'pulsa_peristaltik') ORDER BY k.sensor`, [r.awal, r.akhir]);
  const nama = { ph: 'Sensor pH', ec: 'Sensor EC', pulsa_peristaltik: 'Laju pompa' };
  const label = { terlambat: 'Terlambat', segera: 'Segera', aman: 'Aman', belum: 'Belum pernah', tanpa_jadwal: 'Tanpa jadwal' };
  return {
    judul: 'Laporan kalibrasi',
    kolom: [['alat', 'Alat'], ['status', 'Status'], ['terakhir', 'Terakhir dikalibrasi'], ['jatuh_tempo', 'Jatuh tempo'], ['jumlah', 'Kalibrasi dalam periode']]
      .map(([kunci, l]) => ({ kunci, label: l })),
    baris: baris.map((b) => {
      const s = statusJadwal(b);
      return { alat: nama[b.sensor] ?? b.sensor, status: label[s.status], terakhir: b.terakhir_dikalibrasi, jatuh_tempo: s.jatuh_tempo, jumlah: b.jumlah };
    }),
  };
}

const LAPORAN = { batch: laporanBatch, sensor: laporanSensor, dosing: laporanDosing, peringatan: laporanPeringatan, kalibrasi: laporanKalibrasi };

module.exports = { LAPORAN, rentangLaporan, MAKS_HARI };
