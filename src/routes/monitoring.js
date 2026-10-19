'use strict';
/**
 * Monitoring + endpoint ESP32.
 *   GET  /monitoring, /monitoring/chart-data, /monitoring/tarik, /monitoring/tarik/csv
 *   GET  /monitoring/getReport6Jam        (publik)
 *   POST /monitoring/saveSensor|saveAlert (kompatibilitas CI4 — X-API-KEY)
 *   GET  /api/latest-sensor               (publik — polling SPA)
 *   GET  /api/get-thresholds              (X-API-KEY)
 *   POST /api/save-sensor                 (X-API-KEY)
 *   POST /api/notif-hardware              (X-API-KEY)
 */
const express = require('express');
const { q, one } = require('../db');
const cache = require('../cache');
const { requireApiKey, requireAuth, json } = require('../auth');

const router = express.Router();
const api = express.Router();

/* ── helper ────────────────────────────────────────────────────────── */
async function thresholdsMap() {
  // ambang jarang berubah → cache 60 dtk (O(1) untuk mayoritas request)
  return cache.remember('thresholds', 60_000, async () => {
    const rows = await q('SELECT sensor, min, max FROM sensor_thresholds');
    const map = {};
    for (const r of rows) map[r.sensor] = { min: r.min, max: r.max };
    return map;
  });
}

function anomalies(sensor, th) {
  if (!sensor) return [];
  const out = [];
  for (const k of ['waterTemp', 'ph', 'tds', 'airTemp', 'humidity']) {
    const v = sensor[k];
    const t = th[k];
    if (v == null || !t) continue;
    if ((t.min != null && v < t.min) || (t.max != null && v > t.max)) {
      out.push({ sensor: k, value: v, min: t.min, max: t.max });
    }
  }
  return out;
}

async function latestSensorPayload() {
  // polling 1000 user → cache 2 detik (latency DB jadi O(1) untuk 99% request)
  return cache.remember('latest-sensor', 2_000, async () => {
    const latest = await one('SELECT * FROM monitorings ORDER BY created_at DESC LIMIT 1');
    const wc = await one('SELECT * FROM water_controls ORDER BY id LIMIT 1');
    const secondsAgo = latest?.created_at
      ? Math.round((Date.now() - new Date(latest.created_at).getTime()) / 1000)
      : null;
    return {
      is_online: secondsAgo != null && secondsAgo <= 120,
      seconds_ago: secondsAgo,
      anomalies: anomalies(latest, await thresholdsMap()),
      sensor: latest,
      water_control: wc
        ? { mode: wc.mode, valve_state: wc.valve_state, command: wc.command, updated_at: wc.updated_at }
        : null,
    };
  });
}

async function saveSensorRows(data) {
  // SATU round-trip CTE: anti-duplikat + simpan sensor + state katup + angkat
  // command pending lalu reset ke AUTO (kontrak Laravel dipertahankan).
  const rows = await q(`
    WITH last AS (
      SELECT "waterTemp", ph, tds, "airTemp", humidity, water_level
      FROM monitorings ORDER BY created_at DESC LIMIT 1
    ), ins AS (
      INSERT INTO monitorings ("waterTemp", ph, tds, "airTemp", humidity, water_level, created_at, updated_at)
      SELECT $1::numeric,$2::numeric,$3::numeric,$4::numeric,$5::numeric,$6::text, now(), now()
      WHERE NOT EXISTS (
        SELECT 1 FROM last WHERE
          "waterTemp" IS NOT DISTINCT FROM $1 AND ph IS NOT DISTINCT FROM $2 AND
          tds IS NOT DISTINCT FROM $3 AND "airTemp" IS NOT DISTINCT FROM $4 AND
          humidity IS NOT DISTINCT FROM $5 AND water_level IS NOT DISTINCT FROM $6
      )
      RETURNING id
    )
    UPDATE water_controls SET
      valve_state = CASE WHEN $7::text IS NULL THEN valve_state
                         WHEN upper($7) = 'ON' THEN 'ON' ELSE 'OFF' END,
      command = CASE
        WHEN mode = 'MANUAL' AND $7::text IS NOT NULL AND upper($7) = 'ON' THEN 'FORCE_STOP'
        WHEN command <> 'AUTO' THEN 'AUTO'
        ELSE command END,
      updated_at = now()
    RETURNING command, mode`,
    [data.waterTemp ?? null, data.ph ?? null, data.tds ?? null, data.airTemp ?? null,
     data.humidity ?? null, data.water_level ?? null, data.solenoid_state ?? null],
  );
  return rows[0]?.command ?? 'AUTO';
}

/* ── publik ────────────────────────────────────────────────────────── */
router.get('/getReport6Jam', async (_req, res, next) => {
  try {
    const sensor = await one(`
      SELECT round(avg("waterTemp")::numeric,2) AS "waterTemp", round(avg(ph)::numeric,2) AS ph,
             round(avg(tds)::numeric,2) AS tds, round(avg("airTemp")::numeric,2) AS "airTemp",
             round(avg(humidity)::numeric,2) AS humidity
      FROM monitorings WHERE created_at >= now() - interval '6 hours'`);
    const alerts = await q("SELECT * FROM alert_logs WHERE created_at >= now() - interval '6 hours' ORDER BY created_at DESC");
    res.json({ sensor, alerts });
  } catch (e) { next(e); }
});

