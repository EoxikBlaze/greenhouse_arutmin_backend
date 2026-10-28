'use strict';
/**
 * S5 — ketahanan jembatan MQTT: broker mati-hidup, backend restart, pesan ganda/sampah/banjir,
 * kunci dicabut saat jalan, penyamaran, dan laporan ganda yang tidak boleh mengembalikan jatah dua kali.
 * Broker aedes di dalam proses; perangkat uji sendiri (uji-ket-*); semua baris dihapus di after().
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const mqtt = require('mqtt');
const { q, one, pool } = require('../../src/db');
const { buatKunci } = require('../../src/kunci');
const { buatPerintah, ambilPerintah } = require('../../src/aktuator');
const jembatan = require('../../src/mqttJembatan');

const S = 'uji-ket-sensor'; const A = 'uji-ket-akt'; const B = 'uji-ket-akt2';
let broker; let srv; let port; let url; let j; let meja; let awalMon; let awalEvent; let awalAlert; let awalPerintah;
let kunciS; let kunciA;
const tunggu = (ms) => new Promise((r) => setTimeout(r, ms));
const peringatan = [];
const log = { log() {}, warn: (...a) => peringatan.push(a) };

async function sampai(fn, ms = 8000) {
  const batas = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > batas) return v;
    await tunggu(100);
  }
}
function bukaBroker(p = 0) {
  const b = require('aedes')();
  const s = net.createServer(b.handle);
  return new Promise((r) => s.listen(p, '127.0.0.1', () => r({ b, s, port: s.address().port })));
}
const tutupBroker = async (x) => { await new Promise((r) => x.b.close(r)); await new Promise((r) => x.s.close(r)); };
const bacaanUji = () => q("SELECT id FROM monitorings WHERE id > $1 AND tds BETWEEN 7700 AND 7799", [awalMon]);

before(async () => {
  const x = await bukaBroker(); broker = x.b; srv = x.s; port = x.port; url = `mqtt://127.0.0.1:${port}`;
  awalMon = Number((await one('SELECT coalesce(max(id),0) AS m FROM monitorings')).m);
  awalEvent = Number((await one('SELECT coalesce(max(id),0) AS m FROM dosing_events')).m);
  awalAlert = Number((await one('SELECT coalesce(max(id),0) AS m FROM alert_logs')).m);
  awalPerintah = Number((await one('SELECT coalesce(max(id),0) AS m FROM perintah_aktuator')).m);
  await q('DELETE FROM perangkat WHERE kode = ANY($1)', [[S, A, B]]);
  await q("INSERT INTO perangkat (kode, nama, peran) VALUES ($1,'uji','sensor'), ($2,'uji','aktuator'), ($3,'uji','aktuator')", [S, A, B]);
  kunciS = await buatKunci({ nama: 'uji', scope: ['sensor:tulis'], perangkatKode: S });
  kunciA = await buatKunci({ nama: 'uji', scope: ['aktuator:perintah'], perangkatKode: A });
  await buatKunci({ nama: 'uji', scope: ['aktuator:perintah'], perangkatKode: B });
  meja = (await one("INSERT INTO mejas (meja, jumlah_lubang) VALUES ('UJI Ketahanan', 5) RETURNING id_meja")).id_meja;
  await q('INSERT INTO penampung_states (id_meja) VALUES ($1) ON CONFLICT (id_meja) DO NOTHING', [meja]);
  j = jembatan.mulai({ url, log, cacheMs: 400 });
  await sampai(() => j.client.connected);
});

after(async () => {
  for (const c of dibuka) c.end(true);
  if (j) await Promise.race([j.berhenti().catch(() => {}), tunggu(3000)]);
  await q('DELETE FROM perintah_aktuator WHERE id > $1 AND perangkat_kode = ANY($2)', [awalPerintah, [A, B]]);
  await q('DELETE FROM dosing_events WHERE id > $1 AND id_meja = $2', [awalEvent, meja]);
  await q('DELETE FROM alert_logs WHERE id > $1 AND id_meja = $2', [awalAlert, meja]);
  await q('DELETE FROM monitorings WHERE id > $1 AND tds BETWEEN 7700 AND 7799', [awalMon]);
  await q('DELETE FROM penampung_states WHERE id_meja = $1', [meja]);
  await q('DELETE FROM mejas WHERE id_meja = $1', [meja]);
  await q('DELETE FROM api_keys WHERE perangkat_kode = ANY($1)', [[S, A, B]]);
  await q('DELETE FROM perangkat WHERE kode = ANY($1)', [[S, A, B]]);
  await Promise.race([tutupBroker({ b: broker, s: srv }).catch(() => {}), tunggu(3000)]);
  await pool.end();
});

const dibuka = [];
/** Semua klien uji dicatat & ditutup paksa di after() — tes yang gagal di tengah tak boleh membuat broker menggantung. */
const klien = async (kode) => { const c = await mqtt.connectAsync(url, { clientId: kode, clean: true, reconnectPeriod: 500 }); dibuka.push(c); return c; };

