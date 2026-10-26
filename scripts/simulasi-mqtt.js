#!/usr/bin/env node
'use strict';
/**
 * Simulator ESP32 lewat MQTT — protokol SAMA dengan firmware deploy-pi/firmware (v0.2).
 * Untuk menguji broker + jembatan backend SEBELUM ESP32 dirakit.
 *
 *   node scripts/simulasi-mqtt.js --perangkat sensor-01   --kunci vsf_... [--url mqtt://127.0.0.1:1883] [--detik 5] [--id-meja 1]
 *   node scripts/simulasi-mqtt.js --perangkat aktuator-01 --kunci vsf_...
 *
 * --kunci boleh lewat env MQTT_KUNCI agar tidak tersimpan di riwayat shell.
 * ⚠ JANGAN jalankan simulator aktuator saat ESP32 aktuator asli menyala: keduanya akan menerima perintah.
 */
const mqtt = require('mqtt');

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : undefined; };
const kode = arg('perangkat');
const kunci = arg('kunci') || process.env.MQTT_KUNCI;
const url = arg('url') || 'mqtt://127.0.0.1:1883';
const detik = Math.max(1, Number(arg('detik')) || 5);
const idMeja = Number(arg('id-meja')) || 0;
if (!/^(sensor|aktuator)-\d{2}$/.test(kode || '') || !kunci) {
  console.error('Pakai: --perangkat sensor-01|aktuator-01 --kunci <API key> [--url mqtt://host:1883]');
  process.exit(2);
}
const aktuator = kode.startsWith('aktuator');
const T = (x) => `garap/${kode}/${x}`;
const acak = (a, b) => a + Math.random() * (b - a);
const mulai = Date.now();

const c = mqtt.connect(url, {
  clientId: `${kode}-simulasi`, username: kode, password: kunci, clean: true, keepalive: 15, reconnectPeriod: 5000,
  will: { topic: T('status'), payload: '{"online":false}', qos: 1, retain: true },
});
const status = () => c.publish(T('status'), JSON.stringify({
  online: true, firmware: `${kode}-simulasi`, rssi: -55, uptime: Math.round((Date.now() - mulai) / 1000), estop: false,
}), { retain: true });

const antre = new Map();   // id → payload hasil yang belum di-ack
let detakTerakhir = 0;

c.on('connect', () => {
  console.log(`[${kode}] tersambung ke ${url}`);
  status();
  if (aktuator) c.subscribe([T('perintah'), T('ack'), 'garap/server/status'], { qos: 1 });
});
c.on('error', (e) => {
  console.error(`[${kode}] ${e.message}${/Not authorized|Bad user/i.test(e.message) ? ' — user/kunci ditolak broker' : ''}`);
});

c.on('message', (topik, buf) => {
  let d; try { d = JSON.parse(buf); } catch { return; }
  if (topik === 'garap/server/status') { if (d.online) detakTerakhir = Date.now(); return; }
  if (topik === T('ack')) { antre.delete(Number(d.id)); console.log(`[${kode}] ack #${d.id}`); return; }
  if (Date.now() - detakTerakhir > 30_000) { console.log(`[${kode}] #${d.id} ditolak: detak server basi`); return; }
  const ml = Number(d.parameter?.ml) || 0;
  const durasi = d.tipe === 'DOSIS' ? Math.min(5000, (ml / 3.5) * 1000) : 300;
  console.log(`[${kode}] MULAI #${d.id} ${d.tipe} ${JSON.stringify(d.parameter)} (${Math.round(durasi)} ms)`);
  setTimeout(() => {
    const hasil = JSON.stringify({ id: d.id, status: 'selesai', hasil: { alasan: 'simulasi', ml_nyata: ml, firmware: `${kode}-simulasi` } });
    antre.set(Number(d.id), hasil);
    c.publish(T('hasil'), hasil);
  }, durasi);
});

setInterval(() => { for (const h of antre.values()) c.publish(T('hasil'), h); }, 3000);   // ulang sampai ack
setInterval(status, 30_000);
if (!aktuator) {
  setInterval(() => {
    if (!c.connected) return;
    const d = {
      ph: +acak(5.8, 6.4).toFixed(2), tds: Math.round(acak(650, 850)), waterTemp: +acak(24, 27).toFixed(1),
      airTemp: +acak(27, 31).toFixed(1), humidity: +acak(60, 75).toFixed(1), rssi: -55, firmware: `${kode}-simulasi`,
      ...(idMeja > 0 ? { id_meja: idMeja } : {}),
    };
    c.publish(T('data'), JSON.stringify(d));
    console.log(`[${kode}] kirim ph=${d.ph} tds=${d.tds}`);
  }, detik * 1000);
}
// Ctrl+C = putus bersih (LWT tidak terbit) → umumkan offline sendiri dulu
process.on('SIGINT', () => {
  c.publish(T('status'), '{"online":false}', { qos: 1, retain: true }, () => c.end(false, () => process.exit(0)));
});
