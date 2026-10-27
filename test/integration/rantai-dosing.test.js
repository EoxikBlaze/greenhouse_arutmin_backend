'use strict';
/**
 * RANTAI DOSING OTOMATIS end-to-end (tanpa hardware):
 *   sensor (MQTT) → monitorings → target naik harian → otomasi.siklus → pagar aktuator.js
 *   → perintah_aktuator → jembatan MQTT → aktuator simulasi → hasil → ack → volume/kejadian.
 * Broker aedes di dalam proses; perangkat uji sendiri (uji-rantai-*) supaya antrean aktuator-01 asli
 * dan tes lain tidak terganggu. Semua baris yang dibuat dihapus di after().
 * E-STOP (status global) sengaja tidak diuji di sini — lihat perangkat.test.js.
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const mqtt = require('mqtt');
const { q, one, pool } = require('../../src/db');
const { buatKunci } = require('../../src/kunci');
const { buatPerintah, PerintahDitolak, laporHasil } = require('../../src/aktuator');
const { siklus } = require('../../src/otomasi');
const { sinkronTarget } = require('../../src/presetDosing');
const jembatan = require('../../src/mqttJembatan');

const S = 'uji-rantai-sensor'; const A = 'uji-rantai-akt';
let broker; let srv; let url; let j; let sensor; let akt; let meja; let mejaLain; let tanaman; let semai;
let awalAlert; let awalEvent; let awalPerintah; let mode = 'selesai';
const masuk = []; const ack = [];
const tunggu = (ms) => new Promise((r) => setTimeout(r, ms));
const diam = { log() {}, warn() {} };

async function sampai(fn, ms = 6000) {
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
  awalAlert = Number((await one('SELECT coalesce(max(id),0) AS m FROM alert_logs')).m);
  awalEvent = Number((await one('SELECT coalesce(max(id),0) AS m FROM dosing_events')).m);
  awalPerintah = Number((await one('SELECT coalesce(max(id),0) AS m FROM perintah_aktuator')).m);
  await q('DELETE FROM perangkat WHERE kode = ANY($1)', [[S, A]]);
  await q("INSERT INTO perangkat (kode, nama, peran) VALUES ($1, 'uji sensor', 'sensor'), ($2, 'uji aktuator', 'aktuator')", [S, A]);
  await buatKunci({ nama: 'uji', scope: ['sensor:tulis'], perangkatKode: S });
  await buatKunci({ nama: 'uji', scope: ['aktuator:perintah'], perangkatKode: A });
  meja = (await one("INSERT INTO mejas (meja, jumlah_lubang) VALUES ('UJI Rantai A', 10) RETURNING id_meja")).id_meja;
  mejaLain = (await one("INSERT INTO mejas (meja, jumlah_lubang) VALUES ('UJI Rantai B', 10) RETURNING id_meja")).id_meja;
  tanaman = (await one(
    "INSERT INTO tanamen (nama_tanaman, ppm_awal, ppm_target, hari_capai) VALUES ('UJI Melon Rantai', 400, 2400, 60) RETURNING id_tanaman")).id_tanaman;
  semai = (await one(
    `INSERT INTO semais (id_tanaman, jumlah_benih, tgl_awal_semai, tgl_akhir_semai, status, id_meja)
     VALUES ($1, 20, current_date - 40, current_date - 30, 'selesai', $2) RETURNING id_semai`, [tanaman, meja])).id_semai;
  // pindah netpot 30 hari lalu → target naik harian hari ini = 1400 ppm
  await q(
    `INSERT INTO peremajaans (id_semai, id_meja, benih_berhasil, benih_gagal, tgl_awal_peremajaan, tgl_akhir_peremajaan, jumlah_masuk, status)
     VALUES ($1, $2, 18, 2, current_date - 30, current_date + 10, 18, 'proses')`, [semai, meja]);

  j = jembatan.mulai({ url, log: diam });
  await sampai(() => j.client.connected);
  sensor = await mqtt.connectAsync(url, { clientId: S, clean: true });
  akt = await mqtt.connectAsync(url, { clientId: A, clean: true });
  akt.on('message', async (topik, buf) => {
    const d = JSON.parse(buf);
    if (topik.endsWith('/ack')) { ack.push(d); return; }
    masuk.push(d);
    if (mode === 'diam') return;
    await tunggu(150);
    akt.publish(`garap/${A}/hasil`, JSON.stringify({
      id: d.id, status: mode, hasil: mode === 'selesai' ? { alasan: 'ok', ml_nyata: d.parameter.ml } : { alasan: 'pompa_macet' },
    }));
  });
  await akt.subscribeAsync([`garap/${A}/perintah`, `garap/${A}/ack`], { qos: 1 });
  await akt.publishAsync(`garap/${A}/status`, JSON.stringify({ online: true, firmware: 'uji', estop: false }));
  await sampai(() => j.online.has(A));
});

after(async () => {
  if (sensor) await sensor.endAsync(true);
  if (akt) await akt.endAsync(true);
  if (j) await j.berhenti();
  await q('DELETE FROM perintah_aktuator WHERE id > $1 AND perangkat_kode = $2', [awalPerintah, A]);
  await q('DELETE FROM dosing_events WHERE id > $1 AND id_meja = ANY($2::bigint[])', [awalEvent, [meja, mejaLain]]);
  await q('DELETE FROM alert_logs WHERE id > $1 AND id_meja = ANY($2::bigint[])', [awalAlert, [meja, mejaLain]]);
  await q('DELETE FROM monitorings WHERE id_meja = ANY($1::bigint[])', [[meja, mejaLain]]);
  await q('DELETE FROM penampung_states WHERE id_meja = ANY($1::bigint[])', [[meja, mejaLain]]);
  await q('DELETE FROM peremajaans WHERE id_semai = $1', [semai]);
  await q('DELETE FROM semais WHERE id_semai = $1', [semai]);
  await q('DELETE FROM tanamen WHERE id_tanaman = $1', [tanaman]);
  await q('DELETE FROM mejas WHERE id_meja = ANY($1::bigint[])', [[meja, mejaLain]]);
  await q('DELETE FROM api_keys WHERE perangkat_kode = ANY($1)', [[S, A]]);
  await q('DELETE FROM perangkat WHERE kode = ANY($1)', [[S, A]]);
  await new Promise((r) => broker.close(r));
  await new Promise((r) => srv.close(r));
  await pool.end();
});

beforeEach(async () => {
  mode = 'selesai'; masuk.length = 0; ack.length = 0;
  await q('DELETE FROM perintah_aktuator WHERE perangkat_kode = $1', [A]);
  await q('DELETE FROM dosing_events WHERE id_meja = $1', [meja]);
  await q('DELETE FROM alert_logs WHERE id > $1 AND id_meja = $2', [awalAlert, meja]);
  await q('DELETE FROM monitorings WHERE id_meja = ANY($1::bigint[])', [[meja, mejaLain]]);
  await q('INSERT INTO penampung_states (id_meja) VALUES ($1) ON CONFLICT (id_meja) DO NOTHING', [meja]);
  await q(`UPDATE penampung_states SET status_lock = false, lock_alasan = NULL, mode_pemeliharaan = false,
           volume_ab_hari_ml = 0, volume_ph_hari_ml = 0, kejadian_dosis_hari = 0, reset_harian_pada = now(),
           target_mode = 'otomatis', target_ec_ppm = NULL, target_ph = NULL WHERE id_meja = $1`, [meja]);
  await sinkronTarget();
});

const jalankan = () => siklus(meja, { perangkat: A });
const state = () => one('SELECT * FROM penampung_states WHERE id_meja = $1', [meja]);
const perintahUji = () => q('SELECT * FROM perintah_aktuator WHERE perangkat_kode = $1 ORDER BY id', [A]);
/** Tunggu ack untuk perintah tertentu (bukan ack basi dari tes sebelumnya). */
const tungguAck = (id) => sampai(() => ack.some((a) => a.id === Number(id)));
const lewatMixing = () => q("UPDATE perintah_aktuator SET dibuat_pada = now() - interval '20 minutes' WHERE perangkat_kode = $1", [A]);

