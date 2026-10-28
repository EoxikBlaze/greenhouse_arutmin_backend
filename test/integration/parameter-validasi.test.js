'use strict';
/**
 * Fase 3B.2 — validasi parameter keselamatan oleh admin (/api/parameter/:tabel/:param/validasi).
 * HANYA DB uji (`garap_uji*`): mengubah status validasi `mixing_menit` sementara, dipulihkan di after().
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { startServer, stopChild, craftToken, bearer, delay } = require('./_server');
const { pool, q } = require('../../src/db');

const namaDb = new URL(process.env.DATABASE_URL || 'postgres://x/none').pathname.slice(1);
const lewati = namaDb.startsWith('garap_uji') ? false : `hanya untuk DB uji garap_uji* (sekarang: ${namaDb || 'dari .env'})`;
let srv; let admin; let petani; let demo; let awal;
const BUKTI = 'uji 3B.2: hasil uji pencampuran tandon 100 L (dokumen uji)';
const url = (p = 'mixing_menit') => `/api/parameter/timing_operasi/${p}/validasi`;

before(async () => {
  if (lewati) return;
  awal = await q('SELECT param, nilai, tervalidasi, divalidasi_oleh, divalidasi_pada, catatan_validasi FROM timing_operasi');
  srv = await startServer();
  const idAdmin = Number((await q("SELECT id FROM users WHERE level = 'admin' AND NOT is_demo ORDER BY id LIMIT 1"))[0].id);
  admin = craftToken({ sub: idAdmin, username: 'garap', level: 'admin', demo: false }, { expiresIn: '10m' });
  petani = craftToken({ sub: idAdmin, username: 'p', level: 'petani', demo: false }, { expiresIn: '10m' });
  demo = craftToken({ sub: idAdmin, username: 'd', level: 'user', demo: true }, { expiresIn: '10m' });
});
after(async () => {
  if (!lewati) {
    try {
      await q("DELETE FROM audit_logs WHERE tabel = 'timing_operasi' AND meta->>'aksi' = 'validasi_parameter' AND after_data->>'bukti' LIKE 'uji 3B.2%'");
      for (const p of awal) {
        await q('UPDATE timing_operasi SET nilai = $2, tervalidasi = $3, divalidasi_oleh = $4, divalidasi_pada = $5, catatan_validasi = $6 WHERE param = $1',
          [p.param, p.nilai, p.tervalidasi, p.divalidasi_oleh, p.divalidasi_pada, p.catatan_validasi]);
      }
    } finally { await stopChild(srv?.child); }
  }
  await pool.end();
});

const kirim = (body, t = admin, u = url()) => request(srv.base).post(u).set(bearer(t)).send(body);
const status = async (p) => (await request(srv.base).get('/api/parameter').set(bearer(admin))).body.find((x) => x.param === p).status;

test('3B.2 validasi: hanya admin; jalan pintas & bukti lemah ditolak', { skip: lewati }, async () => {
  assert.equal((await kirim({ nilai_diperiksa: 15, bukti: BUKTI }, petani)).status, 403);
  assert.equal((await kirim({ nilai_diperiksa: 15, bukti: BUKTI }, demo)).status, 403);
  assert.equal((await kirim({ tervalidasi: true })).status, 422, 'tidak ada jalan pintas {tervalidasi:true}');
  assert.equal((await kirim({ nilai_diperiksa: 15, bukti: 'singkat' })).status, 422);
  assert.equal((await kirim({ nilai_diperiksa: 15, bukti: BUKTI }, admin, '/api/parameter/users/password/validasi')).status, 404);
  assert.equal((await kirim({ nilai_diperiksa: 15, bukti: BUKTI }, admin, url('tidak_ada'))).status, 422);
  assert.equal(await status('mixing_menit'), 'BELUM_TERVALIDASI');
});

test('3B.2 validasi: nilai aktif harus sama dengan yang diperiksa; NULL tidak bisa divalidasi', { skip: lewati }, async () => {
  const beda = await kirim({ nilai_diperiksa: 20, bukti: BUKTI });
  assert.equal(beda.status, 409);
  assert.equal(beda.body.kode, 'nilai_berubah');
  assert.equal(beda.body.nilai_aktif, 15);
  const kosong = await kirim({ nilai_diperiksa: 12, bukti: BUKTI }, admin, url('ulang_konfirmasi_jam'));
  assert.equal(kosong.body.kode, 'nilai_tidak_sah');
});

test('3B.2 validasi: sukses → SIAP + audit; ulang 409; nilai berubah → gugur', { skip: lewati }, async () => {
  const r = await kirim({ nilai_diperiksa: 15, bukti: BUKTI });
  assert.equal(r.status, 200, r.text);
  assert.equal(await status('mixing_menit'), 'SIAP');
  const a = await q("SELECT actor_user_id FROM audit_logs WHERE tabel = 'timing_operasi' AND row_id = 'mixing_menit' AND meta->>'aksi' = 'validasi_parameter' ORDER BY id DESC LIMIT 1");
  assert.equal(a.length, 1);
  assert.equal((await kirim({ nilai_diperiksa: 15, bukti: BUKTI })).body.kode, 'sudah_tervalidasi');
  const put = await request(srv.base).put('/timing-operasi/mixing_menit').set(bearer(admin)).send({ nilai: 16 });
  assert.equal(put.status, 200, put.text);
  assert.equal(await status('mixing_menit'), 'BELUM_TERVALIDASI', 'nilai berubah → validasi gugur');
});

test('3B.2 validasi: perubahan nilai bersamaan tidak membuat nilai lain ikut tervalidasi', { skip: lewati }, async () => {
  await q("UPDATE timing_operasi SET nilai = 15, tervalidasi = false, divalidasi_pada = NULL, divalidasi_oleh = NULL, catatan_validasi = NULL WHERE param = 'mixing_menit'");
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("UPDATE timing_operasi SET nilai = 25 WHERE param = 'mixing_menit'");
    let selesai = false;
    const jalan = kirim({ nilai_diperiksa: 15, bukti: BUKTI }).then((r) => { selesai = true; return r; });
    await delay(400);
    assert.equal(selesai, false, 'validasi menunggu perubahan yang sedang berjalan');
    await c.query('COMMIT');
    const r = await jalan;
    assert.equal(r.status, 409);
    assert.equal(r.body.kode, 'nilai_berubah');
  } finally { c.release(); }
  const row = (await q("SELECT nilai, tervalidasi FROM timing_operasi WHERE param = 'mixing_menit'"))[0];
  assert.equal(Number(row.nilai), 25);
  assert.equal(row.tervalidasi, false);
});
