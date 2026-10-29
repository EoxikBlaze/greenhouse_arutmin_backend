'use strict';
/**
 * Fase 3D (tindak lanjut F1/F11) — idempotensi /api/siklus* terikat pengguna: kunci+isi sama dari pengguna LAIN
 * tidak boleh mengulang hasil (dan melewati pemeriksaan penugasan); pemilik kunci tetap mendapat replay.
 *
 * HANYA di DB uji (`garap_uji*`). Membuat user/meja/tanaman uji `uji-3d-sk`; semuanya dihapus di after().
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');
const { startServer, stopChild, craftToken, bearer } = require('./_server');
const { pool, q } = require('../../src/db');

const namaDb = new URL(process.env.DATABASE_URL || 'postgres://x/none').pathname.slice(1);
const lewati = namaDb.startsWith('garap_uji') ? false : `hanya untuk DB uji garap_uji* (sekarang: ${namaDb || 'dari .env'})`;

let srv; let base; let admin; let idAdmin; let tanaman;
const tok = {}; const uid = {}; const meja = []; const siklus = new Set();
const kunci = () => crypto.randomUUID();
const post = (path, body, t = admin, k = kunci()) => request(base).post(path).set(bearer(t)).set('Idempotency-Key', k).send(body);
const target = { ec_min_ppm: 400, ec_max_ppm: 600, ph_min: 5.8, ph_max: 6.5 };
const manual = (idMeja) => ({ id_tanaman: tanaman, id_meja: idMeja, mode_target: 'MANUAL', ph_aktual: 6.1, tds_aktual_ppm: 450, jumlah_benih: 50, target });
const nTransisi = async (id) => (await q('SELECT count(*)::int n FROM siklus_transisi WHERE id_siklus = $1', [id]))[0].n;

before(async () => {
  if (lewati) return;
  process.env.RATE_LIMIT_WRITE = '5000';
  srv = await startServer(); base = srv.base;
  idAdmin = Number((await q("SELECT id FROM users WHERE level = 'admin' AND NOT is_demo ORDER BY id LIMIT 1"))[0].id);
  admin = craftToken({ sub: idAdmin, username: 'garap', level: 'admin', demo: false }, { expiresIn: '20m' });
  for (const k of ['a', 'b']) {
    uid[k] = Number((await q(`INSERT INTO users (username, email, password, level, is_demo, created_at, updated_at)
      VALUES ($1, $2, '!', 'petani', false, now(), now()) RETURNING id`, [`uji-3d-sk-${k}`, `uji-3d-sk-${k}@contoh.invalid`]))[0].id);
    tok[k] = craftToken({ sub: uid[k], username: `uji-3d-sk-${k}`, level: 'petani', demo: false }, { expiresIn: '20m' });
  }
  for (let i = 0; i < 3; i += 1) {
    meja.push(Number((await q('INSERT INTO mejas (meja, jumlah_lubang, created_at, updated_at) VALUES ($1, 10, now(), now()) RETURNING id_meja', [`uji-3d-sk-${i}`]))[0].id_meja));
    await q('INSERT INTO penugasan_penampung (id_user, id_meja, dibuat_oleh) VALUES ($1, $2, $3)', [uid.a, meja[i], idAdmin]); // a ditugaskan; b tidak
  }
  tanaman = Number((await q("INSERT INTO tanamen (nama_tanaman, created_at, updated_at) VALUES ('uji-3d-sk', now(), now()) RETURNING id_tanaman"))[0].id_tanaman);
});

after(async () => {
  if (lewati) { await pool.end(); return; }
  try {
    const ids = [...siklus];
    await q("DELETE FROM notifikasi WHERE (tautan->>'id_siklus')::bigint = ANY($1) OR (tautan->>'tipe' = 'siklus' AND (tautan->>'id')::bigint = ANY($1))", [ids]);
    await q("DELETE FROM audit_logs WHERE tabel = 'siklus_budidaya' AND row_id = ANY($1::text[])", [ids.map(String)]);
    await q('DELETE FROM siklus_transisi WHERE id_siklus = ANY($1)', [ids]);
    await q('DELETE FROM permintaan_konfirmasi WHERE id_siklus = ANY($1)', [ids]);
    await q('DELETE FROM siklus_budidaya WHERE id = ANY($1)', [ids]);
    await q('DELETE FROM penampung_states WHERE id_meja = ANY($1)', [meja]);
    await q("DELETE FROM audit_logs WHERE tabel = 'penugasan_penampung' AND row_id IN (SELECT id::text FROM penugasan_penampung WHERE id_meja = ANY($1))", [meja]);
    await q('DELETE FROM penugasan_penampung WHERE id_meja = ANY($1)', [meja]);
    await q('DELETE FROM mejas WHERE id_meja = ANY($1)', [meja]);
    await q('DELETE FROM tanamen WHERE id_tanaman = $1', [tanaman]);
    await q('DELETE FROM users WHERE id = ANY($1)', [Object.values(uid)]);
  } finally {
    await stopChild(srv?.child);
    await pool.end();
  }
});

test('buat siklus: kunci+isi sama dari pengguna lain → 422 tanpa data; pemilik → replay', { skip: lewati }, async () => {
  const k = kunci();
  const body = manual(meja[0]);
  const a = await post('/api/siklus', body, tok.a, k);
  assert.equal(a.status, 201, JSON.stringify(a.body).slice(0, 200));
  const id = a.body.data.id; siklus.add(id);
  for (const [nama, t] of [['petani tak ditugaskan', tok.b], ['admin', admin]]) {
    const r = await post('/api/siklus', body, t, k);
    assert.equal(r.status, 422, `${nama}: ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    assert.equal(r.body.kode, 'idempotency_bentrok', nama);
    assert.equal(r.body.data, undefined, `${nama}: tidak ada data siklus yang bocor`);
  }
  const own = await post('/api/siklus', body, tok.a, k);
  assert.equal(own.status, 200);
  assert.equal(own.body.replay, true);
  assert.equal(own.body.data.id, id);
  assert.equal((await q('SELECT count(*)::int n FROM siklus_budidaya WHERE id_meja_semai = $1', [meja[0]]))[0].n, 1, 'satu siklus saja');
});

test('transisi: kunci+isi sama dari pengguna lain → 422 tanpa efek tambahan', { skip: lewati }, async () => {
  const s = await post('/api/siklus', manual(meja[1]), tok.a);
  assert.equal(s.status, 201);
  const id = s.body.data.id; siklus.add(id);
  const k = kunci();
  const body = { ke: 'TANK_PREPARATION' };
  assert.equal((await post(`/api/siklus/${id}/transisi`, body, tok.a, k)).status, 200);
  const n0 = await nTransisi(id);
  for (const [nama, t] of [['petani tak ditugaskan', tok.b], ['admin', admin]]) {
    const r = await post(`/api/siklus/${id}/transisi`, body, t, k);
    assert.equal(r.status, 422, `${nama}: ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    assert.equal(r.body.kode, 'idempotency_bentrok', nama);
    assert.equal(r.body.data, undefined, nama);
  }
  assert.equal(await nTransisi(id), n0, 'tanpa transisi tambahan');
  const own = await post(`/api/siklus/${id}/transisi`, body, tok.a, k);
  assert.equal(own.status, 200);
  assert.equal(own.body.replay, true);
});

test('balapan: dua permintaan identik dari pemilik yang sama tetap satu efek + replay', { skip: lewati }, async () => {
  const k = kunci();
  const body = manual(meja[2]);
  const [r1, r2] = await Promise.all([post('/api/siklus', body, tok.a, k), post('/api/siklus', body, tok.a, k)]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 201], JSON.stringify([r1.body, r2.body]).slice(0, 300));
  assert.equal(r1.body.data.id, r2.body.data.id);
  siklus.add(r1.body.data.id);
  assert.equal((await q('SELECT count(*)::int n FROM siklus_budidaya WHERE id_meja_semai = $1', [meja[2]]))[0].n, 1);
});
