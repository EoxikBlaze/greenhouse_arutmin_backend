'use strict';
/**
 * Jembatan MQTT (src/mqttJembatan.js) dengan broker aedes di dalam proses.
 * Memakai perangkat UJI sendiri (uji-mqtt-sensor / uji-mqtt-akt / uji-mqtt-tanpakunci) supaya antrean
 * aktuator-01 asli tidak tersentuh. Semua baris yang dibuat dihapus di after().
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const mqtt = require('mqtt');
const { q, one } = require('../../src/db');
const { buatKunci } = require('../../src/kunci');
const jembatan = require('../../src/mqttJembatan');

const S = 'uji-mqtt-sensor'; const A = 'uji-mqtt-akt'; const T = 'uji-mqtt-tanpakunci';
let broker; let srv; let url; let j; let awalMon;
const tunggu = (ms) => new Promise((r) => setTimeout(r, ms));
const peringatan = [];
const diam = { log() {}, warn: (...a) => peringatan.push(a) };

async function sampai(fn, ms = 5000) {
  const batas = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > batas) return v;
    await tunggu(100);
  }
}

before(async () => {
  broker = require('aedes')();
  srv = net.createServer(broker.handle);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  url = `mqtt://127.0.0.1:${srv.address().port}`;
  awalMon = Number((await one('SELECT coalesce(max(id), 0) AS m FROM monitorings')).m);
  await q('DELETE FROM perangkat WHERE kode = ANY($1)', [[S, A, T]]);
  await q(`INSERT INTO perangkat (kode, nama, peran) VALUES ($1, 'uji sensor', 'sensor'), ($2, 'uji aktuator', 'aktuator'),
           ($3, 'uji tanpa kunci', 'sensor')`, [S, A, T]);
  await buatKunci({ nama: 'uji', scope: ['sensor:tulis'], perangkatKode: S });
  await buatKunci({ nama: 'uji', scope: ['aktuator:perintah'], perangkatKode: A });
  j = jembatan.mulai({ url, log: diam });
  await sampai(() => j.client.connected);
});

after(async () => {
  if (j) await j.berhenti();
  await q('DELETE FROM monitorings WHERE id > $1 AND tds = 777 AND ph = 6.11', [awalMon]);
  await q('DELETE FROM api_keys WHERE perangkat_kode = ANY($1)', [[S, A, T]]);
  await q('DELETE FROM perangkat WHERE kode = ANY($1)', [[S, A, T]]); // perintah_aktuator ikut terhapus (CASCADE)
  await new Promise((r) => broker.close(r));
  await new Promise((r) => srv.close(r));
  await require('../../src/db').pool.end();
});

const perangkatMqtt = async (kode) => {
  const c = await mqtt.connectAsync(url, { clientId: kode, clean: true });
  return c;
};
const bacaanUji = () => q('SELECT id, id_meja FROM monitorings WHERE id > $1 AND tds = 777 AND ph = 6.11', [awalMon]);

test('unit: payload rusak / terlalu besar / bukan objek ditolak; pola topik', () => {
  assert.equal(jembatan.bacaJson(Buffer.from('{rusak')), null);
  assert.equal(jembatan.bacaJson(Buffer.from('[1,2]')), null);
  assert.equal(jembatan.bacaJson(Buffer.from(JSON.stringify({ x: 'a'.repeat(5000) }))), null);
  assert.deepEqual(jembatan.bacaJson(Buffer.from('{"ph":6.1}')), { ph: 6.1 });
  assert.ok(jembatan.POLA_TOPIK.test('garap/sensor-01/data'));
  assert.ok(!jembatan.POLA_TOPIK.test('garap/../data'));
  assert.ok(!jembatan.POLA_TOPIK.test('garap/sensor-01/perintah'), 'server tak memproses topik keluarannya sendiri');
});

test('sensor → data tersimpan; data tak valid, peran salah, dan perangkat tanpa kunci diabaikan', async () => {
  const s = await perangkatMqtt(S);
  await s.publishAsync(`garap/${S}/data`, JSON.stringify({ ph: 6.11, tds: 777, waterTemp: 24.5, firmware: 'uji-1', rssi: -60 }));
  const rows = await sampai(async () => (await bacaanUji()).length && bacaanUji());
  assert.equal(rows.length, 1, 'bacaan sah tersimpan');
  const p = await one('SELECT versi_firmware, rssi, terakhir_terlihat FROM perangkat WHERE kode = $1', [S]);
  assert.equal(p.versi_firmware, 'uji-1');
  assert.ok(p.terakhir_terlihat);

  await s.publishAsync(`garap/${S}/data`, JSON.stringify({ ph: 99, tds: 777 }));          // pH di luar rentang
  await s.publishAsync(`garap/${S}/data`, '{bukan json');
  const a = await perangkatMqtt(A);
  await a.publishAsync(`garap/${A}/data`, JSON.stringify({ ph: 6.11, tds: 777, waterTemp: 30 }));  // aktuator bukan sensor
  const t = await perangkatMqtt(T);
  await t.publishAsync(`garap/${T}/data`, JSON.stringify({ ph: 6.11, tds: 777, waterTemp: 31 }));  // tak punya kunci aktif
  await tunggu(800);
  assert.equal((await bacaanUji()).length, 1, 'hanya bacaan sah yang tersimpan');
  await Promise.all([s.endAsync(), a.endAsync(), t.endAsync()]);
});

test('perintah: aktuator offline → tetap menunggu; online → terkirim, hasil dicatat, ack (juga untuk kiriman ulang)', async () => {
  const p = await one(
    `INSERT INTO perintah_aktuator (perangkat_kode, tipe, parameter, sumber, kedaluwarsa_pada)
     VALUES ($1, 'STOP', '{}', 'sistem', now() + interval '60 seconds') RETURNING id`, [A]);
  await tunggu(1500);
  assert.equal((await one('SELECT status FROM perintah_aktuator WHERE id = $1', [p.id])).status, 'menunggu',
    'belum ada status online → tidak dikirim');

  const a = await perangkatMqtt(A);
  const masuk = []; const ack = [];
  a.on('message', (topik, buf) => (topik.endsWith('/perintah') ? masuk : ack).push(JSON.parse(buf)));
  await a.subscribeAsync([`garap/${A}/perintah`, `garap/${A}/ack`], { qos: 1 });
  await a.publishAsync(`garap/${A}/status`, JSON.stringify({ online: true, firmware: 'akt-uji', estop: false }), { retain: true });

  await sampai(() => masuk.length);
  assert.deepEqual(masuk[0], { id: Number(p.id), tipe: 'STOP', parameter: {} });
  assert.equal((await one('SELECT status FROM perintah_aktuator WHERE id = $1', [p.id])).status, 'dikirim');

  const hasil = JSON.stringify({ id: Number(p.id), status: 'selesai', hasil: { alasan: 'stop', ml_nyata: 0 } });
  await a.publishAsync(`garap/${A}/hasil`, hasil);
  await sampai(() => ack.length);
  const r = await one('SELECT status, hasil FROM perintah_aktuator WHERE id = $1', [p.id]);
  assert.equal(r.status, 'selesai');
  assert.equal(r.hasil.alasan, 'stop');
  await a.publishAsync(`garap/${A}/hasil`, hasil);                       // kiriman ulang (ack hilang)
  await sampai(() => ack.length >= 2);
  assert.deepEqual(ack, [{ id: Number(p.id) }, { id: Number(p.id) }]);
  assert.equal(masuk.length, 1, 'perintah hanya terkirim sekali');

  // LWT/offline → perintah baru tidak dikirim
  await a.publishAsync(`garap/${A}/status`, JSON.stringify({ online: false }), { retain: true });
  await sampai(() => !j.online.has(A));
  const p2 = await one(
    `INSERT INTO perintah_aktuator (perangkat_kode, tipe, parameter, sumber, kedaluwarsa_pada)
     VALUES ($1, 'STOP', '{}', 'sistem', now() + interval '60 seconds') RETURNING id`, [A]);
  await tunggu(1500);
  assert.equal((await one('SELECT status FROM perintah_aktuator WHERE id = $1', [p2.id])).status, 'menunggu');
  assert.equal(masuk.length, 1);
  await a.endAsync();
});

test('server menerbitkan detak retained berisi online & estop untuk fail-safe aktuator', async () => {
  const c = await perangkatMqtt('uji-pendengar');
  const pesan = [];
  c.on('message', (_t, buf) => pesan.push(JSON.parse(buf)));
  await c.subscribeAsync('garap/server/status');
  await sampai(() => pesan.length);
  assert.equal(pesan[0].online, true);
  assert.equal(typeof pesan[0].estop, 'boolean');
  await tunggu(300);
  assert.ok(!peringatan.some((w) => JSON.stringify(w).includes('"server"')), 'detak sendiri tidak dianggap pesan perangkat');
  await c.endAsync();
});
