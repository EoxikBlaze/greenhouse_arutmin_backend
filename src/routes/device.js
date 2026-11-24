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

/** Nilai status perangkat dipotong/diklem sesuai kolom `perangkat` (varchar(32), smallint, integer):
 *  dulu firmware >32 huruf atau rssi/uptime ekstrem → error DB (500 di HTTP, status tak terperbarui di MQTT). */
function bersihkanStatus(ekstra = {}) {
  const bulat = (v, min, max) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.min(max, Math.max(min, Math.round(Number(v)))) : null);
  const bool = (v) => (typeof v === 'boolean' ? v : null);
  return {
    firmware: typeof ekstra.firmware === 'string' && ekstra.firmware ? ekstra.firmware.slice(0, 32) : null,
    rssi: bulat(ekstra.rssi, -32768, 32767),
    uptime: bulat(ekstra.uptime, 0, 2147483647),
    estop: bool(ekstra.estop),
    floatBawahRendah: bool(ekstra.float_bawah_rendah),
    floatAtasPenuh: bool(ekstra.float_atas_penuh),
    estopFisik: bool(ekstra.estop_fisik),
    reset: ekstra.peristiwa === 'reset',
  };
}

/** Peringatan yang wajib terlihat di web (tabel alert_logs → halaman Peringatan & banner keselamatan). */
async function catatPeringatanAlat(kode, info, estopFisikLama) {
  const baris = [];
  if (info.estopFisik === true && estopFisikLama !== true) {
    baris.push(['estop_fisik', `Tombol E-STOP fisik ditekan pada ${kode}; semua pompa dimatikan alat`, 'critical']);
  } else if (info.estopFisik === false && estopFisikLama === true) {
    baris.push(['estop_fisik', `E-STOP fisik pada ${kode} sudah dilepas`, 'info']);
  }
  if (info.reset) baris.push(['tombol_reset', `Tombol RESET fisik ditekan pada ${kode}`, 'warning']);
  if (info.kunci && info.kunci !== '') {
    const pesanKunci = {
      FLOAT_ERROR: 'Pelampung error: float atas naik saat float bawah turun',
      ISI_SERING: 'Pompa isi air terkunci: terdeteksi curiga bocor (>6x isi hari ini)',
      ISI_TIMEOUT: 'Pompa isi air timeout (>15 menit air belum penuh)',
      POMPA_KELAMAAN: 'Pompa dimatikan paksa karena menyala melebihi batas waktu aman',
      SENSOR_RUSAK: 'Sensor rusak atau kabel terlepas',
      EC_CURIGA: 'EC turun mendadak >40% tanpa pengisian air; dosing ditahan',
    }[info.kunci] || `Alat terkunci: ${info.kunci}`;
    const ada = await one("SELECT id FROM alert_logs WHERE type = $1 AND created_at > now() - interval '5 minutes'", [`kunci_${info.kunci.toLowerCase()}`]);
    if (!ada) baris.push([`kunci_${info.kunci.toLowerCase()}`, pesanKunci, 'critical']);
  }
  for (const [type, value, severity] of baris) {
    await q(`INSERT INTO alert_logs (type, value, severity, locked, created_at, updated_at)
             VALUES ($1, $2, $3, false, now(), now())`, [type, value.slice(0, 100), severity]);
  }
}

