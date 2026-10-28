'use strict';
/**
 * Server utama Pi — API key per perangkat, endpoint ESP32 (sensor & aktuator),
 * antrean perintah dengan pagar keselamatan, E-STOP, klien REST berkunci.
 * Membersihkan semua data yang dibuat (kunci, perintah, penghitung penampung, E-STOP).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { startServer, adminToken, craftToken, bearer } = require('./_server');
const { q } = require('../../src/db');
const { validasiPerintah, PerintahDitolak, buatPerintah, laporHasil } = require('../../src/aktuator');

let srv; let base; let admin; let meja; let snapState; let mejaUji; let awalEvent; let awalAlert;
const idKunci = [];
const hdr = (k) => ({ 'X-API-KEY': k });
/** 3B.2: DOSIS tidak lagi bisa diminta lewat HTTP; pagar diuji lewat primitif buatPerintah (jalur alur persetujuan 3C). */
async function dosis(parameter, alasan) {
  const idAdmin = Number((await q("SELECT id FROM users WHERE level = 'admin' AND NOT is_demo ORDER BY id LIMIT 1"))[0].id);
  try {
    return { status: 201, body: { perintah: await buatPerintah({ tipe: 'DOSIS', parameter, sumber: 'pengguna', userId: idAdmin, alasan }) } };
  } catch (e) {
    if (e instanceof PerintahDitolak) return { status: e.status, body: { message: e.message } };
    throw e;
  }
}
const CFG = { maks_ml_per_suntikan: 214, maks_ml_ph_per_suntikan: 10, maks_ml_bilas_per_perintah: 500 };

async function buatKunci(body) {
  const r = await request(base).post('/api/kunci').set(bearer(admin)).send(body);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  idKunci.push(r.body.data.id);
  return r.body.data;
}

before(async () => {
  srv = await startServer(); base = srv.base; admin = await adminToken(base);
  meja = (await q('SELECT id_meja FROM mejas ORDER BY id_meja LIMIT 1'))[0].id_meja;
  await q("UPDATE aktuator_state SET nilai = '0' WHERE kunci = 'estop'");
  // JANGAN hapus baris seed penampung_states (suite lain bergantung padanya): simpan lalu pulihkan.
  snapState = (await q('SELECT volume_ab_hari_ml, volume_ph_hari_ml, kejadian_dosis_hari, reset_harian_pada FROM penampung_states WHERE id_meja = $1', [meja]))[0] || null;
  await q('UPDATE penampung_states SET volume_ab_hari_ml = 0, volume_ph_hari_ml = 0, kejadian_dosis_hari = 0 WHERE id_meja = $1', [meja]);
  awalEvent = Number((await q('SELECT COALESCE(max(id), 0) AS m FROM dosing_events'))[0].m);
  awalAlert = Number((await q('SELECT COALESCE(max(id), 0) AS m FROM alert_logs'))[0].m);
  mejaUji = Number((await q(
    "INSERT INTO mejas (meja, jumlah_lubang, created_at, updated_at) VALUES ('uji-lock-dosing', 1, now(), now()) RETURNING id_meja"))[0].id_meja);
});

after(async () => {
  await q("UPDATE aktuator_state SET nilai = '0' WHERE kunci = 'estop'");
  await q("DELETE FROM perintah_aktuator WHERE perangkat_kode = 'aktuator-01'");
  if (snapState) {
    await q('UPDATE penampung_states SET volume_ab_hari_ml = $2, volume_ph_hari_ml = $3, kejadian_dosis_hari = $4, reset_harian_pada = $5 WHERE id_meja = $1',
      [meja, snapState.volume_ab_hari_ml, snapState.volume_ph_hari_ml, snapState.kejadian_dosis_hari, snapState.reset_harian_pada]);
  } else {
    await q('DELETE FROM penampung_states WHERE id_meja = $1', [meja]);
  }
  if (idKunci.length) await q('DELETE FROM api_keys WHERE id = ANY($1::bigint[])', [idKunci]);
  // kejadian & alert yang dibuat file ini (dosing_events → mejas ON DELETE RESTRICT: hapus dulu)
  await q('DELETE FROM dosing_events WHERE id > $1 AND id_meja = ANY($2::bigint[])', [awalEvent, [meja, mejaUji]]);
  await q('DELETE FROM alert_logs WHERE id > $1 AND id_meja = ANY($2::bigint[])', [awalAlert, [meja, mejaUji]]);
  if (mejaUji) {
    await q('DELETE FROM monitorings WHERE id_meja = $1', [mejaUji]);
    await q('DELETE FROM mejas WHERE id_meja = $1', [mejaUji]);
  }
  await srv.stop();
});

