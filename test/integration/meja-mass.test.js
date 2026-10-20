'use strict';
/**
 * Integripsi gelombang-2 #7 — MASS-ASSIGNMENT POST /meja (mandat 6) + NET-ZERO.
 *
 * Kontrak (src/routes/_crud.js): kolom di luar whitelist `columns` TIDAK ikut
 * INSERT (dibuang oleh `fields = columns.filter(...)` + warnUnknown), jadi kiriman
 * role/id/created_at/level/is_demo/password/expires_at harus DIABAIKAN — bukan
 * 422, bukan tersimpan. Diuji: POST 201 → verifikasi via GET id baru → DELETE →
 * jumlah baris /meja kembali persis ke baseline (prefix unik 'itest-w2-').
 *
 * ── KOORDINASI PARALEL ────────────────────────────────────────────────────────
 * node --test menjalankan SEMUA file secara paralel, dan file lama
 * test/integration/meja.test.js meng-assert jumlah baris /meja == baseline-nya
 * di tiga titik (hook before, tes DELETE, hook after). Bila baris uji suite ini
 * hidup pada salah satu titik itu, suite LAMA bisa merah — bukan karena kode,
 * tapi karena antrean. Karena itu sebelum menyentuh /meja, file ini MENUNGGU
 * proses meja.test.js benar-benar keluar (sinyal via `ps` + jeda aman), lalu
 * mengambil baseline baru. Bila prosesnya tak pernah terlihat dalam 15 dtk,
 * dianggap sudah selesai sebelum file ini dimulai (dicatat via diagnostic).
 * 1 login admin; baris uji memakai prefix unik; 0 baris prefix tersisa.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { execSync } = require('node:child_process');
const { startServer, adminToken, bearer, delay } = require('./_server');

const PREFIX = 'itest-w2-';
const FILE_LAMA = 'test/integration/meja.test.js';

let srv;
let base;
let auth;
let baseline = 0;
let rowId = null;
let namaUji = null;
let catatanTunggu = 'belum dijalankan';

/** Apakah proses test file lama masih berjalan? (cmdline anak runner berakhir dgn path file) */
function prosesMejaLamaJalan() {
  try {
    const out = execSync('ps -axo args=', {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 * 1024 * 1024,
    });
    return out.split('\n').some((baris) => baris.trim().endsWith(FILE_LAMA));
  } catch {
    return false; // ps gagal → jangan menghambat suite
  }
}

/**
 * Tunggu sampai meja.test.js pasti sudah selesai (proses terlihat lalu hilang),
 * atau sudah tak terlihat selama 15 dtk (sudah keluar sebelum file ini mulai).
 */
async function tungguMejaLamaSelesai() {
  const deadline = Date.now() + 15_000;
  let pernahLihat = false;
  for (;;) {
    if (prosesMejaLamaJalan()) {
      pernahLihat = true;
      await delay(100);
      continue;
    }
    if (pernahLihat) {
      await delay(400); // jarak aman: hook after mereka sudah pasti keluar sebelum proses exit
      return 'proses meja.test.js terlihat lalu selesai — baseline diambil sesudahnya';
    }
    if (Date.now() > deadline) {
      return 'meja.test.js tidak terlihat dalam 15 dtk (dianggap sudah selesai sebelum file ini)';
    }
    await delay(100);
  }
}

/** Hapus baris prefix suite ini dari run sebelumnya, kembalikan sisa bersih. */
async function bersihkanPrefixSendiri() {
  const daftar = await request(base).get('/meja').set(auth);
  assert.equal(daftar.status, 200, `GET /meja gagal: ${daftar.text}`);
  let terhapus = 0;
  for (const r of daftar.body) {
    if (String(r.meja).startsWith(PREFIX)) {
      const del = await request(base).delete(`/meja/${r.id_meja}`).set(auth);
      assert.equal(del.status, 200, `cleanup baris sisa ${r.id_meja} gagal: ${del.text}`);
      terhapus += 1;
    }
  }
  const sesudah = await request(base).get('/meja').set(auth);
  assert.equal(sesudah.body.some((r) => String(r.meja).startsWith(PREFIX)), false,
    'prefix suite ini masih tersisa setelah cleanup');
  return { total: sesudah.body.length, terhapus };
}

before(async () => {
  catatanTunggu = await tungguMejaLamaSelesai();
  srv = await startServer();
  base = srv.base;
  auth = bearer(await adminToken(base));
  const bersih = await bersihkanPrefixSendiri();
  baseline = bersih.total;
});

