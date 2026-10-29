'use strict';
/**
 * Fase 3D — audit keamanan API dosing (/api/dosing/siklus*): idempotensi terikat pengguna, tidak membocorkan kunci
 * idempotensi, input ekstrem, akses ditolak tanpa efek, status akhir tak bisa dilewati, LOCK/E-STOP, balapan.
 *
 * HANYA di DB uji (`garap_uji*`). Membuat user/meja/tanaman/siklus uji `uji-3d`, mengubah parameter sementara
 * (nilai UJI maks_masa_persetujuan_menit = 60; batas lain hanya ditandai tervalidasi), E-STOP sementara; semuanya
 * dipulihkan di after(). Tanpa MQTT/perangkat. Yang dibuktikan: tidak ada perintah DOSIS yang dibuat.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');
const { startServer, stopChild, craftToken, bearer } = require('./_server');
const { pool, q } = require('../../src/db');
const gerbang = require('../../src/gerbangDosis');

const namaDb = new URL(process.env.DATABASE_URL || 'postgres://x/none').pathname.slice(1);
const lewati = namaDb.startsWith('garap_uji') ? false : `hanya untuk DB uji garap_uji* (sekarang: ${namaDb || 'dari .env'})`;

let srv; let base; let admin; let idAdmin; let tanaman; let paramAwal; let dosisAwal; let estopAwal;
const tok = {}; const uid = {}; const meja = []; const siklus = []; const stopIds = [];
const PARAM = ['maks_gagal_berturut', 'maks_masa_persetujuan_menit', 'maks_ml_per_suntikan', 'maks_volume_ab_hari_ml', 'maks_ml_ph_per_suntikan', 'maks_volume_ph_hari_ml'];
const kunci = () => crypto.randomUUID();
const post = (path, body, t = admin, k = kunci()) => request(base).post(path).set(bearer(t)).set('Idempotency-Key', k).send(body);
const cakupan = { pompa_diizinkan: ['AB'], maks_ml_per_percobaan: 20, maks_ml_total: 60, maks_percobaan: 3, berlaku_menit: 30 };
const dosisCount = async () => (await q("SELECT count(*)::int n FROM perintah_aktuator WHERE tipe = 'DOSIS'"))[0].n;
const status = async (id) => (await q('SELECT status FROM dosing_events WHERE id = $1', [id]))[0].status;
const nTransisi = async (id) => (await q('SELECT count(*)::int n FROM dosing_transisi WHERE id_kejadian = $1', [id]))[0].n;
const nAudit = async (id) => (await q("SELECT count(*)::int n FROM audit_logs WHERE tabel = 'dosing_events' AND row_id = $1", [String(id)]))[0].n;

async function siklusBaru(idMeja, st = 'TANK_PREPARATION') {
  const id = Number((await q(
    `INSERT INTO siklus_budidaya (id_tanaman, id_meja_semai, mode_target, target, jumlah_benih, status, selesai_pada)
     VALUES ($1, $2, 'MANUAL', '{"ec_min_ppm":400,"ec_max_ppm":600,"ph_min":5.8,"ph_max":6.5}', 50, $3::text,
             CASE WHEN $3::text IN ('COMPLETED', 'CANCELLED') THEN now() END) RETURNING id`, [tanaman, idMeja, st]))[0].id);
  siklus.push(id);
  return id;
}

/** WAITING_APPROVAL lewat API (petani a, ditugaskan). */
async function menunggu(idSiklus, t = tok.a) {
  const r = await post('/api/dosing/siklus', { id_siklus_budidaya: idSiklus, alasan: 'uji 3D' }, t);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return Number(r.body.data.id);
}

async function fixtureDosing(idMeja, st, { dengan = true } = {}) {
  const id = Number((await q(
    `INSERT INTO dosing_events (id_meja, hari, pemicu, aktor_tipe, dipicu_oleh, status, mode, berlaku_sampai)
     VALUES ($1, (now() AT TIME ZONE 'Asia/Makassar')::date, 'USER_MANUAL', 'user', $2, $3, 'MANUAL', now() + interval '1 hour') RETURNING id`,
    [idMeja, idAdmin, st]))[0].id);
  if (dengan) {
    await q(
      `INSERT INTO persetujuan_dosing (id_kejadian, keputusan, oleh, pada, pompa_diizinkan, maks_ml_per_percobaan, maks_ml_total, maks_percobaan, berlaku_sampai, idempotency_key)
       VALUES ($1, 'SETUJU', $2, now() - interval '3 hours', '{AB}', 20, 500, 4, now() + interval '1 hour', $3)`, [id, idAdmin, kunci()]);
  }
  return id;
}