/* ── unit: validasi murni ──────────────────────────────────────────── */
test('validasiPerintah: normalisasi & batas per suntikan', () => {
  assert.deepEqual(validasiPerintah('DOSIS', { penampung: 1, larutan: 'AB', ml: '50.04' }, CFG), { penampung: 1, larutan: 'AB', ml: 50 });
  assert.throws(() => validasiPerintah('DOSIS', { penampung: 1, larutan: 'AB', ml: 215 }, CFG), PerintahDitolak);
  assert.throws(() => validasiPerintah('DOSIS', { penampung: 1, larutan: 'PH_UP', ml: 11 }, CFG), PerintahDitolak);
  assert.throws(() => validasiPerintah('DOSIS', { penampung: 1, larutan: 'GARAM', ml: 5 }, CFG), PerintahDitolak);
  assert.throws(() => validasiPerintah('DOSIS', { penampung: 0, larutan: 'AB', ml: 5 }, CFG), PerintahDitolak);
  assert.throws(() => validasiPerintah('DOSIS', { penampung: 1, larutan: 'AB', ml: -1 }, CFG), PerintahDitolak);
  assert.throws(() => validasiPerintah('DOSIS', { penampung: 1, larutan: 'AB', ml: 'NaN' }, CFG), PerintahDitolak);
  assert.throws(() => validasiPerintah('HACK', {}, CFG), PerintahDitolak);
  assert.deepEqual(validasiPerintah('STOP', null, CFG), {});
});

/* ── manajemen kunci ──────────────────────────────────────────────── */
test('kunci: hanya admin sungguhan; kunci tampil sekali; daftar tanpa hash', async () => {
  assert.equal((await request(base).post('/api/kunci').send({})).status, 401);
  const demo = craftToken({ sub: 2, username: 'demo', level: 'admin', demo: true }, { expiresIn: '5m' });
  assert.equal((await request(base).post('/api/kunci').set(bearer(demo)).send({ nama: 'x', scope: ['data:baca'] })).status, 403);
  const petani = craftToken({ sub: 3, username: 'p', level: 'petani', demo: false }, { expiresIn: '5m' });
  assert.equal((await request(base).get('/api/kunci').set(bearer(petani))).status, 403);

  const bad = await request(base).post('/api/kunci').set(bearer(admin)).send({ nama: 'x', scope: ['root'] });
  assert.equal(bad.status, 422);

  const k = await buatKunci({ nama: 'uji-baca', scope: ['data:baca'] });
  assert.match(k.kunci, /^vsf_[0-9a-f]{8}_[0-9a-f]{48}$/);
  const list = await request(base).get('/api/kunci').set(bearer(admin));
  assert.equal(list.status, 200);
  const teks = JSON.stringify(list.body);
  assert.ok(!teks.includes(k.kunci) && !teks.includes('"hash"'), 'daftar kunci tidak boleh memuat kunci/hash');
  // di DB hanya hash
  const row = (await q('SELECT hash FROM api_keys WHERE id = $1', [k.id]))[0];
  assert.match(row.hash, /^[0-9a-f]{64}$/);
  assert.notEqual(row.hash, k.kunci);
});

