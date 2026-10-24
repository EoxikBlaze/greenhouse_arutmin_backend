'use strict';
/** Dashboard — GET /dashboard (payload mengikuti DashboardController Laravel). */
const express = require('express');
const { q, one } = require('../db');
const cache = require('../cache');
const { thresholdsMap } = require('./monitoring');

const router = express.Router();

router.get('/', async (_req, res, next) => {
  try {
    // cache 5 detik — dashboard di-refresh polling; DB dihajar sekali / 5 dtk
    const payload = await cache.remember('dashboard', 5_000, async () => {
    const latest = await one('SELECT * FROM monitorings ORDER BY created_at DESC LIMIT 1');
    const avg = await one(`
      SELECT round(avg("waterTemp")::numeric,2) AS "waterTemp", round(avg(ph)::numeric,2) AS ph,
             round(avg(tds)::numeric,2) AS tds, round(avg("airTemp")::numeric,2) AS "airTemp",
             round(avg(humidity)::numeric,2) AS humidity, count(*) AS jumlah
      FROM monitorings WHERE created_at >= now() - interval '6 hours'`);
    const wc = await one('SELECT * FROM water_controls ORDER BY id LIMIT 1');
    const alerts = await q('SELECT * FROM alert_logs ORDER BY created_at DESC LIMIT 5');

    const [tanaman, meja, siklus, semai, peremajaan, pendewasaan, panen, panenQty] = await Promise.all([
      one('SELECT count(*)::int AS n FROM tanamen'),
      one('SELECT count(*)::int AS n FROM mejas'),
      one('SELECT count(*)::int AS n FROM sikluses'),
      one("SELECT count(*)::int AS n FROM semais"),
      one('SELECT count(*)::int AS n FROM peremajaans'),
      one('SELECT count(*)::int AS n FROM pendewasaans'),
      one('SELECT count(*)::int AS n FROM panens'),
      one('SELECT coalesce(sum(panen_berhasil),0)::int AS n FROM panens'),
    ]);
    const [semaiAktif, peremajaanAktif, pendewasaanAktif] = await Promise.all([
      one("SELECT count(*)::int AS n FROM semais WHERE status = 'proses'"),
      one("SELECT count(*)::int AS n FROM peremajaans WHERE status = 'proses'"),
      one("SELECT count(*)::int AS n FROM pendewasaans WHERE status = 'proses'"),
    ]);

    let iotStatus = { online: false, seconds_ago: null, diff_text: 'Belum pernah ada data', last_seen: null };
    if (latest?.created_at) {
      const secondsAgo = Math.round((Date.now() - new Date(latest.created_at).getTime()) / 1000);
      iotStatus = {
        online: secondsAgo <= 120,
        seconds_ago: secondsAgo,
        diff_text: `${secondsAgo} detik yang lalu`,
        last_seen: latest.created_at,
      };
    }

    const recentPanen = await q(`
      SELECT p.*, tm.nama_tanaman
      FROM panens p
      LEFT JOIN pendewasaans pd ON pd.id_pendewasaan = p.id_pendewasaan
      LEFT JOIN peremajaans pr ON pr.id_peremajaan = pd.id_peremajaan
      LEFT JOIN semais s ON s.id_semai = pr.id_semai
      LEFT JOIN tanamen tm ON tm.id_tanaman = s.id_tanaman
      ORDER BY p.tgl_panen DESC LIMIT 5`);

    return {
      page: 'dashboard',
      iotStatus,
      total_tanaman: tanaman.n, total_meja: meja.n, total_siklus: siklus.n,
      total_semai: semai.n, total_peremajaan: peremajaan.n, total_pendewasaan: pendewasaan.n,
      total_panen: panen.n, total_panen_qty: panenQty.n,
      semai_aktif: semaiAktif.n, peremajaan_aktif: peremajaanAktif.n, pendewasaan_aktif: pendewasaanAktif.n,
      latest_sensor: latest,
      sensor_avg: avg,
      water_control: wc,
      recent_alerts: alerts,
      recent_panen: recentPanen,
      // batas aman sensor (tabel sensor_thresholds) — dulu web menulis target tetap di kode
      ambang: await thresholdsMap(),
    };
    });
    res.json(payload);
  } catch (e) { next(e); }
});

module.exports = router;
