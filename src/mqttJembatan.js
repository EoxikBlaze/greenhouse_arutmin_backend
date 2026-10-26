'use strict';
/**
 * JEMBATAN MQTT — 2 ESP32 (sensor & aktuator) bicara ke Pi lewat broker Mosquitto lokal.
 * Aktif hanya bila MQTT_URL diisi (mis. mqtt://127.0.0.1:1883). Rute HTTP /api/device/v1 tetap ada.
 *
 * Topik (<kode> = kode perangkat, mis. sensor-01 / aktuator-01):
 *   garap/<kode>/data       perangkat → server  bacaan sensor (JSON sama dgn POST /api/device/v1/sensor)
 *   garap/<kode>/status     perangkat → server  {online,firmware,rssi,uptime,estop}; retained; LWT {online:false}
 *   garap/<kode>/perintah   server → aktuator   {id,tipe,parameter}  (QoS 1)
 *   garap/<kode>/hasil      aktuator → server   {id,status,hasil}
 *   garap/<kode>/ack        server → aktuator   {id}  — firmware mengulang /hasil sampai ack datang
 *   garap/server/status     server → semua      {online,estop,t}; retained, tiap 5 dtk; LWT {online:false}
 *
 * Keamanan: broker menolak anonim & membatasi topik per user lewat ACL (deploy-pi/mosquitto).
 * Server TIDAK hanya percaya ACL — setiap pesan dicek ulang: perangkat ada, aktif, perannya cocok
 * dengan topik, dan masih punya API key aktif (kunci dicabut di web → pesannya diabaikan).
 */
const mqtt = require('mqtt');
const { q, one } = require('./db');
const { ambilPerintah, laporHasil, statusEstop, PerintahDitolak } = require('./aktuator');
const { simpanBacaan, tandaiTerlihat } = require('./routes/device');

const PREFIX = 'garap';
const POLA_TOPIK = /^garap\/([a-z0-9][a-z0-9-]{0,31})\/(data|status|hasil)$/;
const MAKS_BYTE = 4096;
const DETAK_MS = 5000;           // detak server → aktuator (fail-safe firmware 30 dtk)
const KIRIM_MS = 1000;           // seberapa sering antrean perintah diperiksa
const ONLINE_MS = 90_000;        // aktuator dianggap online bila status terakhir ≤ 90 dtk lalu
const CACHE_MS = 30_000;

/** Perangkat + apakah masih punya kunci aktif; di-cache 30 dtk agar tiap bacaan tak query ulang. */
function buatPemeriksaPerangkat() {
  const cache = new Map();
  return async (kode) => {
    const c = cache.get(kode);
    if (c && Date.now() - c.t < CACHE_MS) return c.v;
    const v = await one(
      `SELECT p.kode, p.peran, COALESCE(p.aktif, true) AS aktif,
              EXISTS (SELECT 1 FROM api_keys k WHERE k.perangkat_kode = p.kode AND k.aktif AND k.dicabut_pada IS NULL
                        AND (k.kedaluwarsa_pada IS NULL OR k.kedaluwarsa_pada > now())) AS berkunci
         FROM perangkat p WHERE p.kode = $1`, [kode]);
    cache.set(kode, { t: Date.now(), v });
    return v;
  };
}