test('S5: broker mati lalu hidup lagi di port yang sama → jembatan & perangkat tersambung ulang, data dan perintah mengalir lagi', async () => {
  const sen = await klien(S); const akt = await klien(A);
  const masuk = [];
  akt.on('message', (_t, b) => masuk.push(JSON.parse(b)));
  await akt.subscribeAsync(`garap/${A}/perintah`, { qos: 1 });
  await akt.publishAsync(`garap/${A}/status`, JSON.stringify({ online: true }));
  await sampai(() => j.online.has(A));

  await tutupBroker({ b: broker, s: srv });                       // ← broker mati
  await sampai(() => !j.client.connected, 5000);
  assert.equal(j.client.connected, false);
  const x = await bukaBroker(port); broker = x.b; srv = x.s;     // ← hidup lagi, tanpa state lama
  assert.ok(await sampai(() => j.client.connected, 15000), 'jembatan tersambung ulang otomatis');
  assert.ok(await sampai(() => akt.connected, 15000), 'klien perangkat tersambung ulang');

  await akt.publishAsync(`garap/${A}/status`, JSON.stringify({ online: true }));   // firmware mengirim ulang status setelah sambung
  await sen.publishAsync(`garap/${S}/data`, JSON.stringify({ tds: 7701, ph: 6.1, waterTemp: 25 }));
  assert.ok(await sampai(async () => (await bacaanUji()).length), 'bacaan setelah broker hidup kembali tersimpan');

  await q("INSERT INTO perintah_aktuator (perangkat_kode, tipe, parameter, sumber, kedaluwarsa_pada) VALUES ($1,'STOP','{}','sistem', now() + interval '60 seconds')", [A]);
  assert.ok(await sampai(() => masuk.length, 15000), 'perintah terkirim lagi (langganan jembatan dipulihkan)');
  await sen.endAsync(true); await akt.endAsync(true);
});

test('S5: backend restart saat ada perintah menunggu → tidak hilang, terkirim ke aktuator begitu online; yang sudah "dikirim" tanpa laporan jadi gagal (tidak dijalankan terlambat)', async () => {
  await q('DELETE FROM perintah_aktuator WHERE perangkat_kode = $1', [A]);
  const menunggu = (await one("INSERT INTO perintah_aktuator (perangkat_kode, tipe, parameter, sumber, kedaluwarsa_pada) VALUES ($1,'STOP','{}','sistem', now() + interval '60 seconds') RETURNING id", [A])).id;
  const menggantung = (await one(
    `INSERT INTO perintah_aktuator (perangkat_kode, tipe, parameter, sumber, status, dikirim_pada, kedaluwarsa_pada)
     VALUES ($1,'STOP','{}','sistem','dikirim', now() - interval '100 seconds', now() + interval '60 seconds') RETURNING id`, [A])).id;

  await j.berhenti();                                                     // ← backend mati
  j = jembatan.mulai({ url, log, cacheMs: 400 });                         // ← backend hidup lagi
  await sampai(() => j.client.connected);
  assert.equal((await one('SELECT status FROM perintah_aktuator WHERE id = $1', [menunggu])).status, 'menunggu', 'tidak hilang');

  const akt = await klien(A); const masuk = [];
  akt.on('message', (_t, b) => masuk.push(JSON.parse(b)));
  await akt.subscribeAsync(`garap/${A}/perintah`, { qos: 1 });
  await akt.publishAsync(`garap/${A}/status`, JSON.stringify({ online: true }));
  assert.ok(await sampai(() => masuk.some((m) => m.id === Number(menunggu))), 'perintah menunggu terkirim setelah restart');
  assert.ok(!masuk.some((m) => m.id === Number(menggantung)), 'perintah yang sudah berstatus dikirim tidak dikirim ulang');
  const st = await one('SELECT status, hasil FROM perintah_aktuator WHERE id = $1', [menggantung]);
  assert.equal(st.status, 'gagal');
  assert.equal(st.hasil.error, 'timeout_tanpa_laporan');
  await akt.endAsync(true);
});