before(async () => {
  if (lewati) return;
  process.env.RATE_LIMIT_WRITE = '5000';
  srv = await startServer(); base = srv.base;
  idAdmin = Number((await q("SELECT id FROM users WHERE level = 'admin' AND NOT is_demo ORDER BY id LIMIT 1"))[0].id);
  admin = craftToken({ sub: idAdmin, username: 'garap', level: 'admin', demo: false }, { expiresIn: '20m' });
  paramAwal = await q('SELECT param, nilai, tervalidasi, divalidasi_pada, catatan_validasi FROM konfigurasi_dosis WHERE param = ANY($1)', [PARAM]);
  dosisAwal = await dosisCount();
  estopAwal = (await q("SELECT nilai FROM aktuator_state WHERE kunci = 'estop'"))[0]?.nilai ?? '0';
  for (const k of ['a', 'b']) {
    uid[k] = Number((await q(`INSERT INTO users (username, email, password, level, is_demo, created_at, updated_at)
      VALUES ($1, $2, '!', 'petani', false, now(), now()) RETURNING id`, [`uji-3d-${k}`, `uji-3d-${k}@contoh.invalid`]))[0].id);
    tok[k] = craftToken({ sub: uid[k], username: `uji-3d-${k}`, level: 'petani', demo: false }, { expiresIn: '20m' });
  }
  tok.demo = craftToken({ sub: idAdmin, username: 'demo', level: 'user', demo: true }, { expiresIn: '20m' });
  for (let i = 0; i < 12; i += 1) {
    meja.push(Number((await q('INSERT INTO mejas (meja, jumlah_lubang, created_at, updated_at) VALUES ($1, 10, now(), now()) RETURNING id_meja', [`uji-3d-${i}`]))[0].id_meja));
  }
  for (const m of meja) await q('INSERT INTO penugasan_penampung (id_user, id_meja, dibuat_oleh) VALUES ($1, $2, $3)', [uid.a, m, idAdmin]); // a ditugaskan ke semua; b tidak ke satu pun
  tanaman = Number((await q("INSERT INTO tanamen (nama_tanaman, created_at, updated_at) VALUES ('uji-3d', now(), now()) RETURNING id_tanaman"))[0].id_tanaman);
  // NILAI UJI SEMENTARA (dipulihkan di after): masa persetujuan 60 menit; batas lain hanya ditandai tervalidasi
  await q("UPDATE konfigurasi_dosis SET nilai = 60 WHERE param = 'maks_masa_persetujuan_menit'");
  await q("UPDATE konfigurasi_dosis SET tervalidasi = true, divalidasi_pada = now(), catatan_validasi = 'uji 3D (sementara)' WHERE param = ANY($1)", [PARAM]);
});