/** Bacaan lewat jalur MQTT sungguhan (sensor → jembatan → validasi → monitorings). */
async function bacaan(tds, ph = 6.0, id = meja) {
  await sensor.publishAsync(`garap/${S}/data`, JSON.stringify({ tds, ph, waterTemp: 25, id_meja: id }));
  const ok = await sampai(async () => one('SELECT 1 AS x FROM monitorings WHERE id_meja = $1 AND tds = $2', [id, tds]));
  assert.ok(ok, `bacaan TDS ${tds} tersimpan lewat MQTT`);
  // satu bacaan = bacaan terbaru: pastikan urutan created_at tak ambigu
  await tunggu(1100);
}
/** Bacaan langsung ke DB (untuk nilai yang sengaja tak lolos validasi API, atau umur tertentu). */
const sisip = (tds, ph, detikLalu = 5, id = meja) => q(
  `INSERT INTO monitorings ("waterTemp", ph, tds, "airTemp", humidity, id_meja, created_at, updated_at)
   VALUES (25, $1, $2, 28, 60, $3, now() - ($4 || ' seconds')::interval, now() - ($4 || ' seconds')::interval)`, [ph, tds, id, String(detikLalu)]);

/* ═══════════════ S1 — rantai lengkap ═══════════════ */

test('S1: target naik harian = 1400 (hari ke-30) lalu TDS 900 → dosis AB 214 mL → aktuator → hasil → ack → volume & kejadian', async () => {
  assert.equal(Number((await state()).target_ec_ppm), 1400, 'target hari ke-30 dari kurva 400→2400/60 hari');

  await bacaan(900);
  const r = await jalankan();
  assert.equal(r.aksi.tipe, 'DOSIS');
  assert.deepEqual(r.aksi.parameter, { penampung: String(meja), larutan: 'AB', ml: 214 }, 'kekurangan 500 → 65% = 325, dibatasi 300 ppm = 214 mL');
  assert.equal((await perintahUji())[0].parameter.penampung, Number(meja), 'pagar menormalkan id penampung jadi angka');

  assert.ok(await sampai(() => masuk.length), 'perintah sampai ke aktuator lewat MQTT');
  assert.equal(masuk[0].id, Number(r.perintah));
  assert.ok(await tungguAck(r.perintah), 'server mengirim ack setelah hasil diterima');

  const p = (await perintahUji())[0];
  assert.equal(p.status, 'selesai');
  assert.equal(p.sumber, 'otomasi');
  assert.equal(p.hasil.ml_nyata, 214);
  const st = await state();
  assert.equal(Number(st.volume_ab_hari_ml), 214);
  assert.equal(Number(st.kejadian_dosis_hari), 1);
  const ev = await one("SELECT * FROM dosing_events WHERE id_meja = $1 AND hasil = 'berjalan'", [meja]);
  assert.equal(ev.ronde_total, 1);
  assert.equal(Number(ev.volume_total_ml), 214);

  // segera siklus lagi → masih menunggu pencampuran (15 menit), tidak mendosis dobel
  assert.match((await jalankan()).sebab, /pencampuran/);
  assert.equal((await perintahUji()).length, 1);

  // setelah pencampuran, TDS naik ke 1380 (dalam pita ±100 dari 1400) → selesai, kejadian ditutup sukses
  await lewatMixing();
  await bacaan(1380);
  const r2 = await jalankan();
  assert.equal(r2.sebab, 'dalam pita target');
  assert.equal((await one('SELECT hasil FROM dosing_events WHERE id = $1', [ev.id])).hasil, 'sukses');
});

