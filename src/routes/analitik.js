'use strict';
/**
 * Analitik — mount: app.use('/api/analitik', semuaRole, analitik).
 *   GET /prediksi-panen                 batch berjalan + perkiraan tanggal panen
 *   GET /saran-dosis?jam=6              saran teks dari tren pH/TDS (TIDAK mengeksekusi apa pun)
 *   GET /ringkasan?dari=&sampai=        data laporan periode (dipakai halaman Laporan PDF mobile)
 *   GET /ekspor/{sensor|peringatan|panen}.csv?dari=&sampai=
 * Semua GET, hanya baca. Tanggal divalidasi sebelum SQL (pola laporan.js).
 */
const express = require('express');
const { q, one } = require('../db');
const { queryParam } = require('./_id');
const { tanggalErrors } = require('./_validate');
const A = require('../analitik');

const router = express.Router();

const BATAS_BARIS_CSV = 50_000;
const JAM_BAWAAN = 6;
const JAM_MAKS = 72;
const JENDELA_TREN_JAM = 6;

const DURASI = (tipe) => `(SELECT k.waktu_siklus FROM sikluses k
   WHERE k.id_tanaman = t.id_tanaman AND lower(k.nama_siklus) = '${tipe}' ORDER BY k.id_siklus LIMIT 1)`;

const BATCH_SQL = ['semai', 'peremajaan', 'pendewasaan'].map((tipe) => {
  const m = {
    semai: ['semais s', 's', 'id_semai', 'tgl_awal_semai', 's.id_tanaman', ''],
    peremajaan: ['peremajaans s', 's', 'id_peremajaan', 'tgl_awal_peremajaan', 'sm.id_tanaman', 'LEFT JOIN semais sm ON sm.id_semai = s.id_semai'],
    pendewasaan: ['pendewasaans s', 's', 'id_pendewasaan', 'tgl_awal_pendewasaan', 'sm.id_tanaman',
      'LEFT JOIN peremajaans pm ON pm.id_peremajaan = s.id_peremajaan LEFT JOIN semais sm ON sm.id_semai = pm.id_semai'],
  }[tipe];
  const [dari, , pk, awal, tanamanCol, join] = m;
  return `SELECT '${tipe}'::text AS tipe, s.${pk} AS id, s.${awal} AS mulai, ${tanamanCol} AS id_tanaman,
            t.nama_tanaman AS varietas, mj.meja, s.id_meja, ${DURASI(tipe)} AS dur_ini
          FROM ${dari} ${join}
          LEFT JOIN tanamen t ON t.id_tanaman = ${tanamanCol}
          LEFT JOIN mejas mj ON mj.id_meja = s.id_meja
          WHERE s.status = 'proses'`;
});

async function durasiTanaman(idTanaman) {
  const rows = await q(
    `SELECT lower(nama_siklus) AS nama, waktu_siklus FROM sikluses WHERE id_tanaman = $1 ORDER BY id_siklus`, [idTanaman]);
  const d = {};
  for (const r of rows) if (!(r.nama in d)) d[r.nama] = r.waktu_siklus;
  return d;
}

async function prediksiSemuaBatch() {
  const batch = (await Promise.all(BATCH_SQL.map((sql) => q(sql)))).flat();
  const cache = new Map();
  const hasil = [];
  for (const b of batch) {
    if (!cache.has(b.id_tanaman)) cache.set(b.id_tanaman, await durasiTanaman(b.id_tanaman));
    const p = A.prediksiPanen({ tipe: b.tipe, mulai: b.mulai }, cache.get(b.id_tanaman));
    hasil.push({ tipe: b.tipe, id: b.id, varietas: b.varietas, meja: b.meja, mulai: b.mulai, prediksi: p });
  }
  return hasil.sort((a, b) => (a.prediksi?.sisa_hari ?? Infinity) - (b.prediksi?.sisa_hari ?? Infinity));
}

router.get('/prediksi-panen', async (_req, res, next) => {
  try {
    const list = await prediksiSemuaBatch();
    res.json({ status: true, list, tanpa_prediksi: list.filter((b) => !b.prediksi).length });
  } catch (e) { next(e); }
});

router.get('/saran-dosis', async (req, res, next) => {
  try {
    const jam = Math.min(JAM_MAKS, Math.max(1, Number(req.query.jam) || JAM_BAWAAN));
    const [ambangRows, titik] = await Promise.all([
      q(`SELECT sensor, min, max FROM sensor_thresholds WHERE sensor IN ('ph','tds')`),
      q(`SELECT ph, tds, created_at FROM monitorings
          WHERE created_at >= now() - ($1::int * interval '1 hour') ORDER BY created_at ASC LIMIT 5000`, [jam]),
    ]);
    const ambang = Object.fromEntries(ambangRows.map((r) => [r.sensor, r]));
    const saran = ['ph', 'tds'].map((s) => {
      const seri = titik.filter((r) => r[s] !== null).map((r) => ({ t: new Date(r.created_at).getTime(), v: Number(r[s]) }));
      const nilai = seri.length ? seri[seri.length - 1].v : NaN;
      return A.saranSensor(s, nilai, A.tren(seri), ambang[s], JENDELA_TREN_JAM);
    });
    res.json({
      status: true, jendela_jam: jam, jumlah_bacaan: titik.length, saran,
      catatan: 'Saran saja. Tidak ada dosis yang dijalankan; koreksi nutrisi tetap lewat alur persetujuan dosing.',
    });
  } catch (e) { next(e); }
});