async function tandaiTerlihat(kode, ip, mentah = {}) {
  if (!kode) return;
  const ekstra = bersihkanStatus(mentah);
  const floatBawahRendah = typeof mentah.float_bawah_rendah === 'boolean' ? mentah.float_bawah_rendah : null;
  const floatAtasPenuh = typeof mentah.float_atas_penuh === 'boolean' ? mentah.float_atas_penuh : null;
  const estopFisik = typeof mentah.estop_fisik === 'boolean' ? mentah.estop_fisik : (typeof mentah.estop === 'boolean' ? mentah.estop : null);
  const reset = mentah.peristiwa === 'reset';
  const levelAir = typeof mentah.level_air === 'string' ? mentah.level_air.slice(0, 20) : null;
  const mode = typeof mentah.mode === 'string' ? mentah.mode.slice(0, 20) : null;
  const kegiatan = typeof mentah.kegiatan === 'string' ? mentah.kegiatan.slice(0, 30) : null;
  const kunci = typeof mentah.kunci === 'string' ? mentah.kunci.slice(0, 30) : null;
  const pemeliharaan = typeof mentah.pemeliharaan === 'boolean' ? mentah.pemeliharaan : null;
  const targetPpm = Number.isFinite(Number(mentah.target_ppm)) ? Math.round(Number(mentah.target_ppm)) : null;
  const hariSemai = Number.isFinite(Number(mentah.hari_semai)) ? Math.round(Number(mentah.hari_semai)) : null;

  // CTE `lama` membaca snapshot SEBELUM UPDATE → transisi E-STOP fisik bisa dicatat sekali saja.
  const r = await one(
    `WITH lama AS (SELECT estop_fisik FROM perangkat WHERE kode = $1)
     UPDATE perangkat SET terakhir_terlihat = now(),
            ip_terakhir = COALESCE($2, ip_terakhir),
            versi_firmware = COALESCE($3, versi_firmware), rssi = COALESCE($4, rssi),
            uptime_detik = COALESCE($5, uptime_detik), estop_aktif = COALESCE($6, estop_aktif),
            float_bawah_rendah = COALESCE($7, float_bawah_rendah),
            float_atas_penuh = COALESCE($8, float_atas_penuh),
            level_diperbarui_pada = CASE WHEN $7::boolean IS NULL AND $8::boolean IS NULL THEN level_diperbarui_pada ELSE now() END,
            estop_fisik = COALESCE($9, estop_fisik),
            estop_diperbarui_pada = CASE WHEN $9::boolean IS NULL THEN estop_diperbarui_pada ELSE now() END,
            reset_terakhir_pada = CASE WHEN $10::boolean THEN now() ELSE reset_terakhir_pada END
      WHERE kode = $1
      RETURNING (SELECT estop_fisik FROM lama) AS estop_fisik_lama`,
    [kode, ip ? String(ip).slice(0, 45) : null, ekstra.firmware ?? null, ekstra.rssi ?? null, ekstra.uptime ?? null, ekstra.estop ?? null,
      floatBawahRendah, floatAtasPenuh, estopFisik, reset]);
  if (r) await catatPeringatanAlat(kode, { estopFisik, reset, kunci }, r.estop_fisik_lama);

  const simpanState = async (k, nilai) => {
    if (nilai !== null && nilai !== undefined) {
      await q(`INSERT INTO aktuator_state (kunci, nilai, diubah_pada)
               VALUES ($1, $2, now())
               ON CONFLICT (kunci) DO UPDATE SET nilai = EXCLUDED.nilai, diubah_pada = now()`, [k, String(nilai).slice(0, 64)]).catch(() => {});
    }
  };
  if (levelAir) await simpanState('v6_level_air', levelAir);
  if (mode) await simpanState('v6_mode', mode);
  if (kegiatan) await simpanState('v6_kegiatan', kegiatan);
  if (kunci !== null) await simpanState('v6_kunci', kunci || '');
  if (pemeliharaan !== null) await simpanState('v6_pemeliharaan', pemeliharaan ? '1' : '0');
  if (targetPpm !== null) await simpanState('v6_target_ppm', targetPpm);
  if (hariSemai !== null) await simpanState('v6_hari_semai', hariSemai);
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

/**
 * Validasi + simpan satu bacaan sensor — dipakai rute HTTP di bawah dan jembatan MQTT
 * (src/mqttJembatan.js) supaya kedua jalur menolak data yang sama.
 * @returns {Promise<{kode: 400|422, errors?: object} | null>} null = tersimpan
 */
async function simpanBacaan(data, kode, ip) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Object.keys(data).length) return { kode: 400 };
  const pen = await penampungBacaan(data.id_meja);
  const errs = { ...mon.sensorErrors(data), ...mon.panjangSensorErrors(data), ...(pen.errors || {}) };
  if (Object.keys(errs).length) return { kode: 422, errors: errs };
  const umur = mon.umurBacaanDetik(data.umur_detik);
  if (umur === undefined) return { kode: 422, errors: { umur_detik: ['umur_detik harus bilangan bulat 0–86400.'] } };
  await mon.saveSensorRows(data, { idMeja: pen.idMeja, umurDetik: umur });
  // Bacaan antrean (dikirim ulang setelah sambungan pulih) bukan keadaan sekarang: pelampung/E-STOP tidak diperbarui.
  await tandaiTerlihat(kode, ip, {
    firmware: typeof data.firmware === 'string' ? data.firmware.slice(0, 40) : null,
    rssi: Number.isFinite(Number(data.rssi)) ? Math.round(Number(data.rssi)) : null,
    ...(umur > 0 ? {} : {
      float_bawah_rendah: data.float_bawah_rendah, float_atas_penuh: data.float_atas_penuh,
      estop_fisik: data.estop_fisik, peristiwa: data.peristiwa,
      level_air: data.level_air, mode: data.mode, kegiatan: data.kegiatan, kunci: data.kunci,
      pemeliharaan: data.pemeliharaan, target_ppm: data.target_ppm, hari_semai: data.hari_semai,
    }),
  });
  return null;
}

perangkat.post('/sensor', sensorGuard, async (req, res, next) => {
  try {
    const gagal = await simpanBacaan(req.body, kodePerangkat(req), req.ip);
    if (gagal?.kode === 400) return res.status(400).json({ status: false, message: 'Payload kosong.' });
    if (gagal) return res.status(422).json({ status: false, message: 'Data sensor tidak valid.', errors: gagal.errors });
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

module.exports = { perangkat, klien, simpanBacaan, tandaiTerlihat, bersihkanStatus };