test('S1: TDS di dalam pita / di atas target → diam; pH di luar pita → satu langkah kecil; EC didahulukan', async () => {
  await q('UPDATE penampung_states SET target_mode = $2, target_ph = 6.0 WHERE id_meja = $1', [meja, 'manual']);
  await bacaan(1350, 6.0);
  assert.equal((await jalankan()).aksi, null);
  await bacaan(1900, 6.0);
  assert.equal((await jalankan()).aksi, null, 'di atas target: tidak menambah nutrisi');

  await bacaan(1400, 6.6);
  const r = await jalankan();
  assert.deepEqual(r.aksi.parameter, { penampung: String(meja), larutan: 'PH_DOWN', ml: 5 });
  assert.ok(await tungguAck(r.perintah));
  assert.equal(Number((await state()).volume_ph_hari_ml), 5);
  assert.equal((await q('SELECT 1 FROM dosing_events WHERE id_meja = $1', [meja])).length, 0, 'dosis pH bukan kejadian AB');
});

/* Temuan debugging 27 Okt: bacaan identik tidak disimpan (anti-duplikat) sehingga bacaan stabil >120 dtk tampak
   basi — otomasi berhenti & status "Alat terhubung" mati padahal sensor mengirim tiap 5 dtk. */
test('S1: bacaan sensor yang STABIL (identik berulang) tetap segar — tidak menambah baris, otomasi tetap mendosis', async () => {
  await bacaan(900);
  await q("UPDATE monitorings SET created_at = now() - interval '200 seconds', updated_at = now() - interval '200 seconds' WHERE id_meja = $1", [meja]);
  // sensor masih hidup & mengirim nilai yang sama persis
  await sensor.publishAsync(`garap/${S}/data`, JSON.stringify({ tds: 900, ph: 6.0, waterTemp: 25, id_meja: meja }));
  const segar = await sampai(() => one("SELECT 1 AS x FROM monitorings WHERE id_meja = $1 AND updated_at > now() - interval '10 seconds'", [meja]));
  assert.ok(segar, 'bacaan terakhir ditandai dikonfirmasi lagi');
  assert.equal((await q('SELECT 1 FROM monitorings WHERE id_meja = $1', [meja])).length, 1, 'tidak ada baris duplikat');
  const r = await jalankan();
  assert.ok(r.perintah, `otomasi tidak boleh menganggap sensor basi: ${r.sebab}`);
});