function rentang(req, res) {
  const dari = queryParam(req.query, 'dari');
  const sampai = queryParam(req.query, 'sampai');
  const errors = tanggalErrors(dari, sampai);
  if (Object.keys(errors).length) {
    res.status(422).json({ message: 'Data tidak valid.', errors });
    return null;
  }
  return { dari: dari || null, sampai: sampai || null };
}

router.get('/ringkasan', async (req, res, next) => {
  try {
    const r = rentang(req, res); if (!r) return;
    const P = [r.dari, r.sampai];
    const WAKTU = `($1::date IS NULL OR created_at >= $1::date) AND ($2::date IS NULL OR created_at < $2::date + 1)`;
    const [sensor, alert, panen, tanam, prediksi] = await Promise.all([
      one(`SELECT count(*)::int AS bacaan, round(avg(ph)::numeric,2) AS ph_rata, min(ph) AS ph_min, max(ph) AS ph_maks,
                  round(avg(tds)::numeric,0) AS tds_rata, min(tds) AS tds_min, max(tds) AS tds_maks,
                  round(avg("waterTemp")::numeric,1) AS suhu_air_rata
             FROM monitorings WHERE ${WAKTU}`, P),
      one(`SELECT count(*)::int AS total, count(*) FILTER (WHERE acknowledged IS NOT TRUE)::int AS aktif,
                  count(*) FILTER (WHERE severity = 'critical')::int AS kritis
             FROM alert_logs WHERE ${WAKTU}`, P),
      one(`SELECT coalesce(sum(panen_berhasil),0)::int AS berhasil, coalesce(sum(panen_gagal),0)::int AS gagal,
                  count(*)::int AS kali
             FROM panens WHERE ($1::date IS NULL OR tgl_panen >= $1::date) AND ($2::date IS NULL OR tgl_panen <= $2::date)`, P),
      one(`SELECT count(*)::int AS semai_baru FROM semais
            WHERE ($1::date IS NULL OR tgl_awal_semai >= $1::date) AND ($2::date IS NULL OR tgl_awal_semai <= $2::date)`, P),
      prediksiSemuaBatch(),
    ]);
    res.json({
      status: true, dari: r.dari, sampai: r.sampai, dibuat: new Date().toISOString(),
      sensor, alert, panen, tanam, batch_berjalan: prediksi.slice(0, 20),
    });
  } catch (e) { next(e); }
});

const EKSPOR = {
  sensor: {
    kolom: ['waktu', 'ph', 'tds_ppm', 'suhu_air_c', 'suhu_udara_c', 'kelembapan_persen', 'level_air'],
    sql: `SELECT created_at AS waktu, ph, tds AS tds_ppm, "waterTemp" AS suhu_air_c, "airTemp" AS suhu_udara_c,
                 humidity AS kelembapan_persen, water_level AS level_air
            FROM monitorings
           WHERE ($1::date IS NULL OR created_at >= $1::date) AND ($2::date IS NULL OR created_at < $2::date + 1)
           ORDER BY created_at DESC LIMIT ${BATAS_BARIS_CSV}`,
  },
  peringatan: {
    kolom: ['waktu', 'jenis', 'keterangan', 'tingkat', 'sudah_ditangani'],
    sql: `SELECT created_at AS waktu, type AS jenis, value AS keterangan, severity AS tingkat, acknowledged AS sudah_ditangani
            FROM alert_logs
           WHERE ($1::date IS NULL OR created_at >= $1::date) AND ($2::date IS NULL OR created_at < $2::date + 1)
           ORDER BY created_at DESC LIMIT ${BATAS_BARIS_CSV}`,
  },
  panen: {
    kolom: ['tgl_panen', 'berhasil', 'gagal', 'keterangan'],
    sql: `SELECT tgl_panen, panen_berhasil AS berhasil, panen_gagal AS gagal, keterangan
            FROM panens
           WHERE ($1::date IS NULL OR tgl_panen >= $1::date) AND ($2::date IS NULL OR tgl_panen <= $2::date)
           ORDER BY tgl_panen DESC LIMIT ${BATAS_BARIS_CSV}`,
  },
};

router.get('/ekspor/:jenis.csv', async (req, res, next) => {
  try {
    const def = Object.hasOwn(EKSPOR, req.params.jenis) ? EKSPOR[req.params.jenis] : null;
    if (!def) return res.status(404).json({ message: 'Jenis ekspor tidak dikenal.' });
    const r = rentang(req, res); if (!r) return;
    const rows = await q(def.sql, [r.dari, r.sampai]);
    res.setHeader('Content-Type', 'text/csv; charset=UTF-8');
    res.setHeader('Content-Disposition',
      `attachment; filename="${req.params.jenis}-${r.dari || 'awal'}_${r.sampai || 'kini'}.csv"`);
    return res.send(A.keCsv(def.kolom, rows));
  } catch (e) { return next(e); }
});

module.exports = router;