/* ── sensor ───────────────────────────────────────────────────────── */
test('sensor: kunci wajib, scope dijaga, data tersimpan, kunci dicabut ditolak', async () => {
  const sensor = await buatKunci({ nama: 'uji-sensor', perangkat_kode: 'sensor-01' });
  assert.deepEqual(sensor.scope, ['sensor:tulis', 'data:baca']);
  const body = { waterTemp: 26.3, ph: 6.1, tds: 777, airTemp: 30.2, humidity: 71.5, firmware: 'uji-1.0', rssi: -55 };

  assert.equal((await request(base).post('/api/device/v1/sensor').send(body)).status, 403);
  assert.equal((await request(base).post('/api/device/v1/sensor').set(hdr('vsf_00000000_' + '0'.repeat(48))).send(body)).status, 403);
  assert.equal((await request(base).post('/api/device/v1/sensor').set(hdr('sampah')).send(body)).status, 403);

  const sebelum = (await q('SELECT count(*)::int c FROM monitorings'))[0].c;
  const ok = await request(base).post('/api/device/v1/sensor').set(hdr(sensor.kunci)).send({ ...body, tds: 778.5 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.status, 'ok');
  assert.equal((await q('SELECT count(*)::int c FROM monitorings'))[0].c, sebelum + 1);
  const dev = (await q("SELECT versi_firmware, rssi, terakhir_terlihat FROM perangkat WHERE kode='sensor-01'"))[0];
  assert.equal(dev.versi_firmware, 'uji-1.0');
  assert.equal(dev.rssi, -55);
  assert.ok(dev.terakhir_terlihat);

  const jelek = await request(base).post('/api/device/v1/sensor').set(hdr(sensor.kunci)).send({ ph: 'bukan-angka' });
  assert.equal(jelek.status, 422);
  assert.equal((await request(base).post('/api/device/v1/sensor').set(hdr(sensor.kunci)).send({})).status, 400);

  // kunci sensor TIDAK boleh mengambil perintah aktuator
  assert.equal((await request(base).get('/api/device/v1/perintah').set(hdr(sensor.kunci))).status, 403);

  // cabut → ditolak
  assert.equal((await request(base).delete(`/api/kunci/${sensor.id}`).set(bearer(admin))).status, 200);
  assert.equal((await request(base).post('/api/device/v1/sensor').set(hdr(sensor.kunci)).send(body)).status, 403);
  assert.equal((await request(base).delete(`/api/kunci/${sensor.id}`).set(bearer(admin))).status, 404);
  await q("DELETE FROM monitorings WHERE \"tds\" = 778.5 AND \"waterTemp\" = 26.3 AND ph = 6.1");
});

test('kunci: rotasi mencabut yang lama dan membuat yang baru; kedaluwarsa & perangkat nonaktif ditolak', async () => {
  const lama = await buatKunci({ nama: 'uji-rotasi', perangkat_kode: 'sensor-01' });
  const rot = await request(base).post(`/api/kunci/${lama.id}/rotasi`).set(bearer(admin));
  assert.equal(rot.status, 201);
  idKunci.push(rot.body.data.id);
  assert.notEqual(rot.body.data.kunci, lama.kunci);
  assert.equal((await request(base).get('/api/device/v1/ambang').set(hdr(lama.kunci))).status, 403);
  assert.equal((await request(base).get('/api/device/v1/ambang').set(hdr(rot.body.data.kunci))).status, 200);

  await q('UPDATE api_keys SET kedaluwarsa_pada = now() - interval \'1 minute\' WHERE id = $1', [rot.body.data.id]);
  assert.equal((await request(base).get('/api/device/v1/ambang').set(hdr(rot.body.data.kunci))).status, 403);

  const k3 = await buatKunci({ nama: 'uji-nonaktif', perangkat_kode: 'sensor-01' });
  await q("UPDATE perangkat SET aktif = false WHERE kode = 'sensor-01'");
  try { assert.equal((await request(base).get('/api/device/v1/ambang').set(hdr(k3.kunci))).status, 403); }
  finally { await q("UPDATE perangkat SET aktif = true WHERE kode = 'sensor-01'"); }
});

/* ── aktuator: antrean + pagar ────────────────────────────────────── */
test('aktuator: dosis lolos pagar, terkirim sekali, hasil dilaporkan; pagar harian & ml menolak', async () => {
  const akt = await buatKunci({ nama: 'uji-aktuator', perangkat_kode: 'aktuator-01' });
  const buat = (b) => request(base).post('/api/aktuator/perintah').set(bearer(admin)).send(b);

  // validasi & otorisasi
  const demo = craftToken({ sub: 2, username: 'demo', level: 'admin', demo: true }, { expiresIn: '5m' });
  assert.equal((await request(base).post('/api/aktuator/perintah').set(bearer(demo)).send({ tipe: 'STOP' })).status, 403);
  assert.equal((await request(base).post('/api/aktuator/perintah').send({ tipe: 'STOP' })).status, 401);
  assert.equal((await dosis({ penampung: meja, larutan: 'AB', ml: 999 })).status, 422);
  assert.equal((await dosis({ penampung: 999999, larutan: 'AB', ml: 10 })).status, 404);
  assert.equal((await buat({ tipe: 'RM_RF', parameter: {} })).status, 422);
  const lewatHttp = await buat({ tipe: 'DOSIS', parameter: { penampung: meja, larutan: 'AB', ml: 10 } });
  assert.equal(lewatHttp.status, 423, 'DOSIS lewat HTTP ditolak sampai alur persetujuan ada');
  assert.equal(lewatHttp.body.kode, 'butuh_alur_persetujuan');

  const a = await dosis({ penampung: meja, larutan: 'AB', ml: 200 }, 'uji');
  assert.equal(a.status, 201, JSON.stringify(a.body));
  const b = await dosis({ penampung: meja, larutan: 'AB', ml: 200 });
  assert.equal(b.status, 201);
  const c = await dosis({ penampung: meja, larutan: 'AB', ml: 150 }); // 550 > 500
  assert.equal(c.status, 409);
  assert.match(c.body.message, /AB harian/);

  // perangkat mengambil: tiap perintah hanya sekali
  const ambil = await request(base).get('/api/device/v1/perintah').set(hdr(akt.kunci));
  assert.equal(ambil.status, 200);
  assert.equal(ambil.body.estop, false);
  assert.equal(ambil.body.perintah.length, 2);
  assert.equal(ambil.body.perintah[0].tipe, 'DOSIS');
  assert.equal((await request(base).get('/api/device/v1/perintah').set(hdr(akt.kunci))).body.perintah.length, 0);

  const idA = ambil.body.perintah[0].id; const idB = ambil.body.perintah[1].id;
  assert.equal((await request(base).post(`/api/device/v1/perintah/${idA}/hasil`).set(hdr(akt.kunci)).send({ status: 'selesai', hasil: { ml_nyata: 199.5 } })).status, 200);
  // lapor dua kali → 404
  assert.equal((await request(base).post(`/api/device/v1/perintah/${idA}/hasil`).set(hdr(akt.kunci)).send({ status: 'selesai' })).status, 404);
  assert.equal((await request(base).post('/api/device/v1/perintah/abc/hasil').set(hdr(akt.kunci)).send({ status: 'selesai' })).status, 404);
  assert.equal((await request(base).post(`/api/device/v1/perintah/${idB}/hasil`).set(hdr(akt.kunci)).send({ status: 'mantap' })).status, 422);
  // dosis GAGAL mengembalikan jatah harian (200 mL) → 150 mL kini boleh
  assert.equal((await request(base).post(`/api/device/v1/perintah/${idB}/hasil`).set(hdr(akt.kunci)).send({ status: 'gagal', hasil: { error: 'pompa macet', ml_nyata: 0 } })).status, 200);
  assert.equal((await dosis({ penampung: meja, larutan: 'AB', ml: 150 })).status, 201);

  // perintah kedaluwarsa tidak terkirim
  const kd = await buat({ tipe: 'SAMPLING', parameter: { penampung: meja }, ttl_detik: 10 });
  await q("UPDATE perintah_aktuator SET kedaluwarsa_pada = now() - interval '1 second' WHERE id = $1", [kd.body.perintah.id]);
  const ambil2 = await request(base).get('/api/device/v1/perintah').set(hdr(akt.kunci));
  assert.ok(!ambil2.body.perintah.some((p) => String(p.id) === String(kd.body.perintah.id)));
  assert.equal((await q('SELECT status FROM perintah_aktuator WHERE id = $1', [kd.body.perintah.id]))[0].status, 'kedaluwarsa');

  // batalkan yang masih menunggu
  const w = await buat({ tipe: 'BILAS', parameter: { penampung: meja, ml: 100 } });
  assert.equal((await request(base).delete(`/api/aktuator/perintah/${w.body.perintah.id}`).set(bearer(admin))).status, 200);
  assert.equal((await request(base).delete(`/api/aktuator/perintah/${w.body.perintah.id}`).set(bearer(admin))).status, 404);

  const list = await request(base).get('/api/aktuator/perintah').set(bearer(admin));
  assert.equal(list.status, 200);
  assert.ok(list.body.data.length >= 4);
});

test('E-STOP: menolak perintah berisiko, STOP_DARURAT didahulukan, reset hanya admin', async () => {
  const akt = await buatKunci({ nama: 'uji-aktuator-2', perangkat_kode: 'aktuator-01' });
  const buat = (b) => request(base).post('/api/aktuator/perintah').set(bearer(admin)).send(b);
  await request(base).get('/api/device/v1/perintah').set(hdr(akt.kunci)); // kosongkan antrean

  const est = await request(base).post('/api/aktuator/estop').set(bearer(admin));
  assert.equal(est.status, 201);
  assert.equal((await dosis({ penampung: meja, larutan: 'PH_UP', ml: 5 })).status, 423);
  assert.equal((await buat({ tipe: 'STOP', parameter: {} })).status, 201); // STOP tetap boleh

  const ambil = await request(base).get('/api/device/v1/perintah').set(hdr(akt.kunci));
  assert.equal(ambil.body.estop, true);
  assert.equal(ambil.body.perintah[0].tipe === 'STOP_DARURAT' || ambil.body.perintah.some((p) => p.tipe === 'STOP_DARURAT'), true);

  const demo = craftToken({ sub: 2, username: 'demo', level: 'admin', demo: true }, { expiresIn: '5m' });
  assert.equal((await request(base).post('/api/aktuator/estop/reset').set(bearer(demo))).status, 403);
  const st = await request(base).get('/api/aktuator/status').set(bearer(demo));
  assert.equal(st.status, 200);
  assert.equal(st.body.estop, true);

  assert.equal((await request(base).post('/api/aktuator/estop/reset').set(bearer(admin))).status, 200);
  assert.equal((await dosis({ penampung: meja, larutan: 'PH_UP', ml: 5 })).status, 201);
});

/* ── klien REST ───────────────────────────────────────────────────── */
test('klien REST: scope data:baca saja; kunci perangkat tak bisa dipakai sebagai klien tulis', async () => {
  const baca = await buatKunci({ nama: 'uji-klien', scope: ['data:baca'] });
  const t = await request(base).get('/api/v1/sensor/terakhir').set(hdr(baca.kunci));
  assert.equal(t.status, 200);
  assert.ok('is_online' in t.body);
  const r = await request(base).get('/api/v1/sensor/riwayat?jam=2&batas=5').set(hdr(baca.kunci));
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.data) && r.body.data.length <= 5);
  const p = await request(base).get('/api/v1/perangkat').set(hdr(baca.kunci));
  assert.equal(p.status, 200);
  assert.ok(p.body.perangkat.some((x) => x.kode === 'sensor-01'));
  // klien baca-saja tidak boleh menulis sensor / mengambil perintah
  assert.equal((await request(base).post('/api/device/v1/sensor').set(hdr(baca.kunci)).send({ ph: 6 })).status, 403);
  assert.equal((await request(base).get('/api/device/v1/perintah').set(hdr(baca.kunci))).status, 403);
  assert.equal((await request(base).get('/api/v1/sensor/terakhir')).status, 403);
});

