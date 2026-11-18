'use strict';
/**
 * GET /api/ai/insights?periode=1j|24j|7h&id_meja=<angka>
 * GET /api/ai/laporan?jenis=harian|mingguan&id_meja=<angka>
 * Statistik + anomali data monitoring, dihitung deterministik (tanpa LLM). Hanya SELECT.
 * Dipasang di dalam routes/ai.js sesudah guard requireAuth + aiRole.
 */
const express = require('express');
const { q, one } = require('../db');
const { susunInsight, PERIODE } = require('../aiInsight');
const { susunLaporan } = require('../aiLaporan');

const router = express.Router();
const JENIS_LAPORAN = { harian: '24j', mingguan: '7h' };
const MAKS_BARIS = 20_000; // 24 jam @5 dtk = 17.280 baris
const KOLOM = 'ph, tds, "waterTemp", "airTemp", humidity';
const KOLOM_RATA = 'avg(ph) AS ph, avg(tds) AS tds, avg("waterTemp") AS "waterTemp", avg("airTemp") AS "airTemp", avg(humidity) AS humidity';
const SARING = `created_at >= LOCALTIMESTAMP - make_interval(secs => $1) AND ($2::bigint IS NULL OR id_meja = $2::bigint)`;

function ambilBaris(p, idMeja) {
  const params = [p.detik, idMeja, MAKS_BARIS];
  if (p.resolusiDetik <= 5) {
    return q(`SELECT (EXTRACT(EPOCH FROM created_at) * 1000)::float8 AS t, ${KOLOM}
                FROM monitorings WHERE ${SARING} ORDER BY created_at LIMIT $3`, params);
  }
  return q(`SELECT (floor(EXTRACT(EPOCH FROM created_at) / ${Number(p.resolusiDetik)}) * ${Number(p.resolusiDetik)} * 1000)::float8 AS t, ${KOLOM_RATA}
              FROM monitorings WHERE ${SARING} GROUP BY 1 ORDER BY 1 LIMIT $3`, params);
}

/** Validasi query bersama. Mengembalikan { periode, idMeja } atau null bila 422 sudah dikirim. */
function bacaQuery(req, res, periode) {
  const mentahMeja = req.query.id_meja;
  const errors = {};
  if (!Object.hasOwn(PERIODE, periode)) errors.periode = [`Pilih salah satu: ${Object.keys(PERIODE).join(', ')}.`];
  if (mentahMeja !== undefined && !/^\d{1,9}$/.test(String(mentahMeja))) errors.id_meja = ['Harus berupa angka.'];
  if (Object.keys(errors).length) {
    res.status(422).json({ message: 'Data tidak valid.', errors });
    return null;
  }
  return { periode, idMeja: mentahMeja === undefined ? null : Number(mentahMeja) };
}

async function ambilInsight(periode, idMeja) {
  const [baris, kini, ambangRows] = await Promise.all([
    ambilBaris(PERIODE[periode], idMeja),
    // jam DB, kerangka yang sama dengan created_at (timestamp tanpa zona)
    one('SELECT (EXTRACT(EPOCH FROM LOCALTIMESTAMP) * 1000)::float8 AS ms'),
    q('SELECT sensor, min, max FROM sensor_thresholds'),
  ]);
  const ambang = Object.fromEntries(ambangRows.map((r) => [r.sensor, { min: r.min, max: r.max }]));
  return susunInsight(baris, { periode, sekarangMs: Number(kini.ms), ambang });
}

/** Bahan laporan: insight + ringkasan alert + aktivitas alat pada periode itu (hanya SELECT). */
async function ambilLaporan(periode, idMeja) {
  const P = [PERIODE[periode].detik, idMeja];
  const [insight, alert, perintah] = await Promise.all([
    ambilInsight(periode, idMeja),
    one(`SELECT count(*)::int AS total, count(*) FILTER (WHERE acknowledged IS NOT TRUE)::int AS aktif,
                count(*) FILTER (WHERE severity = 'critical')::int AS kritis
           FROM alert_logs WHERE ${SARING}`, P),
    // perintah_aktuator tidak punya id_meja: dilaporkan untuk semua perangkat
    q(`SELECT tipe, status, count(*)::int AS jumlah FROM perintah_aktuator
        WHERE dibuat_pada >= LOCALTIMESTAMP - make_interval(secs => $1)
        GROUP BY tipe, status ORDER BY tipe, status LIMIT 50`, [P[0]]),
  ]);
  return { insight, alert, perintah };
}

router.get('/insights', async (req, res, next) => {
  try {
    const v = bacaQuery(req, res, String(req.query.periode || '24j'));
    if (!v) return undefined;
    return res.json({ status: true, sumber: 'deterministik', id_meja: v.idMeja, ...(await ambilInsight(v.periode, v.idMeja)) });
  } catch (e) { return next(e); }
});

/** GET /api/ai/laporan?jenis=harian|mingguan&id_meja=<angka> — laporan templat, tanpa LLM. */
router.get('/laporan', async (req, res, next) => {
  try {
    const jenis = String(req.query.jenis || 'harian');
    if (!Object.hasOwn(JENIS_LAPORAN, jenis)) {
      return res.status(422).json({ message: 'Data tidak valid.', errors: { jenis: [`Pilih salah satu: ${Object.keys(JENIS_LAPORAN).join(', ')}.`] } });
    }
    const v = bacaQuery(req, res, JENIS_LAPORAN[jenis]);
    if (!v) return undefined;
    const { insight, alert, perintah } = await ambilLaporan(v.periode, v.idMeja);
    return res.json({ status: true, id_meja: v.idMeja, ...susunLaporan(insight, { alert, perintah }) });
  } catch (e) { return next(e); }
});

module.exports = router;
module.exports.ambilLaporan = ambilLaporan;