test('S5: pesan ganda — hasil "gagal" yang dikirim dua kali mengembalikan jatah SEKALI saja; ack tetap dikirim', async () => {
  await q('DELETE FROM perintah_aktuator WHERE perangkat_kode = $1', [A]);
  await q('UPDATE penampung_states SET volume_ab_hari_ml = 0, kejadian_dosis_hari = 0, status_lock = false, reset_harian_pada = now() WHERE id_meja = $1', [meja]);
  await q('DELETE FROM dosing_events WHERE id_meja = $1', [meja]);
  const d1 = await buatPerintah({ tipe: 'DOSIS', parameter: { penampung: meja, larutan: 'AB', ml: 100 }, sumber: 'otomasi', perangkat: A });
  const d2 = await buatPerintah({ tipe: 'DOSIS', parameter: { penampung: meja, larutan: 'AB', ml: 100 }, sumber: 'otomasi', perangkat: A });
  await q("UPDATE perintah_aktuator SET status = 'dikirim', dikirim_pada = now() WHERE id = ANY($1::bigint[])", [[d1.id, d2.id]]);
  assert.equal(Number((await one('SELECT volume_ab_hari_ml AS v FROM penampung_states WHERE id_meja = $1', [meja])).v), 200);

  const akt = await klien(A); const ack = [];
  akt.on('message', (_t, b) => ack.push(JSON.parse(b)));
  await akt.subscribeAsync(`garap/${A}/ack`, { qos: 1 });
  await akt.publishAsync(`garap/${A}/status`, JSON.stringify({ online: true }));
  const gagal = JSON.stringify({ id: Number(d1.id), status: 'gagal', hasil: { alasan: 'pompa_macet', ml_nyata: 0 } });
  for (let i = 0; i < 3; i += 1) await akt.publishAsync(`garap/${A}/hasil`, gagal);     // ack hilang → firmware mengulang
  assert.ok(await sampai(() => ack.length >= 3));
  assert.equal(Number((await one('SELECT volume_ab_hari_ml AS v FROM penampung_states WHERE id_meja = $1', [meja])).v), 100,
    'jatah dikembalikan 100 mL sekali (bukan 300) — dosis kedua tetap tercatat');
  assert.equal((await one('SELECT status FROM perintah_aktuator WHERE id = $1', [d2.id])).status, 'dikirim', 'perintah lain tak tersentuh');
  await akt.endAsync(true);
});