/* ── B3/B4: kejadian dosing, retry habis, jatah harian, LOCK otomatis ───────────────────────── */
const dosisOto = (ml = 50, larutan = 'AB') => buatPerintah({ tipe: 'DOSIS', parameter: { penampung: mejaUji, larutan, ml }, sumber: 'otomasi' });
const state = async () => (await q('SELECT * FROM penampung_states WHERE id_meja = $1', [mejaUji]))[0];
const events = () => q('SELECT id, ronde_total, hasil, lock_terpicu, id_alert, pemicu FROM dosing_events WHERE id_meja = $1 ORDER BY id', [mejaUji]);
const alertUji = () => q('SELECT type, severity, locked FROM alert_logs WHERE id > $1 AND id_meja = $2 ORDER BY id', [awalAlert, mejaUji]);
const kosongkanAntrean = () => q("UPDATE perintah_aktuator SET status = 'batal' WHERE perangkat_kode = 'aktuator-01' AND status IN ('menunggu','dikirim')");
const ditolak = async (p, status) => {
  try { await p; } catch (e) { assert.ok(e instanceof PerintahDitolak, e.message); assert.equal(e.status, status, e.message); return e; }
  assert.fail(`seharusnya ditolak ${status}`);
};
async function bersihkanUji() {
  await kosongkanAntrean();
  await q('DELETE FROM dosing_events WHERE id_meja = $1', [mejaUji]);
  await q('DELETE FROM alert_logs WHERE id > $1 AND id_meja = $2', [awalAlert, mejaUji]);
  await q('DELETE FROM penampung_states WHERE id_meja = $1', [mejaUji]);
}

