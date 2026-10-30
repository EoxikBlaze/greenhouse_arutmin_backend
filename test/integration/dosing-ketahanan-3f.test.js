'use strict';
/**
 * Fase 3F — ketahanan alur persetujuan dosing: fault injection (trigger sementara yang menggagalkan INSERT transisi),
 * atomisitas/rollback, retry dengan kunci yang sama, dan balapan LOCK/expiry vs persetujuan.
 *
 * HANYA di DB uji (`garap_uji*`). Trigger uji dibuat dan dihapus di dalam test (finally + after). Membuat user/meja/
 * tanaman/siklus `uji-3f-k`; parameter diubah sementara dan dipulihkan. Tanpa MQTT/perangkat; tidak ada DOSIS dibuat.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');
const { startServer, stopChild, craftToken, bearer } = require('./_server');
const { pool, q } = require('../../src/db');
const aktuator = require('../../src/aktuator');
const dosing = require('../../src/dosingSiklus');

const { lewati } = require('./_isolasi'); // nama garap_uji* DAN host loopback

let srv; let base; let admin; let idAdmin; let tanaman; let paramAwal; let dosisAwal;
const tok = {}; const uid = {}; const meja = []; const siklus = [];
const PARAM = ['maks_gagal_berturut', 'maks_masa_persetujuan_menit', 'maks_ml_per_suntikan', 'maks_volume_ab_hari_ml', 'maks_ml_ph_per_suntikan', 'maks_volume_ph_hari_ml'];
const kunci = () => crypto.randomUUID();
const post = (path, body, t = admin, k = kunci()) => request(base).post(path).set(bearer(t)).set('Idempotency-Key', k).send(body);
const cakupan = { pompa_diizinkan: ['AB'], maks_ml_per_percobaan: 20, maks_ml_total: 60, maks_percobaan: 3, berlaku_menit: 30 };
const dosisCount = async () => Number((await q("SELECT count(*) n FROM perintah_aktuator WHERE tipe = 'DOSIS'"))[0].n);
const status = async (id) => (await q('SELECT status FROM dosing_events WHERE id = $1', [id]))[0].status;
const nPersetujuan = async (id) => Number((await q('SELECT count(*) n FROM persetujuan_dosing WHERE id_kejadian = $1', [id]))[0].n);

async function siklusBaru(idMeja) {
  const id = Number((await q(
    `INSERT INTO siklus_budidaya (id_tanaman, id_meja_semai, mode_target, target, jumlah_benih, status)
     VALUES ($1, $2, 'MANUAL', '{"ec_min_ppm":400,"ec_max_ppm":600,"ph_min":5.8,"ph_max":6.5}', 50, 'TANK_PREPARATION') RETURNING id`, [tanaman, idMeja]))[0].id);
  siklus.push(id);
  return id;
}
async function menunggu(idSiklus) {
  const r = await post('/api/dosing/siklus', { id_siklus_budidaya: idSiklus, alasan: 'uji 3F' }, tok.a);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return Number(r.body.data.id);
}
/** Pasang trigger yang menggagalkan INSERT dosing_transisi bila ke = $ke. */
async function suntikGalat(ke) {
  await q(`CREATE OR REPLACE FUNCTION uji3f_gagal() RETURNS trigger LANGUAGE plpgsql AS $$
           BEGIN IF NEW.ke = '${ke}' THEN RAISE EXCEPTION 'uji3f galat internal rahasia'; END IF; RETURN NEW; END $$`);
  await q('DROP TRIGGER IF EXISTS uji3f_gagal ON dosing_transisi');
  await q('CREATE TRIGGER uji3f_gagal BEFORE INSERT ON dosing_transisi FOR EACH ROW EXECUTE FUNCTION uji3f_gagal()');
}
const lepasGalat = async () => { await q('DROP TRIGGER IF EXISTS uji3f_gagal ON dosing_transisi'); await q('DROP FUNCTION IF EXISTS uji3f_gagal()'); };