after(async () => {
  if (!srv) return;
  // Jaring pengaman: baris uji yang tersisa (tes gagal di tengah) dihapus dulu.
  const daftar = await request(base).get('/meja').set(auth);
  const sisa = daftar.body.filter((r) => String(r.meja).startsWith(PREFIX));
  for (const r of sisa) await request(base).delete(`/meja/${r.id_meja}`).set(auth);
  assert.equal(daftar.body.length - sisa.length, baseline,
    'NET-ZERO gagal: jumlah baris /meja berbeda dari baseline suite ini');
  const akhir = await request(base).get('/meja').set(auth);
  assert.equal(akhir.body.some((r) => String(r.meja).startsWith(PREFIX)), false,
    '0 baris prefix test-mu boleh tersisa');
  console.log(`# [meja-mass] ${catatanTunggu}; baseline=${baseline}, sesudah=${akhir.body.length}`);
  await srv.stop();
});

test('POST /meja mass-assignment (role, id, created_at, level, is_demo, password, expires_at) → 201, field di luar whitelist DIABAIKAN', async () => {
  namaUji = `${PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const KIRIMAN_CACAT = {
    meja: namaUji,
    jumlah_lubang: 6,
    role: 'admin',
    id: 999999,
    created_at: '2000-01-01T00:00:00.000Z',
    updated_at: '2001-01-01T00:00:00.000Z',
    expires_at: '2002-01-01T00:00:00.000Z',
    level: 'root',
    is_demo: true,
    password: 'akusukasandi',
  };
  const res = await request(base).post('/meja').set(auth).send(KIRIMAN_CACAT);
  assert.equal(res.status, 201, `mass-assignment harus 201 (field dibuang, bukan ditolak): ${res.text}`);
  assert.equal(res.body.status, true);
  const data = res.body.data;
  rowId = data.id_meja;
  assert.ok(rowId, 'INSERT RETURNING harus mengembalikan id_meja');

  // Kolom whitelist tetap tersimpan apa adanya.
  assert.equal(data.meja, namaUji);
  assert.equal(data.jumlah_lubang, 6);

  // Field berlebih DIABAIKAN — tidak ada satu pun yang terbentuk di hasil INSERT.
  for (const kolom of ['role', 'level', 'is_demo', 'password']) {
    assert.equal(data[kolom], undefined, `mass-assignment bocor: ${kolom} ikut tersimpan/keluar`);
  }
  assert.equal(data.id, undefined, 'field "id" asing tidak boleh ada (PK tetap id_meja)');
  assert.ok('id_meja' in data, 'PK resmi id_meja tetap ada');
  for (const kolom of ['created_at', 'updated_at', 'expires_at']) {
    assert.notEqual(data[kolom], KIRIMAN_CACAT[kolom],
      `stempel waktu ${kolom} tidak boleh bisa dipalsukan klien`);
  }
});

test('GET /meja/:id (verifikasi baris baru) → 200, field berlebih tetap TIDAK tersimpan', async () => {
  assert.ok(rowId, 'baris uji belum dibuat (tes sebelumnya gagal)');
  const res = await request(base).get(`/meja/${rowId}`).set(auth);
  assert.equal(res.status, 200, `body: ${res.text}`);
  assert.equal(res.body.id_meja, rowId);
  assert.equal(res.body.meja, namaUji);
  assert.equal(res.body.jumlah_lubang, 6);
  for (const kolom of ['role', 'level', 'is_demo', 'password', 'id']) {
    assert.equal(res.body[kolom], undefined, `${kolom} bocor tersimpan di DB (mass-assignment gagal)`);
  }
  assert.notEqual(res.body.created_at, '2000-01-01T00:00:00.000Z', 'created_at kiriman tidak boleh dipakai');
  assert.notEqual(res.body.expires_at, '2002-01-01T00:00:00.000Z', 'expires_at kiriman tidak boleh dipakai');
});

test('DELETE /meja/:id → 200 lalu NET-ZERO: jumlah baris kembali persis ke baseline, 0 prefix tersisa', async () => {
  assert.ok(rowId, 'baris uji belum dibuat (tes sebelumnya gagal)');
  const del = await request(base).delete(`/meja/${rowId}`).set(auth);
  assert.equal(del.status, 200, `body: ${del.text}`);
  assert.deepEqual(del.body, { status: true, message: 'Data dihapus.' });

  const hilang = await request(base).get(`/meja/${rowId}`).set(auth);
  assert.equal(hilang.status, 404, 'baris uji harus benar-benar hilang');

  const daftar = await request(base).get('/meja').set(auth);
  assert.equal(daftar.body.length, baseline,
    `jumlah baris /meja ${daftar.body.length} != baseline ${baseline}`);
  assert.equal(daftar.body.some((r) => String(r.meja).startsWith(PREFIX)), false,
    'tidak boleh ada baris prefix suite ini tersisa');
  rowId = null;
});