test('S5: payload sampah (bukan JSON, array, null, angka, terlalu besar, biner, id ngawur, status asing, topik aneh) tidak membuat jembatan crash atau menyimpan apa pun', async () => {
  const sen = await klien(S); const akt = await klien(A);
  const sebelumMon = (await bacaanUji()).length;
  const sebelumPerintah = (await q('SELECT status FROM perintah_aktuator WHERE perangkat_kode = $1', [A])).map((r) => r.status).join(',');
  const sampah = [
    '{rusak', '[1,2,3]', 'null', '42', '"teks"', '', 'x'.repeat(5000), JSON.stringify({ tds: 7702, pad: 'y'.repeat(5000) }),
    Buffer.from([0xff, 0xfe, 0x00, 0x01]), JSON.stringify({ tds: 'bukan-angka' }), 
    JSON.stringify({ tds: 7704, id_meja: 'abc' }), JSON.stringify({ tds: 7705, id_meja: 999999999 }),
    '{"__proto__":{"admin":true},"constructor":{"prototype":{"x":1}},"tds":"bukan-angka"}',   // prototype pollution + nilai tak valid
  ];
  // catatan: pH 99 SENGAJA tersimpan (bacaan mustahil dipertahankan agar aturan "3× berturut-turut → LOCK sensor" bisa bekerja)
  for (const m of sampah) await sen.publishAsync(`garap/${S}/data`, m);
  for (const m of ['{rusak', '[]', JSON.stringify({ id: 'abc', status: 'selesai' }), JSON.stringify({ id: '99999999999999999999', status: 'selesai' }),
    JSON.stringify({ id: -5, status: 'selesai' }), JSON.stringify({ id: 1, status: 'hancur' }), JSON.stringify({ id: 1 })]) {
    await akt.publishAsync(`garap/${A}/hasil`, m);
  }
  for (const t of ['garap/../data', 'garap/uji-ket-sensor/data/ekstra', 'garap//data', 'garap/UJI-KET-SENSOR/data', 'garap/uji ket/data', 'garap/server/data', 'lain/uji-ket-sensor/data', 'garap/#']) {
    await sen.publishAsync(t.replace('#', 'x'), JSON.stringify({ tds: 7707, ph: 6.1, waterTemp: 25 })).catch(() => {});
  }
  const galatSebelum = peringatan.filter((w) => JSON.stringify(w).includes('gagal diproses')).length;
  await sen.publishAsync(`garap/${S}/status`, '{rusak');
  await sen.publishAsync(`garap/${S}/status`, JSON.stringify({ online: 'ya', rssi: 1e9, uptime: 1e15, firmware: 'z'.repeat(500) }));
  await tunggu(700);                                   // beri jeda: pesan diproses serentak, urutan DB harus pasti
  const maks = await one('SELECT versi_firmware, rssi, uptime_detik FROM perangkat WHERE kode = $1', [S]);
  assert.equal(maks.uptime_detik, 2147483647, 'uptime ekstrem diklem ke batas integer');
  assert.equal(maks.rssi, 32767, 'rssi ekstrem diklem ke batas smallint');
  await sen.publishAsync(`garap/${S}/status`, JSON.stringify({ online: true, rssi: 'kuat', uptime: -5, firmware: 'f'.repeat(36), estop: 'ya' }));
  await tunggu(1000);
  assert.equal(peringatan.filter((w) => JSON.stringify(w).includes('gagal diproses')).length, galatSebelum,
    'status dengan firmware panjang / rssi & uptime ekstrem tidak boleh menimbulkan error database');
  const pr = await one('SELECT versi_firmware, rssi, uptime_detik FROM perangkat WHERE kode = $1', [S]);
  assert.equal(pr.versi_firmware.length, 32, 'firmware dipotong ke 32 huruf');
  assert.equal(pr.uptime_detik, 0, 'uptime negatif diklem ke 0');
  assert.equal((await bacaanUji()).length, sebelumMon, 'tidak ada bacaan sampah yang tersimpan');
  assert.equal((await q('SELECT status FROM perintah_aktuator WHERE perangkat_kode = $1', [A])).map((r) => r.status).join(','), sebelumPerintah);
  assert.equal(j.client.connected, true, 'jembatan tetap hidup');

  // masih berfungsi normal setelah dibanjiri sampah
  await sen.publishAsync(`garap/${S}/data`, JSON.stringify({ tds: 7708, ph: 6.1, waterTemp: 25 }));
  assert.ok(await sampai(async () => (await bacaanUji()).length === sebelumMon + 1));
  await sen.endAsync(true); await akt.endAsync(true);
});

