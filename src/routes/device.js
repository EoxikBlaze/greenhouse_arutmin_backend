'use strict';
/**
 * API perangkat v1 — dipakai 2 ESP32 (sensor & aktuator) dan klien REST berkunci.
 * Mount: app.use('/api/device/v1', device.perangkat) · app.use('/api/v1', device.klien)
 *
 * Autentikasi: header X-API-KEY berkunci per-perangkat (lihat src/kunci.js), scope-nya
 * menentukan apa yang boleh. Kunci sensor tak bisa mengambil perintah aktuator, begitu
 * pula sebaliknya; kunci klien baca-saja tak bisa menulis apa pun.
 */
const express = require('express');
const { q, one } = require('../db');
const { requireKunci } = require('../kunci');
const { ambilPerintah, laporHasil, statusEstop, PerintahDitolak } = require('../aktuator');
const mon = require('./monitoring');

const perangkat = express.Router();
const klien = express.Router();

const galat = (res, e) => (e instanceof PerintahDitolak
  ? res.status(e.status).json({ status: false, message: e.message, ...(e.errors ? { errors: e.errors } : {}) })
  : null);

/** Perangkat pemilik kunci (kunci klien tanpa perangkat → null). */
const kodePerangkat = (req) => req.kunci?.perangkat_kode || null;

async function tandaiTerlihat(kode, ip, ekstra = {}) {
  if (!kode) return;
  await q(
    `UPDATE perangkat SET terakhir_terlihat = now(), ip_terakhir = $2,
            versi_firmware = COALESCE($3, versi_firmware), rssi = COALESCE($4, rssi),
            uptime_detik = COALESCE($5, uptime_detik), estop_aktif = COALESCE($6, estop_aktif)
      WHERE kode = $1`,
    [kode, String(ip || '').slice(0, 45), ekstra.firmware ?? null, ekstra.rssi ?? null, ekstra.uptime ?? null, ekstra.estop ?? null]);
}

const sensorGuard = requireKunci('sensor:tulis');
const aktuatorGuard = requireKunci('aktuator:perintah');

/* ── SENSOR ───────────────────────────────────────────────────────── */
/**
 * Penampung asal bacaan (`id_meja`, opsional demi firmware lama). Bila dikirim WAJIB bilangan bulat
 * ≥ 1 milik meja yang ada — otomasi dosis hanya memakai bacaan yang bertanda penampungnya sendiri.
 * @returns {Promise<{idMeja: number|null} | {errors: Record<string,string[]>}>}
 */
async function penampungBacaan(v) {
  if (v === undefined || v === null || v === '') return { idMeja: null };
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,12}$/.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n < 1) return { errors: { id_meja: ['id_meja harus bilangan bulat ≥ 1.'] } };
  if (!(await one('SELECT 1 AS x FROM mejas WHERE id_meja = $1', [n]))) {
    return { errors: { id_meja: [`Meja dengan id_meja ${n} tidak ditemukan.`] } };
  }
  return { idMeja: n };
}

perangkat.post('/sensor', sensorGuard, async (req, res, next) => {
  try {
    const data = req.body && typeof req.body === 'object' ? req.body : {};
    if (!Object.keys(data).length) return res.status(400).json({ status: false, message: 'Payload kosong.' });
    const pen = await penampungBacaan(data.id_meja);
    const errs = { ...mon.sensorErrors(data), ...mon.panjangSensorErrors(data), ...(pen.errors || {}) };
    if (Object.keys(errs).length) return res.status(422).json({ status: false, message: 'Data sensor tidak valid.', errors: errs });
    await mon.saveSensorRows(data, { idMeja: pen.idMeja });
    await tandaiTerlihat(kodePerangkat(req), req.ip, {
      firmware: typeof data.firmware === 'string' ? data.firmware.slice(0, 40) : null,
      rssi: Number.isFinite(Number(data.rssi)) ? Math.round(Number(data.rssi)) : null,
    });
    res.json({ status: 'ok', server_time: new Date().toISOString(), interval_detik: 5 });
  } catch (e) { next(e); }
});