// Guard SAMA dengan POST /api/save-sensor (:requireApiKey) — kedua rute kompatibilitas
// CI4 ini menulis data, jadi tidak boleh lagi menerima request anonim (BFLA: dulu
// anonim → 400 'No payload' / bahkan 200). Klien lama cukup menambah header X-API-KEY.
router.post('/saveSensor', requireApiKey, async (req, res, next) => {
  try {
    const data = req.body || {};
    if (!Object.keys(data).length) return json(res, 400, { status: 'error', message: 'No payload' });
    const command = await saveSensorRows(data);
    const mode = (await one('SELECT mode FROM water_controls ORDER BY id LIMIT 1'))?.mode ?? 'AUTO';
    res.json({ status: 'ok', command, mode, server_time: new Date().toISOString() });
  } catch (e) { next(e); }
});

router.post('/saveAlert', requireApiKey, async (req, res, next) => {
  try {
    const { type, value } = req.body || {};
    if (!type || value == null || String(value) === '') return json(res, 400, { status: 'error' });
    await q('INSERT INTO alert_logs (type, value, created_at, updated_at) VALUES ($1,$2, now(), now())', [type, String(value)]);
    res.json({ status: 'ok' });
  } catch (e) { next(e); }
});

/* ── terproteksi (web) ─────────────────────────────────────────────── */
router.get('/', requireAuth, async (_req, res, next) => {
  try { res.json({ page: 'monitoring' }); } catch (e) { next(e); }
});

router.get('/chart-data', requireAuth, async (_req, res, next) => {
  try {
    const rows = await q('SELECT * FROM monitorings ORDER BY created_at DESC LIMIT 288');
    res.json(rows.reverse());
  } catch (e) { next(e); }
});

router.get('/tarik', requireAuth, async (req, res, next) => {
  try {
    const { dari, sampai, per_page: perPage = 10 } = req.query;
    const allowed = [10, 25, 50, 100];
    const limit = allowed.includes(Number(perPage)) ? Number(perPage) : 10;
    const rows = await q(
      `SELECT * FROM monitorings
       WHERE ($1::timestamptz IS NULL OR created_at >= $1) AND ($2::timestamptz IS NULL OR created_at <= $2)
       ORDER BY created_at DESC LIMIT $3`,
      [dari || null, sampai || null, limit],
    );
    res.json({ dari, sampai, data: rows });
  } catch (e) { next(e); }
});

router.get('/tarik/csv', requireAuth, async (req, res, next) => {
  try {
    const { dari, sampai } = req.query;
    const rows = await q(
      `SELECT * FROM monitorings
       WHERE ($1::timestamptz IS NULL OR created_at >= $1) AND ($2::timestamptz IS NULL OR created_at <= $2)
       ORDER BY created_at DESC LIMIT 5000`,
      [dari || null, sampai || null],
    );
    const lines = ['WAKTU,SUHU AIR (C),PH,TDS (PPM),SUHU UDARA (C),KELEMBAPAN (%),LEVEL TANDON'];
    for (const r of rows) {
      lines.push([r.created_at, r.waterTemp, r.ph, r.tds, r.airTemp, r.humidity, r.water_level].join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=UTF-8');
    res.setHeader('Content-Disposition', 'attachment; filename="sensor.csv"');
    res.send('\uFEFF' + lines.join('\n'));
  } catch (e) { next(e); }
});

/* ── API ESP32 ─────────────────────────────────────────────────────── */
api.get('/latest-sensor', async (_req, res, next) => {
  try { res.json(await latestSensorPayload()); } catch (e) { next(e); }
});

api.get('/get-thresholds', requireApiKey, async (_req, res, next) => {
  try {
    const th = await thresholdsMap();
    const fallback = {
      waterTemp: { min: 20.0, max: 35.0 }, ph: { min: 5.5, max: 6.5 },
      tds: { min: 500.0, max: 1000.0 }, airTemp: { min: 20.0, max: 40.0 },
      humidity: { min: 50.0, max: 90.0 },
    };
    res.json({ status: true, thresholds: Object.keys(th).length ? th : fallback, fetched_at: new Date().toISOString() });
  } catch (e) { next(e); }
});

api.post('/save-sensor', requireApiKey, async (req, res, next) => {
  try {
    const data = req.body || {};
    if (!Object.keys(data).length) return json(res, 400, { status: 'error', message: 'No payload' });
    const command = await saveSensorRows(data);
    const mode = (await one('SELECT mode FROM water_controls ORDER BY id LIMIT 1'))?.mode ?? 'AUTO';
    res.json({ status: 'ok', command, mode, server_time: new Date().toISOString() });
  } catch (e) { next(e); }
});

api.post('/notif-hardware', requireApiKey, async (req, res, next) => {
  try {
    const { type, value } = req.body || {};
    if (type == null || String(type).trim() === '' || value == null || String(value).trim() === '') {
      return json(res, 400, { status: false, msg: 'type dan value wajib' });
    }
    const cooldown = { solenoid: 60, water_level: 300 }[type] ?? 600;
    const last = await one(
      'SELECT created_at FROM alert_logs WHERE type = $1 AND value = $2 ORDER BY created_at DESC LIMIT 1',
      [type, String(value)],
    );
    if (last && (Date.now() - new Date(last.created_at).getTime()) / 1000 < cooldown) {
      return res.json({ status: 'cooldown' });
    }
    await q('INSERT INTO alert_logs (type, value, created_at, updated_at) VALUES ($1,$2, now(), now())', [type, String(value)]);
    res.json({ status: true, type, value });
  } catch (e) { next(e); }
});

module.exports = { router, api };