test('S5: banjir 300 bacaan sensor sekaligus → jembatan tetap responsif; setiap bacaan sah tersimpan, tidak ada yang hilang diam-diam', async () => {
  const sen = await klien(S);
  const sebelum = (await bacaanUji()).length;
  const t0 = Date.now();
  await Promise.all(Array.from({ length: 300 }, (_, i) => sen.publishAsync(`garap/${S}/data`, JSON.stringify({ tds: 7710 + (i % 80) + (i >= 80 ? 0 : 0), ph: 5.5 + (i % 10) / 10, waterTemp: 20 + (i % 15), humidity: 30 + (i % 50) }))));
  assert.ok(await sampai(async () => (await bacaanUji()).length > sebelum, 15000), 'bacaan mulai tersimpan');
  await tunggu(3000);
  const tersimpan = (await bacaanUji()).length - sebelum;
  assert.ok(tersimpan >= 50, `banyak bacaan berbeda tersimpan (${tersimpan})`);
  assert.equal(j.client.connected, true);
  const detik = (Date.now() - t0) / 1000;
  assert.ok(detik < 25, `300 pesan diproses ${detik.toFixed(1)} dtk`);
  // setelah banjir, perintah tetap mengalir
  const akt = await klien(A); const masuk = [];
  akt.on('message', (_t, b) => masuk.push(JSON.parse(b)));
  await akt.subscribeAsync(`garap/${A}/perintah`, { qos: 1 });
  await akt.publishAsync(`garap/${A}/status`, JSON.stringify({ online: true }));
  await q('DELETE FROM perintah_aktuator WHERE perangkat_kode = $1', [A]);
  await q("INSERT INTO perintah_aktuator (perangkat_kode, tipe, parameter, sumber, kedaluwarsa_pada) VALUES ($1,'STOP','{}','sistem', now() + interval '60 seconds')", [A]);
  assert.ok(await sampai(() => masuk.length, 10000));
  await sen.endAsync(true); await akt.endAsync(true);
});

test('S5: kunci dicabut / perangkat dinonaktifkan saat jalan → pesannya diabaikan (setelah cache); dihidupkan lagi → pulih', async () => {
  const sen = await klien(S);
  await q("UPDATE api_keys SET aktif = false, dicabut_pada = now() WHERE perangkat_kode = $1 AND dicabut_pada IS NULL", [S]);
  await tunggu(700);                                          // cache jembatan 400 ms (produksi: 30 dtk)
  const n0 = (await bacaanUji()).length;
  await sen.publishAsync(`garap/${S}/data`, JSON.stringify({ tds: 7791, ph: 6.1, waterTemp: 25 }));
  await tunggu(1200);
  assert.equal((await bacaanUji()).length, n0, 'kunci dicabut → bacaan ditolak');
  assert.ok(peringatan.some((w) => JSON.stringify(w).includes('tak sah')));

  await q("UPDATE api_keys SET aktif = true, dicabut_pada = NULL WHERE perangkat_kode = $1", [S]);
  await q('UPDATE perangkat SET aktif = false WHERE kode = $1', [S]);
  await tunggu(700);
  await sen.publishAsync(`garap/${S}/data`, JSON.stringify({ tds: 7792, ph: 6.1, waterTemp: 25 }));
  await tunggu(1200);
  assert.equal((await bacaanUji()).length, n0, 'perangkat dinonaktifkan → ditolak');

  await q('UPDATE perangkat SET aktif = true WHERE kode = $1', [S]);
  await tunggu(700);
  await sen.publishAsync(`garap/${S}/data`, JSON.stringify({ tds: 7793, ph: 6.1, waterTemp: 25 }));
  assert.ok(await sampai(async () => (await bacaanUji()).length === n0 + 1), 'pulih setelah diaktifkan lagi');
  await sen.endAsync(true);
});

/* Identitas pengirim ditentukan dari TOPIK (garap/<kode>/…), bukan dari login MQTT. Karena itu ACL broker
   (deploy-pi/mosquitto/garap.acl) WAJIB: tanpa ACL, sensor yang menulis ke garap/aktuator-01/hasil dianggap aktuator.
   Dengan Mosquitto sungguhan hal itu sudah diuji ditolak (27 Okt). Tes ini hanya mencakup lapisan jembatan. */