before(async () => {
  if (lewati) return;
  process.env.RATE_LIMIT_WRITE = '5000';
  srv = await startServer(); base = srv.base;
  idAdmin = Number((await q("SELECT id FROM users WHERE level = 'admin' AND NOT is_demo ORDER BY id LIMIT 1"))[0].id);
  admin = craftToken({ sub: idAdmin, username: 'garap', level: 'admin', demo: false }, { expiresIn: '20m' });
  paramAwal = await q('SELECT param, nilai, tervalidasi, divalidasi_pada, catatan_validasi FROM konfigurasi_dosis WHERE param = ANY($1)', [PARAM]);
  dosisAwal = await dosisCount();
  uid.a = Number((await q(`INSERT INTO users (username, email, password, level, is_demo, created_at, updated_at)
    VALUES ('uji-3f-k-a', 'uji-3f-k-a@contoh.invalid', '!', 'petani', false, now(), now()) RETURNING id`))[0].id);
  tok.a = craftToken({ sub: uid.a, username: 'uji-3f-k-a', level: 'petani', demo: false }, { expiresIn: '20m' });
  for (let i = 0; i < 4; i += 1) {
    meja.push(Number((await q('INSERT INTO mejas (meja, jumlah_lubang, created_at, updated_at) VALUES ($1, 10, now(), now()) RETURNING id_meja', [`uji-3f-k-${i}`]))[0].id_meja));
    await q('INSERT INTO penugasan_penampung (id_user, id_meja, dibuat_oleh) VALUES ($1, $2, $3)', [uid.a, meja[i], idAdmin]);
  }
  tanaman = Number((await q("INSERT INTO tanamen (nama_tanaman, created_at, updated_at) VALUES ('uji-3f-k', now(), now()) RETURNING id_tanaman"))[0].id_tanaman);
  await q("UPDATE konfigurasi_dosis SET nilai = 60 WHERE param = 'maks_masa_persetujuan_menit'");
  await q("UPDATE konfigurasi_dosis SET tervalidasi = true, divalidasi_pada = now(), catatan_validasi = 'uji 3F (sementara)' WHERE param = ANY($1)", [PARAM]);
});

after(async () => {
  if (lewati) { await pool.end(); return; }
  try {
    await lepasGalat();
    const ev = (await q('SELECT id FROM dosing_events WHERE id_meja = ANY($1)', [meja])).map((r) => Number(r.id));
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('ALTER TABLE persetujuan_dosing DISABLE TRIGGER persetujuan_dosing_beku');
      await c.query('DELETE FROM persetujuan_dosing WHERE id_kejadian = ANY($1)', [ev]);
      await c.query('ALTER TABLE persetujuan_dosing ENABLE TRIGGER persetujuan_dosing_beku');
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    await q("DELETE FROM notifikasi WHERE tautan->>'tipe' = 'dosing' AND (tautan->>'id')::bigint = ANY($1)", [ev]);
    await q("DELETE FROM audit_logs WHERE (tabel = 'dosing_events' AND row_id = ANY($1::text[])) OR (tabel = 'siklus_budidaya' AND row_id = ANY($2::text[]))", [ev.map(String), siklus.map(String)]);
    await q('DELETE FROM dosing_transisi WHERE id_kejadian = ANY($1)', [ev]);
    await q('DELETE FROM perintah_aktuator WHERE id_kejadian = ANY($1)', [ev]);
    await q('DELETE FROM dosing_events WHERE id = ANY($1)', [ev]);
    await q('DELETE FROM siklus_transisi WHERE id_siklus = ANY($1)', [siklus]);
    await q('DELETE FROM siklus_budidaya WHERE id = ANY($1)', [siklus]);
    for (const p of paramAwal) {
      await q('UPDATE konfigurasi_dosis SET nilai = $2, tervalidasi = $3, divalidasi_pada = $4, catatan_validasi = $5 WHERE param = $1',
        [p.param, p.nilai, p.tervalidasi, p.divalidasi_pada, p.catatan_validasi]);
    }
    await q('DELETE FROM alert_logs WHERE id_meja = ANY($1)', [meja]);
    await q('DELETE FROM penampung_states WHERE id_meja = ANY($1)', [meja]);
    await q('DELETE FROM penugasan_penampung WHERE id_meja = ANY($1)', [meja]);
    await q('DELETE FROM mejas WHERE id_meja = ANY($1)', [meja]);
    await q('DELETE FROM tanamen WHERE id_tanaman = $1', [tanaman]);
    await q('DELETE FROM users WHERE id = ANY($1)', [Object.values(uid)]);
  } finally {
    await stopChild(srv?.child);
    await pool.end();
  }
});

test('fault injection: setujui gagal di tengah → rollback penuh, 500 generik tanpa bocor; retry kunci sama berhasil sekali', { skip: lewati }, async () => {
  const id = await menunggu(await siklusBaru(meja[0]));
  const k = kunci();
  await suntikGalat('APPROVED');
  try {
    const r = await post(`/api/dosing/siklus/${id}/setujui`, { cakupan }, tok.a, k);
    assert.equal(r.status, 500);
    assert.equal(JSON.stringify(r.body).includes('uji3f'), false, 'detail galat internal tidak bocor');
    assert.equal(await status(id), 'WAITING_APPROVAL');
    assert.equal(await nPersetujuan(id), 0, 'persetujuan tidak tersisa');
    assert.equal(Number((await q("SELECT count(*) n FROM audit_logs WHERE tabel = 'dosing_events' AND row_id = $1 AND aksi = 'approve'", [String(id)]))[0].n), 0);
  } finally { await lepasGalat(); }
  const ulang = await post(`/api/dosing/siklus/${id}/setujui`, { cakupan }, tok.a, k);
  assert.equal(ulang.status, 200, JSON.stringify(ulang.body).slice(0, 200));
  assert.equal(ulang.body.replay, false, 'percobaan pertama tidak ter-commit → bukan replay');
  assert.equal(await nPersetujuan(id), 1);
  assert.equal((await post(`/api/dosing/siklus/${id}/setujui`, { cakupan }, tok.a, k)).body.replay, true);
  assert.equal(await dosisCount(), dosisAwal);
});