/** JSON objek dari payload, atau null bila rusak/terlalu besar/bukan objek. */
function bacaJson(buf) {
  if (!buf || buf.length > MAKS_BYTE) return null;
  try {
    const o = JSON.parse(buf.toString('utf8'));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch { return null; }
}

/**
 * Mulai jembatan. → { client, berhenti(), online: Map } (online dipakai tes).
 * @param {{url:string, username?:string, password?:string, log?:Console}} opsi
 */
function mulai({ url, username, password, log = console } = {}) {
  if (!url) return null;
  const periksa = buatPemeriksaPerangkat();
  const online = new Map();      // kode aktuator → waktu status online terakhir
  let sibukKirim = false;

  const client = mqtt.connect(url, {
    clientId: `garap-api-${process.pid}`,
    username, password,
    clean: true,                 // perintah basi TIDAK boleh antre di broker — TTL di DB yang mengatur
    reconnectPeriod: 3000,
    will: { topic: `${PREFIX}/server/status`, payload: JSON.stringify({ online: false }), qos: 1, retain: true },
  });

  async function detak() {
    if (!client.connected) return;
    try {
      const es = await statusEstop();
      client.publish(`${PREFIX}/server/status`,
        JSON.stringify({ online: true, estop: es.nilai === '1', t: new Date().toISOString() }), { qos: 0, retain: true });
    } catch (e) { log.warn('[mqtt] detak gagal:', e.message); }
  }

  async function kirimPerintah() {
    if (!client.connected || sibukKirim) return;
    sibukKirim = true;
    try {
      for (const [kode, t] of online) {
        // aktuator offline → perintah tetap 'menunggu' lalu kedaluwarsa sendiri (tidak terkirim terlambat)
        if (Date.now() - t > ONLINE_MS) { online.delete(kode); continue; }
        const list = await ambilPerintah(kode, 3);
        for (const p of list) {
          client.publish(`${PREFIX}/${kode}/perintah`,
            JSON.stringify({ id: Number(p.id), tipe: p.tipe, parameter: p.parameter }), { qos: 1 });
        }
      }
    } catch (e) {
      log.warn('[mqtt] kirim perintah gagal:', e.message);
    } finally { sibukKirim = false; }
  }

  async function terima(topik, buf) {
    const m = POLA_TOPIK.exec(topik);
    if (!m) return;
    const [, kode, jenis] = m;
    if (kode === 'server') return;   // detak milik jembatan ini sendiri (cocok dgn garap/+/status)
    const p = await periksa(kode);
    if (!p || !p.aktif || !p.berkunci) { log.warn('[mqtt] pesan dari perangkat tak sah diabaikan', { kode, jenis }); return; }

    if (jenis === 'status') {
      const d = bacaJson(buf);
      if (!d) return;
      if (d.online === false) { online.delete(kode); return; }
      if (p.peran === 'aktuator') online.set(kode, Date.now());
      await tandaiTerlihat(kode, null, {
        firmware: typeof d.firmware === 'string' ? d.firmware.slice(0, 40) : null,
        rssi: Number.isFinite(Number(d.rssi)) ? Math.round(Number(d.rssi)) : null,
        uptime: Number.isFinite(Number(d.uptime)) ? Math.max(0, Math.round(Number(d.uptime))) : null,
        estop: typeof d.estop === 'boolean' ? d.estop : null,
      });
      return;
    }

    if (jenis === 'data') {
      if (p.peran !== 'sensor') return;
      const d = bacaJson(buf);
      const gagal = await simpanBacaan(d, kode, null);
      if (gagal) log.warn('[mqtt] bacaan sensor ditolak', { kode, galat: gagal.errors ? Object.keys(gagal.errors) : 'kosong' });
      return;
    }

    // hasil perintah
    if (p.peran !== 'aktuator') return;
    const d = bacaJson(buf);
    const id = d && /^[0-9]{1,18}$/.test(String(d.id)) ? String(d.id) : null;
    if (!id) return;
    online.set(kode, Date.now());
    try {
      await laporHasil(kode, id, { status: d.status, hasil: d.hasil });
    } catch (e) {
      // 404 = sudah dilaporkan (kiriman ulang) → tetap ack supaya firmware berhenti mengulang
      if (!(e instanceof PerintahDitolak && e.status === 404)) { log.warn('[mqtt] hasil ditolak:', e.message); return; }
    }
    client.publish(`${PREFIX}/${kode}/ack`, JSON.stringify({ id: Number(id) }), { qos: 1 });
  }

  client.on('connect', () => {
    log.log(`[mqtt] tersambung ke ${url}`);
    client.subscribe([`${PREFIX}/+/data`, `${PREFIX}/+/status`, `${PREFIX}/+/hasil`], { qos: 1 });
    detak();
  });
  client.on('message', (topik, buf) => { terima(topik, buf).catch((e) => log.warn('[mqtt] pesan gagal diproses:', e.message)); });
  client.on('error', (e) => log.warn('[mqtt] galat:', e.message));

  const t1 = setInterval(detak, DETAK_MS);
  const t2 = setInterval(kirimPerintah, KIRIM_MS);
  t1.unref(); t2.unref();

  return {
    client,
    online,
    async berhenti() {
      clearInterval(t1); clearInterval(t2);
      if (client.connected) {
        await new Promise((r) => client.publish(`${PREFIX}/server/status`, JSON.stringify({ online: false }), { qos: 1, retain: true }, r));
      }
      await client.endAsync();
    },
  };
}

module.exports = { mulai, bacaJson, POLA_TOPIK };