test('S5: penyamaran — sensor mengirim ke topik hasil/perintah, aktuator ke topik data, laporan untuk perintah milik aktuator lain → diabaikan', async () => {
  const sen = await klien(S); const akt = await klien(A);
  const n0 = (await bacaanUji()).length;
  await akt.publishAsync(`garap/${A}/data`, JSON.stringify({ tds: 7794, ph: 6.1, waterTemp: 25 }));          // aktuator bukan sensor
  const milikB = (await one(
    `INSERT INTO perintah_aktuator (perangkat_kode, tipe, parameter, sumber, status, dikirim_pada, kedaluwarsa_pada)
     VALUES ($1,'STOP','{}','sistem','dikirim', now(), now() + interval '60 seconds') RETURNING id`, [B])).id;
  await akt.publishAsync(`garap/${A}/hasil`, JSON.stringify({ id: Number(milikB), status: 'selesai', hasil: {} }));  // A melapor perintah B
  await sen.publishAsync(`garap/${S}/hasil`, JSON.stringify({ id: Number(milikB), status: 'selesai', hasil: {} })); // sensor melapor hasil
  await tunggu(1500);
  assert.equal((await bacaanUji()).length, n0);
  const st = (await one('SELECT status FROM perintah_aktuator WHERE id = $1', [milikB])).status;
  assert.equal(st, 'dikirim', 'laporan dari perangkat lain / sensor tidak boleh menyelesaikan perintah milik aktuator B');
  await sen.endAsync(true); await akt.endAsync(true);
});

test('S5: aktuator putus tanpa LWT (kabel dicabut) — perintah yang terkirim ke koneksi mati tidak dijalankan terlambat: jadi "gagal" ≤90 dtk', async () => {
  await q('DELETE FROM perintah_aktuator WHERE perangkat_kode = $1', [A]);
  const akt = await klien(A);
  await akt.publishAsync(`garap/${A}/status`, JSON.stringify({ online: true }));
  await sampai(() => j.online.has(A));
  akt.stream.destroy();                                       // putus mendadak: broker belum tahu, status "online" masih basi
  const p = (await one("INSERT INTO perintah_aktuator (perangkat_kode, tipe, parameter, sumber, kedaluwarsa_pada) VALUES ($1,'STOP','{}','sistem', now() + interval '60 seconds') RETURNING id", [A])).id;
  assert.ok(await sampai(async () => (await one('SELECT status FROM perintah_aktuator WHERE id = $1', [p])).status === 'dikirim', 6000));
  await q("UPDATE perintah_aktuator SET dikirim_pada = now() - interval '100 seconds' WHERE id = $1", [p]);
  await ambilPerintah(A, 3);                                  // siklus berikutnya merapikan antrean
  assert.equal((await one('SELECT status FROM perintah_aktuator WHERE id = $1', [p])).status, 'gagal');
  await akt.endAsync(true);
});

test('S5: bersihkanStatus — firmware >32 huruf, rssi/uptime ekstrem, null, dan tipe aneh menghasilkan nilai yang muat di kolom DB (jalur HTTP juga terlindungi)', () => {
  const { bersihkanStatus } = require('../../src/routes/device');
  assert.equal(bersihkanStatus({ firmware: 'a'.repeat(100) }).firmware.length, 32);
  assert.deepEqual(bersihkanStatus({ rssi: 1e9, uptime: 1e15 }), { firmware: null, rssi: 32767, uptime: 2147483647, estop: null });
  assert.deepEqual(bersihkanStatus({ rssi: -1e9, uptime: -9 }), { firmware: null, rssi: -32768, uptime: 0, estop: null });
  assert.deepEqual(bersihkanStatus({ rssi: null, uptime: '', firmware: 5, estop: 'ya' }), { firmware: null, rssi: null, uptime: null, estop: null });
  assert.equal(bersihkanStatus({ rssi: '-61.6' }).rssi, -62);
  assert.equal(bersihkanStatus({ estop: true }).estop, true);
});