after(async () => {
  if (lewati) { await pool.end(); return; }
  try {
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
    await q('DELETE FROM perintah_aktuator WHERE id_kejadian = ANY($1) OR id = ANY($2)', [ev, stopIds]);
    await q('DELETE FROM dosing_events WHERE id = ANY($1)', [ev]);
    await q('DELETE FROM siklus_transisi WHERE id_siklus = ANY($1)', [siklus]);
    await q('DELETE FROM permintaan_konfirmasi WHERE id_siklus = ANY($1)', [siklus]);
    await q('DELETE FROM siklus_budidaya WHERE id = ANY($1)', [siklus]);
    for (const p of paramAwal) {
      await q('UPDATE konfigurasi_dosis SET nilai = $2, tervalidasi = $3, divalidasi_pada = $4, catatan_validasi = $5 WHERE param = $1',
        [p.param, p.nilai, p.tervalidasi, p.divalidasi_pada, p.catatan_validasi]);
    }
    await q("UPDATE aktuator_state SET nilai = $1 WHERE kunci = 'estop'", [estopAwal]);
    await q('DELETE FROM alert_logs WHERE id_meja = ANY($1)', [meja]);
    await q('DELETE FROM monitorings WHERE id_meja = ANY($1)', [meja]);
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

test('gerbang eksekusi tetap false (kode, bukan konfigurasi)', { skip: lewati }, () => {
  assert.equal(gerbang.EKSEKUSI_DIIZINKAN, false);
});

test('idempotensi terikat pengguna: kunci+isi sama dari pengguna lain TIDAK mengulang hasil (422), pemilik tetap replay', { skip: lewati }, async () => {
  const s = await siklusBaru(meja[0]);
  const k = kunci();
  const body = { id_siklus_budidaya: s, alasan: 'uji 3D' };
  const a = await post('/api/dosing/siklus', body, tok.a, k);
  assert.equal(a.status, 201, JSON.stringify(a.body));
  const id = Number(a.body.data.id);
  for (const [nama, t] of [['petani tak ditugaskan', tok.b], ['admin', admin]]) {
    const r = await post('/api/dosing/siklus', body, t, k);
    assert.equal(r.status, 422, `${nama}: ${JSON.stringify(r.body).slice(0, 200)}`);
    assert.equal(r.body.kode, 'idempotency_bentrok', nama);
    assert.equal(r.body.data, undefined, `${nama}: tidak ada data siklus yang bocor`);
  }
  const own = await post('/api/dosing/siklus', body, tok.a, k);
  assert.equal(own.status, 200);
  assert.equal(own.body.replay, true);
  // operasi lain: setujui oleh a, lalu b memakai kunci a dengan isi sama
  const ks = kunci();
  assert.equal((await post(`/api/dosing/siklus/${id}/setujui`, { cakupan }, tok.a, ks)).status, 200);
  const curi = await post(`/api/dosing/siklus/${id}/setujui`, { cakupan }, tok.b, ks);
  assert.equal(curi.status, 422, JSON.stringify(curi.body).slice(0, 200));
  assert.equal(await nTransisi(id), 2, 'tidak ada transisi tambahan');
});

test('GET detail tidak membocorkan idempotency_key persetujuan', { skip: lewati }, async () => {
  const id = await menunggu(await siklusBaru(meja[11]));
  assert.equal((await post(`/api/dosing/siklus/${id}/setujui`, { cakupan })).status, 200);
  const key = (await q('SELECT idempotency_key FROM persetujuan_dosing WHERE id_kejadian = $1', [id]))[0].idempotency_key;
  const d = await request(base).get(`/api/dosing/siklus/${id}`).set(bearer(tok.b));
  assert.equal(d.status, 200);
  assert.equal(d.body.data.persetujuan.keputusan, 'SETUJU');
  assert.equal('idempotency_key' in d.body.data.persetujuan, false);
  assert.equal(JSON.stringify(d.body).includes(key), false, 'UUID kunci tidak muncul di balasan');
  const l = await request(base).get(`/api/dosing/siklus?id_meja=${meja[11]}`).set(bearer(tok.b));
  assert.equal(JSON.stringify(l.body).includes(key), false);
});

test('akses ditolak tidak mengubah apa pun dan tidak membuat perintah', { skip: lewati }, async () => {
  const s = await siklusBaru(meja[1]);
  const id = await menunggu(s);
  const t0 = await nTransisi(id); const a0 = await nAudit(id);
  for (const [op, body] of [['setujui', { cakupan }], ['tolak', {}], ['cabut', { alasan: 'tidak berwenang' }], ['jalankan', {}]]) {
    const r = await post(`/api/dosing/siklus/${id}/${op}`, body, tok.b);
    assert.equal(r.status, 403, `${op}: ${JSON.stringify(r.body).slice(0, 160)}`);
    assert.equal((await post(`/api/dosing/siklus/${id}/${op}`, body, tok.demo)).status, 403, `${op} demo`);
  }
  assert.equal((await post('/api/dosing/siklus', { id_siklus_budidaya: s }, tok.b)).status, 403);
  const batal = await siklusBaru(meja[11], 'CANCELLED');
  const dilarang = await post('/api/dosing/siklus', { id_siklus_budidaya: batal }, tok.b);
  assert.equal(dilarang.status, 403, 'otorisasi mendahului status siklus budidaya');
  assert.equal(dilarang.body.status_sekarang, undefined);
  assert.equal(await status(id), 'WAITING_APPROVAL');
  assert.equal(await nTransisi(id), t0); assert.equal(await nAudit(id), a0);
  assert.equal((await q('SELECT count(*)::int n FROM persetujuan_dosing WHERE id_kejadian = $1', [id]))[0].n, 0);
  assert.equal(await dosisCount(), dosisAwal);
});

test('status akhir tak bisa dilewati: setujui/tolak/cabut/jalankan → 409 tanpa efek', { skip: lewati }, async () => {
  for (const st of ['REJECTED', 'EXPIRED', 'CANCELLED', 'FAULT', 'SUCCESS', 'EXHAUSTED']) {
    for (const dengan of [true, false]) {
      const id = await fixtureDosing(meja[2], st, { dengan });
      const t0 = await nTransisi(id);
      for (const [op, body] of [['setujui', { cakupan }], ['tolak', {}], ['cabut', { alasan: 'uji status akhir' }], ['jalankan', {}]]) {
        const r = await post(`/api/dosing/siklus/${id}/${op}`, body, tok.a);
        assert.equal(r.status, 409, `${st}${dengan ? '+persetujuan' : ''} ${op}: ${JSON.stringify(r.body).slice(0, 160)}`);
      }
      assert.equal(await status(id), st);
      assert.equal(await nTransisi(id), t0, `${st}: tanpa transisi baru`);
    }
  }
  assert.equal(await dosisCount(), dosisAwal);
});

test('input ekstrem → 4xx terkontrol (bukan 500) dan tanpa efek', { skip: lewati }, async () => {
  const s = await siklusBaru(meja[3]);
  const id = await menunggu(s);
  const t0 = await nTransisi(id);
  const galat = async (r, m) => assert.ok(r.status >= 400 && r.status < 500, `${m}: ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  await galat(await post('/api/dosing/siklus', { id_siklus_budidaya: 1e20 }), 'id 1e20');
  await galat(await post('/api/dosing/siklus', { id_siklus_budidaya: -5 }), 'id negatif');
  await galat(await post('/api/dosing/siklus', { id_siklus_budidaya: 1.5 }), 'id pecahan');
  await galat(await post('/api/dosing/siklus', { id_siklus_budidaya: s, alasan: 'x'.repeat(501) }), 'alasan 501 karakter');
  await galat(await post('/api/dosing/siklus', { id_siklus_budidaya: s, alasan: 123 }), 'alasan angka');
  await galat(await post('/api/dosing/siklus', [], admin), 'body array');
  const s1 = (x) => post(`/api/dosing/siklus/${id}/setujui`, { cakupan: { ...cakupan, ...x } });
  for (const [m, x] of [['ml 0.04 (membulat ke 0.0)', { maks_ml_per_percobaan: 0.04, maks_ml_total: 0.04 }], ['berlaku 1e15', { berlaku_menit: 1e15 }], ['percobaan 1e20', { maks_percobaan: 1e20 }],
    ['total 1e308', { maks_ml_total: 1e308 }], ['pompa string', { pompa_diizinkan: 'AB' }], ['pompa objek', { pompa_diizinkan: [{ a: 1 }] }], ['ml NaN-string', { maks_ml_per_percobaan: 'abc' }]]) {
    await galat(await s1(x), m);
  }
  await galat(await post(`/api/dosing/siklus/${id}/setujui`, { cakupan: 'AB' }), 'cakupan string');
  await galat(await post(`/api/dosing/siklus/${id}/setujui`, null), 'body null');
  await galat(await request(base).post(`/api/dosing/siklus/${id}/setujui`).set(bearer(admin)).set('Idempotency-Key', 'bukan-uuid').send({ cakupan }), 'kunci bukan UUID');
  await galat(await request(base).post('/api/dosing/siklus/99999999999999999999/setujui').set(bearer(admin)).set('Idempotency-Key', kunci()).send({ cakupan }), 'id path di luar bigint');
  assert.equal(await status(id), 'WAITING_APPROVAL');
  assert.equal(await nTransisi(id), t0);
  assert.equal((await q('SELECT count(*)::int n FROM persetujuan_dosing WHERE id_kejadian = $1', [id]))[0].n, 0);
});

test('parameter keselamatan hilang → ditolak aman (409), tanpa nilai bawaan', { skip: lewati }, async () => {
  const s = await siklusBaru(meja[4]);
  const id = await menunggu(s);
  try {
    await q("UPDATE konfigurasi_dosis SET nilai = NULL WHERE param = 'maks_gagal_berturut'");
    const r = await post(`/api/dosing/siklus/${id}/setujui`, { cakupan });
    assert.equal(r.status, 409, JSON.stringify(r.body).slice(0, 200));
    assert.equal(r.body.kode, 'parameter_belum_siap');
    assert.equal(await status(id), 'WAITING_APPROVAL');
  } finally {
    await q("UPDATE konfigurasi_dosis SET nilai = $1, tervalidasi = true, divalidasi_pada = now(), catatan_validasi = 'uji 3D (sementara)' WHERE param = 'maks_gagal_berturut'",
      [paramAwal.find((p) => p.param === 'maks_gagal_berturut').nilai]);
  }
});

test('LOCK dan E-STOP tidak bisa dilewati lewat endpoint dosing', { skip: lewati }, async () => {
  const s = await siklusBaru(meja[5]);
  const id = await menunggu(s);
  await q('UPDATE penampung_states SET status_lock = true, lock_alasan = $2, lock_sejak = now() WHERE id_meja = $1', [meja[5], 'uji 3D']);
  try {
    assert.equal((await post(`/api/dosing/siklus/${id}/setujui`, { cakupan })).status, 423);
    assert.equal((await post(`/api/dosing/siklus/${id}/jalankan`, {})).status, 409, 'WAITING bukan APPROVED');
    assert.equal(await status(id), 'WAITING_APPROVAL');
  } finally {
    await q('UPDATE penampung_states SET status_lock = false, lock_alasan = NULL, lock_sejak = NULL WHERE id_meja = $1', [meja[5]]);
  }
  const ok = await post(`/api/dosing/siklus/${id}/setujui`, { cakupan });
  assert.equal(ok.status, 200, JSON.stringify(ok.body).slice(0, 200));
  await q("UPDATE aktuator_state SET nilai = '1' WHERE kunci = 'estop'");
  try {
    assert.equal((await post(`/api/dosing/siklus/${id}/jalankan`, {})).status, 423);
    assert.equal((await post('/api/dosing/siklus', { id_siklus_budidaya: await siklusBaru(meja[6]) })).status, 423, 'ajukan saat E-STOP');
  } finally {
    await q("UPDATE aktuator_state SET nilai = $1 WHERE kunci = 'estop'", [estopAwal]);
  }
  assert.equal(await status(id), 'APPROVED');
  assert.equal(await dosisCount(), dosisAwal);
});

test('cabut RUNNING → CANCELLED + tepat satu STOP (bukan DOSIS)', { skip: lewati }, async () => {
  const id = await fixtureDosing(meja[7], 'RUNNING');
  const r = await post(`/api/dosing/siklus/${id}/cabut`, { alasan: 'uji 3D cabut berjalan' });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  assert.equal(r.body.data.status, 'CANCELLED');
  assert.ok(r.body.stop?.id_perintah, JSON.stringify(r.body.stop));
  stopIds.push(r.body.stop.id_perintah);
  const p = await q('SELECT tipe, status FROM perintah_aktuator WHERE id = $1', [r.body.stop.id_perintah]);
  assert.deepEqual([p[0].tipe, p[0].status], ['STOP', 'menunggu']);
  assert.equal(await dosisCount(), dosisAwal);
});

test('balapan: dua setujui, kunci sama → satu efek + replay; kunci beda → 200 dan 409', { skip: lewati }, async () => {
  const s = await siklusBaru(meja[8]);
  const id = await menunggu(s);
  const k = kunci();
  const [r1, r2] = await Promise.all([post(`/api/dosing/siklus/${id}/setujui`, { cakupan }, tok.a, k), post(`/api/dosing/siklus/${id}/setujui`, { cakupan }, tok.a, k)]);
  assert.deepEqual([r1.status, r2.status], [200, 200], JSON.stringify([r1.body, r2.body]).slice(0, 300));
  assert.deepEqual([r1.body.replay, r2.body.replay].sort(), [false, true]);
  assert.equal((await q('SELECT count(*)::int n FROM persetujuan_dosing WHERE id_kejadian = $1', [id]))[0].n, 1);
  assert.equal((await q("SELECT count(*)::int n FROM dosing_transisi WHERE id_kejadian = $1 AND ke = 'APPROVED'", [id]))[0].n, 1);
  assert.equal((await q("SELECT count(*)::int n FROM audit_logs WHERE tabel = 'dosing_events' AND row_id = $1 AND aksi = 'approve'", [String(id)]))[0].n, 1);

  const id2 = await (async () => { await post(`/api/dosing/siklus/${id}/cabut`, { alasan: 'ganti siklus uji' }); return menunggu(s); })();
  const [a, b] = await Promise.all([post(`/api/dosing/siklus/${id2}/setujui`, { cakupan }, tok.a), post(`/api/dosing/siklus/${id2}/setujui`, { cakupan }, admin)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409], JSON.stringify([a.body, b.body]).slice(0, 300));
  assert.equal((await q('SELECT count(*)::int n FROM persetujuan_dosing WHERE id_kejadian = $1', [id2]))[0].n, 1);
});

test('balapan: setujui vs cabut, 8 putaran → selalu berakhir CANCELLED dan persetujuan (bila ada) dicabut', { skip: lewati }, async () => {
  const s = await siklusBaru(meja[9]);
  for (let i = 0; i < 8; i += 1) {
    const id = await menunggu(s);
    const [a, c] = await Promise.all([post(`/api/dosing/siklus/${id}/setujui`, { cakupan }, tok.a), post(`/api/dosing/siklus/${id}/cabut`, { alasan: `balapan ${i} uji` }, admin)]);
    assert.ok([200, 409].includes(a.status), `putaran ${i} setujui: ${a.status} ${JSON.stringify(a.body).slice(0, 160)}`);
    assert.equal(c.status, 200, `putaran ${i} cabut: ${JSON.stringify(c.body).slice(0, 160)}`);
    assert.equal(await status(id), 'CANCELLED', `putaran ${i}`);
    const p = (await q('SELECT dicabut_pada FROM persetujuan_dosing WHERE id_kejadian = $1', [id]))[0];
    if (p) assert.ok(p.dicabut_pada, `putaran ${i}: persetujuan masih aktif pada siklus CANCELLED`);
  }
});

test('balapan: setujui vs batal siklus budidaya, 6 putaran → dosing CANCELLED, persetujuan dicabut, tanpa 500/deadlock', { skip: lewati }, async () => {
  for (let i = 0; i < 6; i += 1) {
    const s = await siklusBaru(meja[10]);
    const id = await menunggu(s);
    const [a, b] = await Promise.all([post(`/api/dosing/siklus/${id}/setujui`, { cakupan }, tok.a),
      post(`/api/siklus/${s}/transisi`, { ke: 'CANCELLED', alasan: `batal balapan ${i}` }, admin)]);
    assert.ok([200, 409].includes(a.status), `putaran ${i} setujui: ${a.status} ${JSON.stringify(a.body).slice(0, 160)}`);
    assert.equal(b.status, 200, `putaran ${i} batal: ${b.status} ${JSON.stringify(b.body).slice(0, 160)}`);
    assert.equal(await status(id), 'CANCELLED', `putaran ${i}`);
    const p = (await q('SELECT dicabut_pada FROM persetujuan_dosing WHERE id_kejadian = $1', [id]))[0];
    if (p) assert.ok(p.dicabut_pada, `putaran ${i}: persetujuan aktif pada siklus CANCELLED`);
  }
});

test('tidak ada perintah DOSIS di akhir audit', { skip: lewati }, async () => {
  assert.equal(await dosisCount(), dosisAwal);
});
