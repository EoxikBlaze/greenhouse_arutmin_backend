'use strict';
/**
 * Fase 3C — alur persetujuan dosing lewat API + evaluasi percobaan (FAULT 4× gagal berturut).
 *
 * HANYA di DB uji (`garap_uji*`). Membuat user/meja/tanaman/siklus uji `uji-3c`, mengubah parameter sementara
 * (maks_masa_persetujuan_menit diisi NILAI UJI 60, batas lain hanya ditandai tervalidasi), semuanya dipulihkan di
 * after(). Tidak ada perangkat/MQTT: yang diuji hanya baris DB; dipastikan TIDAK ADA perintah DOSIS yang diantre.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');
const { startServer, stopChild, craftToken, bearer } = require('./_server');
const { pool, q } = require('../../src/db');
const dosing = require('../../src/dosingSiklus');
const { kunciPenampung, bukaKunci } = require('../../src/aktuator');

const namaDb = new URL(process.env.DATABASE_URL || 'postgres://x/none').pathname.slice(1);
const lewati = namaDb.startsWith('garap_uji') ? false : `hanya untuk DB uji garap_uji* (sekarang: ${namaDb || 'dari .env'})`;

let srv; let base; let admin; let demo; let idAdmin; let tanaman; let paramAwal; let dosisAwal; let lamaAwal;
const tok = {}; const uid = {}; const meja = []; const siklus = [];
const PARAM = ['maks_gagal_berturut', 'maks_masa_persetujuan_menit', 'maks_ml_per_suntikan', 'maks_volume_ab_hari_ml', 'maks_ml_ph_per_suntikan', 'maks_volume_ph_hari_ml'];
const kunci = () => crypto.randomUUID();
const post = (path, body, t = admin, k = kunci()) => request(base).post(path).set(bearer(t)).set('Idempotency-Key', k).send(body);
const cakupan = { pompa_diizinkan: ['AB'], maks_ml_per_percobaan: 20, maks_ml_total: 60, maks_percobaan: 3, berlaku_menit: 30 };
const status = async (id) => (await q('SELECT status FROM dosing_events WHERE id = $1', [id]))[0].status;

async function siklusBaru(idMeja, st = 'TANK_PREPARATION') {
  const id = Number((await q(
    `INSERT INTO siklus_budidaya (id_tanaman, id_meja_semai, mode_target, target, jumlah_benih, status)
     VALUES ($1, $2, 'MANUAL', '{"ec_min_ppm":400,"ec_max_ppm":600,"ph_min":5.8,"ph_max":6.5}', 50, $3) RETURNING id`, [tanaman, idMeja, st]))[0].id);
  siklus.push(id);
  return id;
}

/** Siklus dosing langsung di DB (untuk status yang tidak bisa dicapai lewat API selama eksekusi diblokir). */
async function fixtureDosing(idMeja, st, { berlakuJam = 1, maksPercobaan = 4, total = 500 } = {}) {
  const id = Number((await q(
    `INSERT INTO dosing_events (id_meja, hari, pemicu, aktor_tipe, dipicu_oleh, status, mode, berlaku_sampai)
     VALUES ($1, (now() AT TIME ZONE 'Asia/Makassar')::date, 'USER_MANUAL', 'user', $2, $3, 'MANUAL', now() + interval '1 hour') RETURNING id`,
    [idMeja, idAdmin, st]))[0].id);
  await q(
    `INSERT INTO persetujuan_dosing (id_kejadian, keputusan, oleh, pada, pompa_diizinkan, maks_ml_per_percobaan, maks_ml_total, maks_percobaan, berlaku_sampai, idempotency_key)
     VALUES ($1, 'SETUJU', $2, now() - interval '3 hours', '{AB}', 20, $3, $4, now() + make_interval(secs => $5::float8 * 3600), $6)`,
    [id, idAdmin, total, maksPercobaan, berlakuJam, kunci()]);
  return id;
}