test('S1: dosis yang GAGAL dilaporkan aktuator → jatah volume & ronde dikembalikan, kejadian kosong dihapus', async () => {
  mode = 'gagal';
  await bacaan(800);
  const r = await jalankan();
  assert.equal(r.aksi.parameter.ml, 214);
  assert.ok(await tungguAck(r.perintah));
  assert.equal((await perintahUji())[0].status, 'gagal');
  const st = await state();
  assert.equal(Number(st.volume_ab_hari_ml), 0, 'jatah AB dikembalikan');
  assert.equal(Number(st.kejadian_dosis_hari), 0, 'kejadian yang menjadi kosong tidak memotong jatah 8/hari');
  assert.equal((await q('SELECT 1 FROM dosing_events WHERE id_meja = $1', [meja])).length, 0);
});

test('S1: aktuator tak merespons → perintah "dikirim" menahan siklus berikutnya; tidak ada dosis dobel', async () => {
  mode = 'diam';
  await bacaan(800);
  const r = await jalankan();
  assert.ok(r.perintah);
  assert.ok(await sampai(() => masuk.length));
  assert.equal((await perintahUji())[0].status, 'dikirim');
  assert.match((await jalankan()).sebab, /masih ada perintah berjalan/);
  assert.equal((await perintahUji()).length, 1);
  assert.equal(masuk.length, 1, 'tidak dikirim ulang ke aktuator');
});

test('S1: aktuator offline → perintah tetap menunggu (tidak terkirim terlambat) lalu kedaluwarsa', async () => {
  await akt.publishAsync(`garap/${A}/status`, JSON.stringify({ online: false }));
  await sampai(() => !j.online.has(A));
  await bacaan(800);
  const r = await jalankan();
  assert.ok(r.perintah);
  await tunggu(1800);
  assert.equal((await perintahUji())[0].status, 'menunggu');
  assert.equal(masuk.length, 0);
  await q("UPDATE perintah_aktuator SET kedaluwarsa_pada = now() - interval '1 second' WHERE perangkat_kode = $1", [A]);
  // aktuator kembali online: perintah basi tidak boleh dikirim
  await akt.publishAsync(`garap/${A}/status`, JSON.stringify({ online: true, firmware: 'uji' }));
  await tunggu(2200);
  assert.equal(masuk.length, 0, 'perintah kedaluwarsa tidak dieksekusi');
  assert.equal((await perintahUji())[0].status, 'kedaluwarsa');
});

