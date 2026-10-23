'use strict';
/**
 * Ringkasan PUBLIK untuk landing page — GET /api/publik/ringkasan (tanpa login).
 * Hanya angka agregat yang aman ditampilkan umum: jumlah meja/lubang, rata-rata sensor 6 jam,
 * tren 24 jam, total panen, status IoT. Tidak ada nama pengguna, IP, URL kamera, atau data mentah.
 */
const express = require('express');
const { q, one } = require('../db');
const cache = require('../cache');

const router = express.Router();

const num = (v, d = 2) => (v === null || v === undefined ? null : Number(Number(v).toFixed(d)));

router.get('/ringkasan', async (_req, res, next) => {
  try {
    const payload = await cache.remember('publik-ringkasan', 15_000, async () => {
      const [meja, tanaman, panen, avg, latest, alertBuka] = await Promise.all([
        one('SELECT count(*)::int AS meja, coalesce(sum(jumlah_lubang),0)::int AS lubang FROM mejas'),
        one('SELECT count(*)::int AS n FROM tanamen'),
        one('SELECT count(*)::int AS kali, coalesce(sum(panen_berhasil),0)::int AS berhasil, coalesce(sum(panen_gagal),0)::int AS gagal FROM panens'),
        one(`SELECT avg(ph) AS ph, avg(tds) AS tds, avg("waterTemp") AS suhu_air, avg("airTemp") AS suhu_udara,
                    avg(humidity) AS kelembapan, count(*)::int AS jumlah
             FROM monitorings WHERE created_at >= now() - interval '6 hours'`),
        one('SELECT created_at FROM monitorings ORDER BY created_at DESC LIMIT 1'),
        one("SELECT count(*)::int AS n FROM v_alert_terbuka").catch(() => ({ n: null })),
      ]);
      const tren = await q(`
        SELECT date_trunc('hour', created_at) AS jam, avg(ph) AS ph, avg(tds) AS tds, avg("waterTemp") AS suhu_air
        FROM monitorings WHERE created_at >= now() - interval '24 hours'
        GROUP BY 1 ORDER BY 1`);

      const detik = latest?.created_at ? Math.round((Date.now() - new Date(latest.created_at).getTime()) / 1000) : null;
      return {
        meja: meja.meja,
        lubang: meja.lubang,
        jenis_tanaman: tanaman.n,
        panen: { kali: panen.kali, berhasil: panen.berhasil, gagal: panen.gagal },
        alert_terbuka: alertBuka.n,
        iot: { online: detik !== null && detik <= 120, detik_lalu: detik },
        rata_6_jam: {
          ph: num(avg.ph), tds: num(avg.tds, 0), suhu_air: num(avg.suhu_air, 1),
          suhu_udara: num(avg.suhu_udara, 1), kelembapan: num(avg.kelembapan, 0), jumlah: avg.jumlah,
        },
        tren_24_jam: tren.map((t) => ({ jam: t.jam, ph: num(t.ph), tds: num(t.tds, 0), suhu_air: num(t.suhu_air, 1) })),
        diperbarui: new Date().toISOString(),
      };
    });
    res.set('Cache-Control', 'public, max-age=10');
    res.json(payload);
  } catch (e) { next(e); }
});

module.exports = router;