before(async () => {
  if (lewati) return;
  process.env.RATE_LIMIT_WRITE = '1000';
  srv = await startServer(); base = srv.base;
  idAdmin = Number((await q("SELECT id FROM users WHERE level = 'admin' AND NOT is_demo ORDER BY id LIMIT 1"))[0].id);
  admin = craftToken({ sub: idAdmin, username: 'garap', level: 'admin', demo: false }, { expiresIn: '20m' });
  demo = craftToken({ sub: idAdmin, username: 'demo', level: 'user', demo: true }, { expiresIn: '20m' });
  paramAwal = await q('SELECT param, nilai, tervalidasi, divalidasi_pada, catatan_validasi FROM konfigurasi_dosis WHERE param = ANY($1)', [PARAM]);
  dosisAwal = (await q("SELECT count(*)::int n FROM perintah_aktuator WHERE tipe = 'DOSIS'"))[0].n;
  lamaAwal = (await q("SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY id), '')) h FROM dosing_events x WHERE status IS NULL"))[0].h;
  for (const k of ['a', 'b']) {
    uid[k] = Number((await q(`INSERT INTO users (username, email, password, level, is_demo, created_at, updated_at)
      VALUES ($1, $2, '!', 'petani', false, now(), now()) RETURNING id`, [`uji-3c-${k}`, `uji-3c-${k}@contoh.invalid`]))[0].id);
    tok[k] = craftToken({ sub: uid[k], username: `uji-3c-${k}`, level: 'petani', demo: false }, { expiresIn: '20m' });
  }
  for (let i = 0; i < 8; i += 1) {
    meja.push(Number((await q('INSERT INTO mejas (meja, jumlah_lubang, created_at, updated_at) VALUES ($1, 10, now(), now()) RETURNING id_meja', [`uji-3c-${i}`]))[0].id_meja));
  }
  await q('INSERT INTO penugasan_penampung (id_user, id_meja, dibuat_oleh) VALUES ($1, $2, $3)', [uid.a, meja[0], idAdmin]);
  tanaman = Number((await q("INSERT INTO tanamen (nama_tanaman, created_at, updated_at) VALUES ('uji-3c', now(), now()) RETURNING id_tanaman"))[0].id_tanaman);
});