/* ═══════════════ S2 — pagar keselamatan ═══════════════ */

test('S2: penampung LOCK → otomasi diam & dosis manual ditolak 423; buka kunci melepaskan', async () => {
  await bacaan(800);
  await q("UPDATE penampung_states SET status_lock = true, lock_alasan = 'uji' WHERE id_meja = $1", [meja]);
  assert.match((await jalankan()).sebab, /terkunci/);
  await assert.rejects(
    buatPerintah({ tipe: 'DOSIS', parameter: { penampung: meja, larutan: 'AB', ml: 10 }, perangkat: A }),
    (e) => e instanceof PerintahDitolak && e.status === 423);
  assert.equal((await perintahUji()).length, 0);
  await q('UPDATE penampung_states SET status_lock = false WHERE id_meja = $1', [meja]);
  assert.ok((await jalankan()).perintah, 'setelah dibuka, dosis kembali berjalan');
});

test('S2: mode pemeliharaan → dosis otomatis ditolak, dosis pengguna (manual) tetap boleh', async () => {
  await bacaan(800);
  await q('UPDATE penampung_states SET mode_pemeliharaan = true WHERE id_meja = $1', [meja]);
  const r = await jalankan();
  assert.equal(r.aksi, null);
  assert.match(r.sebab, /ditolak pagar.*pemeliharaan/);
  assert.equal((await perintahUji()).length, 0);
  const manual = await buatPerintah({ tipe: 'DOSIS', parameter: { penampung: meja, larutan: 'AB', ml: 10 }, sumber: 'pengguna', userId: 1, perangkat: A });
  assert.ok(manual.id);
});

test('S2: jatah volume AB harian habis → otomasi ditolak, penampung DIKUNCI + alert batas_dosis', async () => {
  await bacaan(800);
  await q('UPDATE penampung_states SET volume_ab_hari_ml = 400 WHERE id_meja = $1', [meja]);   // 400 + 214 > 500
  const r = await jalankan();
  assert.match(r.sebab, /ditolak pagar.*Batas volume AB harian/);
  assert.equal((await state()).status_lock, true);
  const al = await one("SELECT * FROM alert_logs WHERE id > $1 AND id_meja = $2 AND type = 'batas_dosis'", [awalAlert, meja]);
  assert.equal(al.severity, 'critical');
  assert.equal(al.locked, true);
  assert.equal((await perintahUji()).length, 0);
});

test('S2: 5 suntikan dalam satu kejadian belum mencapai target → retry habis, LOCK + alert retry_habis', async () => {
  await bacaan(800);
  for (let i = 0; i < 5; i += 1) {
    await buatPerintah({ tipe: 'DOSIS', parameter: { penampung: meja, larutan: 'AB', ml: 20 }, sumber: 'otomasi', perangkat: A });
  }
  await q("UPDATE perintah_aktuator SET status = 'selesai' WHERE perangkat_kode = $1", [A]);
  await lewatMixing();
  const r = await jalankan();
  assert.match(r.sebab, /Retry habis/);
  assert.equal((await state()).status_lock, true);
  assert.ok(await one("SELECT 1 AS x FROM alert_logs WHERE id > $1 AND id_meja = $2 AND type = 'retry_habis'", [awalAlert, meja]));
  assert.equal((await perintahUji()).length, 5, 'suntikan ke-6 tidak dibuat');
});