test('B3: suntikan ulang dalam satu kejadian tidak memotong jatah 8 kejadian/hari', async () => {
  await bersihkanUji();
  for (let i = 0; i < 3; i++) await dosisOto(50);
  const st = await state();
  assert.equal(st.kejadian_dosis_hari, 1, 'dulu 3 (dihitung per suntikan)');
  assert.equal(Number(st.volume_ab_hari_ml), 150, 'volume tetap dihitung semua suntikan');
  const ev = await events();
  assert.equal(ev.length, 1);
  assert.equal(ev[0].ronde_total, 3);
  assert.equal(ev[0].hasil, 'berjalan');
  assert.equal(ev[0].pemicu, 'SISTEM');
  // pH tidak membuka kejadian (jatah kejadian = sesi EC)
  await dosisOto(5, 'PH_DOWN');
  assert.equal((await state()).kejadian_dosis_hari, 1);
});

test('B3: kejadian tanpa ronde baru > 60 menit ditutup; dosis berikutnya membuka kejadian baru + peringatan dini ke-3', async () => {
  await bersihkanUji();
  await dosisOto(20);
  await q("UPDATE dosing_events SET updated_at = now() - interval '61 minutes' WHERE id_meja = $1", [mejaUji]);
  await dosisOto(20);
  let ev = await events();
  assert.deepEqual(ev.map((e) => e.hasil), ['timeout', 'berjalan']);
  assert.equal((await state()).kejadian_dosis_hari, 2);
  assert.equal((await alertUji()).length, 0, 'belum ada peringatan pada kejadian ke-2');
  await q("UPDATE dosing_events SET updated_at = now() - interval '61 minutes' WHERE id_meja = $1", [mejaUji]);
  await dosisOto(20);
  assert.equal((await state()).kejadian_dosis_hari, 3);
  assert.deepEqual(await alertUji(), [{ type: 'batas_dosis', severity: 'info', locked: false }]);
  assert.equal((await state()).status_lock, false, 'peringatan dini BELUM mengunci');
});