after(async () => {
  if (lewati) { await pool.end(); return; }
  try {
    const ev = (await q('SELECT id FROM dosing_events WHERE id_meja = ANY($1)', [meja])).map((r) => Number(r.id));
    const c = await pool.connect();
    try {
      // persetujuan_dosing beku (trigger) — hanya data uji ini yang dihapus, trigger dipasang lagi di transaksi yang sama
      await c.query('BEGIN');
      await c.query('ALTER TABLE persetujuan_dosing DISABLE TRIGGER persetujuan_dosing_beku');
      await c.query('DELETE FROM persetujuan_dosing WHERE id_kejadian = ANY($1)', [ev]);
      await c.query('ALTER TABLE persetujuan_dosing ENABLE TRIGGER persetujuan_dosing_beku');
      await c.query('COMMIT');
    } finally { c.release(); }
    await q("DELETE FROM notifikasi WHERE tautan->>'tipe' = 'dosing' AND (tautan->>'id')::bigint = ANY($1)", [ev]);
    await q("DELETE FROM audit_logs WHERE (tabel = 'dosing_events' AND row_id = ANY($1::text[])) OR (tabel = 'siklus_budidaya' AND row_id = ANY($2::text[]))", [ev.map(String), siklus.map(String)]);
    await q('DELETE FROM dosing_transisi WHERE id_kejadian = ANY($1)', [ev]);
    await q('DELETE FROM perintah_aktuator WHERE id_kejadian = ANY($1)', [ev]);
    await q('DELETE FROM dosing_events WHERE id = ANY($1)', [ev]);
    await q('DELETE FROM siklus_transisi WHERE id_siklus = ANY($1)', [siklus]);
    await q('DELETE FROM permintaan_konfirmasi WHERE id_siklus = ANY($1)', [siklus]);
    await q('DELETE FROM siklus_budidaya WHERE id = ANY($1)', [siklus]);
    for (const p of paramAwal) {
      await q('UPDATE konfigurasi_dosis SET nilai = $2, tervalidasi = $3, divalidasi_pada = $4, catatan_validasi = $5 WHERE param = $1',
        [p.param, p.nilai, p.tervalidasi, p.divalidasi_pada, p.catatan_validasi]);
    }
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

test('parameter belum diputuskan (maks_masa_persetujuan_menit NULL) → ajukan 409, tanpa angka bawaan', { skip: lewati }, async () => {
  const s = await siklusBaru(meja[0]);
  const r = await post('/api/dosing/siklus', { id_siklus_budidaya: s });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.kode, 'parameter_belum_siap');
  assert.ok(r.body.parameter.some((p) => p.param === 'maks_masa_persetujuan_menit'));
  // nilai uji SEMENTARA (dipulihkan di after); batas lain hanya ditandai tervalidasi, nilainya tidak diubah
  await q("UPDATE konfigurasi_dosis SET nilai = 60 WHERE param = 'maks_masa_persetujuan_menit'");
  await q("UPDATE konfigurasi_dosis SET tervalidasi = true, divalidasi_pada = now(), catatan_validasi = 'uji 3C (sementara)' WHERE param = ANY($1)", [PARAM]);
});

test('ajukan: otorisasi, idempotensi, satu siklus aktif per penampung', { skip: lewati }, async () => {
  const s = (await q('SELECT id FROM siklus_budidaya WHERE id_meja_semai = $1', [meja[0]]))[0].id;
  const body = { id_siklus_budidaya: Number(s), alasan: 'uji 3C' };
  assert.equal((await request(base).post('/api/dosing/siklus').set(bearer(admin)).send(body)).status, 422, 'tanpa Idempotency-Key');
  assert.equal((await post('/api/dosing/siklus', body, demo)).status, 403, 'demo');
  const b = await post('/api/dosing/siklus', body, tok.b);
  assert.equal(b.status, 403, 'petani tidak ditugaskan');
  assert.equal(b.body.kode, 'tidak_ditugaskan');
  assert.equal((await post('/api/dosing/siklus', { id_siklus_budidaya: 'x' })).status, 422);

  const k = kunci();
  const r = await post('/api/dosing/siklus', body, tok.a, k);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.status, 'WAITING_APPROVAL');
  assert.equal(r.body.data.mode, 'MANUAL');
  assert.equal(Number(r.body.data.id_meja), meja[0]);
  assert.equal(r.body.data.transisi.length, 1);
  const ulang = await post('/api/dosing/siklus', body, tok.a, k);
  assert.equal(ulang.status, 200);
  assert.equal(ulang.body.replay, true);
  assert.equal(ulang.body.data.id, r.body.data.id);
  assert.equal((await post('/api/dosing/siklus', { ...body, alasan: 'lain' }, tok.a, k)).status, 422, 'kunci sama, isi beda');
  const dua = await post('/api/dosing/siklus', body, tok.a);
  assert.equal(dua.status, 409);
  assert.equal(dua.body.kode, 'dosing_aktif_ada');
  const audit = await q("SELECT aksi FROM audit_logs WHERE tabel = 'dosing_events' AND row_id = $1", [String(r.body.data.id)]);
  assert.deepEqual(audit.map((x) => x.aksi), ['create']);
});

test('setujui: cakupan dibatasi batas global & parameter; persetujuan beku; jalankan selalu diblokir', { skip: lewati }, async () => {
  const id = Number((await q("SELECT id FROM dosing_events WHERE id_meja = $1 AND status = 'WAITING_APPROVAL'", [meja[0]]))[0].id);
  const coba = async (x, t = tok.a) => post(`/api/dosing/siklus/${id}/setujui`, { cakupan: { ...cakupan, ...x } }, t);
  assert.equal((await coba({}, tok.b)).status, 403);
  for (const [x, f] of [[{ maks_ml_per_percobaan: 215, maks_ml_total: 300 }, 'maks_ml_per_percobaan'], [{ maks_ml_total: 501 }, 'maks_ml_total'],
    [{ maks_percobaan: 5 }, 'maks_percobaan'], [{ berlaku_menit: 61 }, 'berlaku_menit'], [{ pompa_diizinkan: ['PH_UP'], maks_ml_per_percobaan: 11, maks_ml_total: 20 }, 'maks_ml_per_percobaan']]) {
    const r = await coba(x);
    assert.equal(r.status, 422, `${f}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.errors[f], f);
  }
  assert.equal(await status(id), 'WAITING_APPROVAL');

  const r = await coba({});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.status, 'APPROVED');
  const p = r.body.data.persetujuan;
  assert.equal(p.keputusan, 'SETUJU');
  assert.deepEqual(p.pompa_diizinkan, ['AB']);
  assert.ok(Array.isArray(p.kondisi_henti) && p.kondisi_henti.includes('gagal_berturut_maks'));
  assert.equal((await coba({})).status, 409, 'tidak bisa disetujui dua kali');

  const j = await post(`/api/dosing/siklus/${id}/jalankan`, {}, tok.a);
  assert.equal(j.status, 423, JSON.stringify(j.body));
  assert.equal(j.body.kode, 'eksekusi_diblokir');
  assert.ok(j.body.alasan.includes('eksekusi_dosis_diblokir'));
  assert.equal(await status(id), 'APPROVED', 'status tidak berubah');
});

test('cabut: alasan wajib; APPROVED → CANCELLED dan persetujuan dicabut', { skip: lewati }, async () => {
  const id = Number((await q("SELECT id FROM dosing_events WHERE id_meja = $1 AND status = 'APPROVED'", [meja[0]]))[0].id);
  assert.equal((await post(`/api/dosing/siklus/${id}/cabut`, { alasan: 'x' }, tok.a)).status, 422);
  const r = await post(`/api/dosing/siklus/${id}/cabut`, { alasan: 'uji pencabutan' }, tok.a);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.status, 'CANCELLED');
  assert.equal(r.body.data.hasil, 'dibatalkan');
  assert.ok(r.body.data.persetujuan.dicabut_pada);
  assert.equal(r.body.stop, undefined, 'tidak RUNNING → tidak ada STOP');
  assert.equal((await post(`/api/dosing/siklus/${id}/jalankan`, {}, tok.a)).status, 409);
});

test('tolak: WAITING_APPROVAL → REJECTED; kedaluwarsa → 410 + EXPIRED tersimpan', { skip: lewati }, async () => {
  const s = Number((await q('SELECT id FROM siklus_budidaya WHERE id_meja_semai = $1', [meja[0]]))[0].id);
  const a = await post('/api/dosing/siklus', { id_siklus_budidaya: s }, tok.a);
  const t = await post(`/api/dosing/siklus/${a.body.data.id}/tolak`, { alasan: 'belum perlu' }, tok.a);
  assert.equal(t.status, 200);
  assert.equal(t.body.data.status, 'REJECTED');
  assert.equal(t.body.data.persetujuan.keputusan, 'TOLAK');
  assert.equal((await post(`/api/dosing/siklus/${a.body.data.id}/tolak`, {}, tok.a)).status, 409);

  const b = await post('/api/dosing/siklus', { id_siklus_budidaya: s }, tok.a);
  await q("UPDATE dosing_events SET berlaku_sampai = now() - interval '1 minute' WHERE id = $1", [b.body.data.id]);
  const r = await post(`/api/dosing/siklus/${b.body.data.id}/setujui`, { cakupan }, tok.a);
  assert.equal(r.status, 410, JSON.stringify(r.body));
  assert.equal(await status(b.body.data.id), 'EXPIRED');
});

test('penjadwal: APPROVED dengan persetujuan lewat masa berlaku → EXPIRED (idempoten)', { skip: lewati }, async () => {
  const id = await fixtureDosing(meja[1], 'APPROVED', { berlakuJam: -1 });
  assert.ok(await dosing.kedaluwarsakan() >= 1);
  assert.equal(await status(id), 'EXPIRED');
  assert.equal(await dosing.kedaluwarsakan(), 0);
  assert.equal((await q("SELECT count(*)::int n FROM dosing_transisi WHERE id_kejadian = $1 AND ke = 'EXPIRED'", [id]))[0].n, 1);
});

test('jalankan + 3 bacaan mustahil → FAULT, penampung LOCK, notifikasi kritis', { skip: lewati }, async () => {
  const s = await siklusBaru(meja[2]);
  const a = await post('/api/dosing/siklus', { id_siklus_budidaya: s });
  await post(`/api/dosing/siklus/${a.body.data.id}/setujui`, { cakupan });
  for (let i = 0; i < 3; i += 1) {
    await q('INSERT INTO monitorings (ph, tds, "waterTemp", id_meja, created_at, updated_at, n_konfirmasi, celah_maks_detik) VALUES (0.5, 500, 25, $1, now(), now(), 1, 0)', [meja[2]]);
  }
  const r = await post(`/api/dosing/siklus/${a.body.data.id}/jalankan`, {});
  assert.equal(r.status, 423, JSON.stringify(r.body));
  assert.equal(r.body.kode, 'sensor_rusak');
  assert.equal(await status(a.body.data.id), 'FAULT');
  const st = (await q('SELECT status_lock FROM penampung_states WHERE id_meja = $1', [meja[2]]))[0];
  assert.equal(st.status_lock, true);
  assert.equal((await q("SELECT count(*)::int n FROM notifikasi WHERE dedup_key = $1 AND severity = 'critical'", [`dosing-fault:${a.body.data.id}`]))[0].n, 1);
  // LOCK → ajukan baru ditolak 423
  assert.equal((await post('/api/dosing/siklus', { id_siklus_budidaya: s })).status, 423);
});

test('LOCK dari aktuator: WAITING → CANCELLED, RUNNING → FAULT, tercatat di dosing_transisi', { skip: lewati }, async () => {
  const w = await fixtureDosing(meja[3], 'WAITING_APPROVAL');
  const j = await fixtureDosing(meja[4], 'RUNNING');
  await kunciPenampung(meja[3], { alasan: 'uji', type: 'volume_tidak_pasti', value: 'uji' });
  await kunciPenampung(meja[4], { alasan: 'uji', type: 'volume_tidak_pasti', value: 'uji' });
  assert.equal(await status(w), 'CANCELLED');
  assert.equal(await status(j), 'FAULT');
  const t = await q('SELECT id_kejadian, dari, ke, aktor_tipe FROM dosing_transisi WHERE id_kejadian = ANY($1) ORDER BY id_kejadian', [[w, j]]);
  assert.deepEqual(t.map((x) => [Number(x.id_kejadian), x.dari, x.ke, x.aktor_tipe]), [[w, 'WAITING_APPROVAL', 'CANCELLED', 'system'], [j, 'RUNNING', 'FAULT', 'system']]);
  await bukaKunci(meja[3], 'uji'); await bukaKunci(meja[4], 'uji');
});

test('evaluasi: 4 GAGAL berturut → FAULT + LOCK; KURANG mereset hitungan', { skip: lewati }, async () => {
  const id = await fixtureDosing(meja[5], 'VERIFYING');
  const ronde = async (n) => Number((await q("INSERT INTO dosing_rounds (id_kejadian, ronde_ke, jenis, volume_ml) VALUES ($1, $2, 'AB', 10) RETURNING id", [id, n]))[0].id);
  const verif = () => q("UPDATE dosing_events SET status = 'VERIFYING' WHERE id = $1", [id]);
  const hasil = [];
  for (const [i, ev] of ['GAGAL', 'KURANG'].entries()) {
    const r = await dosing.terapkanEvaluasi(id, await ronde(i + 1), ev);
    hasil.push([r.status, (await q('SELECT gagal_berturut FROM dosing_events WHERE id = $1', [id]))[0].gagal_berturut]);
    await verif();
  }
  assert.deepEqual(hasil, [['APPROVED', 1], ['APPROVED', 0]], 'GAGAL +1, KURANG reset');

  const id2 = await fixtureDosing(meja[6], 'VERIFYING');
  const st = [];
  for (let i = 1; i <= 4; i += 1) {
    const rd = Number((await q("INSERT INTO dosing_rounds (id_kejadian, ronde_ke, jenis, volume_ml) VALUES ($1, $2, 'AB', 10) RETURNING id", [id2, i]))[0].id);
    st.push((await dosing.terapkanEvaluasi(id2, rd, 'GAGAL')).status);
    if (i < 4) await q("UPDATE dosing_events SET status = 'VERIFYING' WHERE id = $1", [id2]);
  }
  assert.deepEqual(st, ['APPROVED', 'APPROVED', 'APPROVED', 'FAULT']);
  const ev = (await q('SELECT gagal_berturut, hasil, lock_terpicu FROM dosing_events WHERE id = $1', [id2]))[0];
  assert.deepEqual([ev.gagal_berturut, ev.hasil, ev.lock_terpicu], [4, 'lock', true]);
  assert.equal((await q('SELECT status_lock FROM penampung_states WHERE id_meja = $1', [meja[6]]))[0].status_lock, true);
  assert.equal((await q("SELECT count(*)::int n FROM alert_logs WHERE id_meja = $1 AND type = 'retry_habis'", [meja[6]]))[0].n, 1);
});

test('evaluasi: OK → SUCCESS, KELEBIHAN → FAULT, cakupan habis → EXHAUSTED, evaluasi ganda ditolak', { skip: lewati }, async () => {
  const okId = await fixtureDosing(meja[7], 'VERIFYING');
  const rd = Number((await q("INSERT INTO dosing_rounds (id_kejadian, ronde_ke, jenis, volume_ml) VALUES ($1, 1, 'AB', 10) RETURNING id", [okId]))[0].id);
  assert.equal((await dosing.terapkanEvaluasi(okId, rd, 'OK')).status, 'SUCCESS');
  await assert.rejects(dosing.terapkanEvaluasi(okId, rd, 'OK'), /VERIFYING/);

  const hb = await fixtureDosing(meja[7], 'VERIFYING', { maksPercobaan: 1 });
  const r1 = Number((await q("INSERT INTO dosing_rounds (id_kejadian, ronde_ke, jenis, volume_ml) VALUES ($1, 1, 'AB', 10) RETURNING id", [hb]))[0].id);
  assert.equal((await dosing.terapkanEvaluasi(hb, r1, 'KURANG')).status, 'EXHAUSTED');

  const kl = await fixtureDosing(meja[7], 'VERIFYING');
  const r2 = Number((await q("INSERT INTO dosing_rounds (id_kejadian, ronde_ke, jenis, volume_ml) VALUES ($1, 1, 'AB', 10) RETURNING id", [kl]))[0].id);
  assert.equal((await dosing.terapkanEvaluasi(kl, r2, 'KELEBIHAN')).status, 'FAULT');
  assert.equal((await q('SELECT status_lock FROM penampung_states WHERE id_meja = $1', [meja[7]]))[0].status_lock, true);
});

test('batal siklus budidaya → siklus dosing WAITING ikut CANCELLED', { skip: lewati }, async () => {
  await bukaKunci(meja[1], 'uji').catch(() => {});
  const s = await siklusBaru(meja[1]);
  const a = await post('/api/dosing/siklus', { id_siklus_budidaya: s });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  const r = await post(`/api/siklus/${s}/transisi`, { ke: 'CANCELLED', alasan: 'uji batal 3C' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await status(a.body.data.id), 'CANCELLED');
});

test('tidak ada perintah DOSIS yang diantre; kejadian lama tidak tersentuh', { skip: lewati }, async () => {
  assert.equal((await q("SELECT count(*)::int n FROM perintah_aktuator WHERE tipe = 'DOSIS'"))[0].n, dosisAwal);
  assert.equal((await q("SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY id), '')) h FROM dosing_events x WHERE status IS NULL"))[0].h, lamaAwal);
  const g = await request(base).get(`/api/dosing/siklus?id_meja=${meja[0]}`).set(bearer(admin));
  assert.equal(g.status, 200);
  assert.ok(g.body.data.length >= 3);
  assert.equal((await request(base).get('/api/dosing/siklus?status=NGAWUR').set(bearer(admin))).status, 422);
  assert.equal((await request(base).get('/api/dosing/siklus/999999999').set(bearer(admin))).status, 404);
});