perangkat.get('/ambang', sensorGuard, async (_req, res, next) => {
  try { res.json({ status: true, thresholds: await mon.thresholdsMap(), fetched_at: new Date().toISOString() }); }
  catch (e) { next(e); }
});

/* ── HEARTBEAT (sensor maupun aktuator) ───────────────────────────── */
async function heartbeat(req, res, next) {
  try {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    await tandaiTerlihat(kodePerangkat(req), req.ip, {
      firmware: typeof b.firmware === 'string' ? b.firmware.slice(0, 40) : null,
      rssi: Number.isFinite(Number(b.rssi)) ? Math.round(Number(b.rssi)) : null,
      uptime: Number.isFinite(Number(b.uptime)) ? Math.max(0, Math.round(Number(b.uptime))) : null,
      estop: typeof b.estop === 'boolean' ? b.estop : null,
    });
    res.json({ status: 'ok', server_time: new Date().toISOString() });
  } catch (e) { next(e); }
}
perangkat.post('/heartbeat/sensor', sensorGuard, heartbeat);
perangkat.post('/heartbeat/aktuator', aktuatorGuard, heartbeat);

/* ── AKTUATOR ─────────────────────────────────────────────────────── */
perangkat.get('/perintah', aktuatorGuard, async (req, res, next) => {
  try {
    const kode = kodePerangkat(req);
    if (!kode) return res.status(403).json({ status: false, msg: 'Unauthorized' });
    await tandaiTerlihat(kode, req.ip);
    const list = await ambilPerintah(kode, req.query.maks);
    const es = await statusEstop();
    res.json({ status: true, estop: es.nilai === '1', perintah: list, server_time: new Date().toISOString(), poll_detik: 2 });
  } catch (e) { next(e); }
});

perangkat.post('/perintah/:id/hasil', aktuatorGuard, async (req, res, next) => {
  try {
    if (!/^[0-9]{1,18}$/.test(req.params.id)) return res.status(404).json({ status: false, message: 'Perintah tidak ditemukan.' });
    const kode = kodePerangkat(req);
    if (!kode) return res.status(403).json({ status: false, msg: 'Unauthorized' });
    const row = await laporHasil(kode, req.params.id, req.body || {});
    res.json({ status: true, perintah: row });
  } catch (e) { return galat(res, e) || next(e); }
});

/* ── KLIEN REST (scope data:baca) ─────────────────────────────────── */
const bacaGuard = requireKunci('data:baca');

klien.get('/sensor/terakhir', bacaGuard, async (_req, res, next) => {
  try { res.json(await mon.latestSensorPayload()); } catch (e) { next(e); }
});

klien.get('/sensor/riwayat', bacaGuard, async (req, res, next) => {
  try {
    const jam = Math.min(48, Math.max(1, Number.parseInt(req.query.jam, 10) || 6));
    const batas = Math.min(2000, Math.max(1, Number.parseInt(req.query.batas, 10) || 500));
    const rows = await q(
      `SELECT "waterTemp", ph, tds, "airTemp", humidity, created_at FROM monitorings
        WHERE created_at >= now() - ($1 || ' hours')::interval ORDER BY created_at DESC LIMIT $2`,
      [String(jam), batas]);
    res.json({ jam, jumlah: rows.length, data: rows });
  } catch (e) { next(e); }
});

klien.get('/perangkat', bacaGuard, async (_req, res, next) => {
  try {
    const rows = await q(
      `SELECT kode, nama, peran, versi_firmware AS firmware, rssi, uptime_detik, estop_aktif, terakhir_terlihat,
              (terakhir_terlihat IS NOT NULL AND terakhir_terlihat > now() - interval '120 seconds') AS online
         FROM perangkat WHERE peran IS NOT NULL ORDER BY kode`);
    res.json({ estop: (await statusEstop()).nilai === '1', perangkat: rows });
  } catch (e) { next(e); }
});

module.exports = { perangkat, klien };