test('B4: suntikan ke-6 dalam satu kejadian → retry habis → LOCK + alert kritis; dosis lain ditolak; admin membuka kunci', async () => {
  await bersihkanUji();
  for (let i = 0; i < 4; i++) await dosisOto(20);
  await kosongkanAntrean();
  const tunggu = await dosisOto(20);                       // suntikan ke-5 masih menunggu di antrean
  const e = await ditolak(dosisOto(20), 423);
  assert.match(e.message, /Retry habis/);
  const st = await state();
  assert.equal(st.status_lock, true);
  assert.match(st.lock_alasan, /Retry EC habis/);
  assert.deepEqual(await alertUji(), [{ type: 'retry_habis', severity: 'critical', locked: true }]);
  const ev = await events();
  assert.equal(ev[0].hasil, 'lock');
  assert.equal(ev[0].lock_terpicu, true);
  assert.ok(ev[0].id_alert);
  assert.equal((await q('SELECT status FROM perintah_aktuator WHERE id = $1', [tunggu.id]))[0].status, 'batal', 'dosis yang masih menunggu dibatalkan');
  assert.equal(Number(st.volume_ab_hari_ml), 100, 'suntikan yang ditolak tidak menambah volume');
  // terkunci: dosis apa pun ditolak, juga pH
  await ditolak(dosisOto(5, 'PH_UP'), 423);

  // buka kunci: petani/demo tidak boleh, admin boleh, kedua kali 409
  const petani = craftToken({ sub: 999, username: 'petani-uji', level: 'petani', demo: false }, { expiresIn: '5m' });
  const buka = (t) => request(base).post(`/api/aktuator/penampung/${mejaUji}/buka-kunci`).set(bearer(t));
  assert.equal((await buka(petani)).status, 403);
  assert.equal((await request(base).post('/api/aktuator/penampung/abc/buka-kunci').set(bearer(admin))).status, 404);
  assert.equal((await buka(admin)).status, 200);
  assert.equal((await buka(admin)).status, 409);
  const sesudah = await state();
  assert.equal(sesudah.status_lock, false);
  assert.equal(sesudah.kejadian_dosis_hari, 1, 'hitungan harian TIDAK direset oleh buka kunci');
  assert.equal((await alertUji()).at(-1).type, 'reset');
  await kosongkanAntrean();
  await dosisOto(20);                                     // kejadian baru setelah dibuka
  assert.equal((await state()).kejadian_dosis_hari, 2);
});