test('S2: kejadian ke-9 dalam sehari → LOCK; kejadian ke-3 memicu peringatan dini (belum LOCK)', async () => {
  await q('UPDATE penampung_states SET kejadian_dosis_hari = 2 WHERE id_meja = $1', [meja]);
  await buatPerintah({ tipe: 'DOSIS', parameter: { penampung: meja, larutan: 'AB', ml: 10 }, sumber: 'otomasi', perangkat: A });
  const dini = await one("SELECT * FROM alert_logs WHERE id > $1 AND id_meja = $2 AND type = 'batas_dosis'", [awalAlert, meja]);
  assert.equal(dini.severity, 'info');
  assert.equal((await state()).status_lock, false);

  await q("UPDATE dosing_events SET hasil = 'sukses' WHERE id_meja = $1", [meja]);
  await q('UPDATE penampung_states SET kejadian_dosis_hari = 8 WHERE id_meja = $1', [meja]);
  await assert.rejects(
    buatPerintah({ tipe: 'DOSIS', parameter: { penampung: meja, larutan: 'AB', ml: 10 }, sumber: 'otomasi', perangkat: A }),
    (e) => e instanceof PerintahDitolak && e.status === 409);
  assert.equal((await state()).status_lock, true);
});

test('S2: sensor basi (>120 dtk), tanpa bacaan, atau bacaan milik meja lain → tidak pernah mendosis', async () => {
  assert.match((await jalankan()).sebab, /belum ada bacaan/);
  await sisip(800, 6.0, 600);
  assert.match((await jalankan()).sebab, /basi/);
  await q('DELETE FROM monitorings WHERE id_meja = $1', [meja]);
  await sisip(300, 6.0, 5, mejaLain);               // bacaan rendah, tetapi milik meja lain
  assert.match((await jalankan()).sebab, /belum ada bacaan/);
  assert.equal((await perintahUji()).length, 0);
});

test('S2: bacaan mustahil (probe lepas) dibuang; 3 berturut-turut → LOCK + alert sensor', async () => {
  await sisip(1100, 6.0, 40);
  await sisip(0, 6.0, 30);           // probe EC lepas
  assert.match((await jalankan()).sebab, /dibuang/);
  assert.equal((await perintahUji()).length, 0);
  assert.equal((await state()).status_lock, false, 'satu/dua bacaan aneh belum mengunci');

  await q('DELETE FROM monitorings WHERE id_meja = $1', [meja]);
  await sisip(0, 6.0, 30); await sisip(2600, 6.0, 20); await sisip(10, 6.0, 10);
  assert.match((await jalankan()).sebab, /LOCK/);
  assert.equal((await state()).status_lock, true);
  assert.ok(await one("SELECT 1 AS x FROM alert_logs WHERE id > $1 AND id_meja = $2 AND type = 'sensor'", [awalAlert, meja]));
});

test('S2: mode MANUAL tidak disentuh sinkron; target kosong → otomasi diam', async () => {
  await q("UPDATE penampung_states SET target_mode = 'manual', target_ec_ppm = 777 WHERE id_meja = $1", [meja]);
  await sinkronTarget();
  assert.equal(Number((await state()).target_ec_ppm), 777);
  await q("UPDATE penampung_states SET target_mode = 'manual', target_ec_ppm = NULL, target_ph = NULL WHERE id_meja = $1", [meja]);
  await bacaan(300);
  const r = await jalankan();
  assert.equal(r.aksi, null);
  assert.equal((await perintahUji()).length, 0);
});

test('S2: laporan hasil perangkat lain / perintah sudah selesai ditolak (tak bisa memalsukan jatah)', async () => {
  await bacaan(800);
  const r = await jalankan();
  assert.ok(await tungguAck(r.perintah));
  await assert.rejects(laporHasil(A, r.perintah, { status: 'gagal', hasil: {} }), (e) => e instanceof PerintahDitolak && e.status === 404);
  await assert.rejects(laporHasil('aktuator-01', r.perintah, { status: 'selesai', hasil: {} }), (e) => e instanceof PerintahDitolak && e.status === 404);
  assert.equal(Number((await state()).volume_ab_hari_ml), 214, 'jatah tidak berubah');
});