test('fault injection: ajukan gagal → tidak ada siklus dosing/notifikasi tertinggal; retry berhasil', { skip: lewati }, async () => {
  const s = await siklusBaru(meja[1]);
  const k = kunci();
  await suntikGalat('WAITING_APPROVAL');
  try {
    const r = await post('/api/dosing/siklus', { id_siklus_budidaya: s }, tok.a, k);
    assert.equal(r.status, 500);
    assert.equal(Number((await q('SELECT count(*) n FROM dosing_events WHERE id_siklus_budidaya = $1', [s]))[0].n), 0);
  } finally { await lepasGalat(); }
  const ok = await post('/api/dosing/siklus', { id_siklus_budidaya: s }, tok.a, k);
  assert.equal(ok.status, 201, JSON.stringify(ok.body).slice(0, 200));
});

test('fault injection: cabut gagal → status dan persetujuan tidak berubah (pencabutan ikut rollback)', { skip: lewati }, async () => {
  const id = await menunggu(await siklusBaru(meja[2]));
  assert.equal((await post(`/api/dosing/siklus/${id}/setujui`, { cakupan }, tok.a)).status, 200);
  await suntikGalat('CANCELLED');
  try {
    const r = await post(`/api/dosing/siklus/${id}/cabut`, { alasan: 'uji gagal cabut' }, tok.a);
    assert.equal(r.status, 500);
    assert.equal(await status(id), 'APPROVED');
    assert.equal((await q('SELECT dicabut_pada FROM persetujuan_dosing WHERE id_kejadian = $1', [id]))[0].dicabut_pada, null);
  } finally { await lepasGalat(); }
  assert.equal((await post(`/api/dosing/siklus/${id}/cabut`, { alasan: 'uji cabut ulang' }, tok.a)).status, 200);
  assert.equal(await status(id), 'CANCELLED');
});

test('balapan: LOCK penampung vs setujui, 6 putaran → siklus selalu berakhir CANCELLED; tidak pernah APPROVED pada penampung terkunci', { skip: lewati }, async () => {
  const s = await siklusBaru(meja[3]);
  try {
    for (let i = 0; i < 6; i += 1) {
      const id = await menunggu(s);
      const [a, kunciOk] = await Promise.all([post(`/api/dosing/siklus/${id}/setujui`, { cakupan }, tok.a),
        aktuator.kunciPenampung(meja[3], { alasan: `uji 3F ${i}`, type: 'volume_tidak_pasti', value: 'uji' })]);
      // 200 = setujui commit lebih dulu lalu LOCK membatalkan; 409 = LOCK commit lebih dulu (siklus sudah CANCELLED); 423 = setujui melihat LOCK
      assert.ok([200, 409, 423].includes(a.status), `putaran ${i}: ${a.status} ${JSON.stringify(a.body).slice(0, 120)}`);
      assert.equal(kunciOk, true);
      assert.equal(await status(id), 'CANCELLED', `putaran ${i}: siklus pada penampung terkunci harus berakhir CANCELLED`);
      assert.equal((await q('SELECT status_lock FROM penampung_states WHERE id_meja = $1', [meja[3]]))[0].status_lock, true);
      await aktuator.bukaKunci(meja[3], 'uji 3F');
    }
  } finally {
    await aktuator.bukaKunci(meja[3], 'uji 3F bersih').catch(() => {});
  }
});

test('balapan: expiry (penjadwal) vs setujui pada permintaan yang sudah lewat batas → EXPIRED, tanpa persetujuan', { skip: lewati }, async () => {
  for (let i = 0; i < 4; i += 1) {
    const id = await menunggu(siklus[3]); // siklus penampung 3: siklus dosing sebelumnya sudah berstatus akhir
    await q("UPDATE dosing_events SET berlaku_sampai = now() - interval '1 second' WHERE id = $1", [id]);
    const [a, ked] = await Promise.all([post(`/api/dosing/siklus/${id}/setujui`, { cakupan }, tok.a), dosing.kedaluwarsakan()]);
    assert.ok([409, 410].includes(a.status), `putaran ${i}: ${a.status} ${JSON.stringify(a.body).slice(0, 120)}`);
    assert.equal(await status(id), 'EXPIRED', `putaran ${i}`);
    assert.equal(await nPersetujuan(id), 0);
    assert.ok(ked.berhasil >= 0 && Array.isArray(ked.galat));
  }
  assert.equal(await dosisCount(), dosisAwal);
});