test('B4: jatah 8 kejadian habis → LOCK; volume harian habis → otomasi dikunci, pengguna cukup ditolak', async () => {
  await bersihkanUji();
  await dosisOto(10);
  await q("UPDATE dosing_events SET hasil = 'sukses' WHERE id_meja = $1", [mejaUji]);
  await q('UPDATE penampung_states SET kejadian_dosis_hari = 8 WHERE id_meja = $1', [mejaUji]);
  const e = await ditolak(dosisOto(10), 409);
  assert.match(e.message, /8 kejadian/);
  assert.equal((await state()).status_lock, true);
  assert.deepEqual((await alertUji()).map((a) => [a.type, a.locked]), [['batas_dosis', true]]);

  await bersihkanUji();
  await dosisOto(10);
  await q('UPDATE penampung_states SET volume_ab_hari_ml = 450 WHERE id_meja = $1', [mejaUji]);
  await ditolak(buatPerintah({ tipe: 'DOSIS', parameter: { penampung: mejaUji, larutan: 'AB', ml: 100 }, sumber: 'pengguna', userId: 1 }), 409);
  assert.equal((await state()).status_lock, false, 'permintaan pengguna yang kebesaran tidak mengunci');
  await ditolak(dosisOto(100), 409);
  assert.equal((await state()).status_lock, true);
  assert.match((await state()).lock_alasan, /volume AB/);
});

test('B3: suntikan yang dilaporkan GAGAL bukan ronde — kejadian kosong dihapus, jatah kejadian dikembalikan', async () => {
  await bersihkanUji();
  const p = await dosisOto(30);
  await q("UPDATE perintah_aktuator SET status = 'dikirim', dikirim_pada = now() WHERE id = $1", [p.id]);
  await laporHasil('aktuator-01', p.id, { status: 'gagal', hasil: { error: 'pompa macet', ml_nyata: 0 } });
  const st = await state();
  assert.equal(st.kejadian_dosis_hari, 0);
  assert.equal(Number(st.volume_ab_hari_ml), 0);
  assert.equal((await events()).length, 0);
});

