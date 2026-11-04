'use strict';
/**
 * Paginasi daftar tahap tanam (temuan uji beban Pi: 50 rb semai → /semai 12,5 MB, /semai/selesai 15,7 MB).
 *  - GET /semai, /peremajaan, /pendewasaan, /panen : ?limit (bawaan 200, maks 1000) & ?offset, header X-Total-Count
 *  - GET /semai/selesai                            : sama
 *  - GET /tanam                                    : tiap tahap dipotong ?limit (bawaan 200) → `terpotong: true`
 *  - tabel master kecil (/meja) TIDAK berubah (tetap array penuh, tanpa header total).
 * Bentuk respons tetap ARRAY / {page,list} → Flutter dan web lama tetap jalan.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { pool, q } = require('../../src/db');
const { startServer, adminToken, bearer } = require('./_server');

let srv;
let base;
let auth;
const TOTAL = 250;

before(async () => {
  srv = await startServer();
  base = srv.base;
  auth = bearer(await adminToken(base));
  await q(`INSERT INTO semais (jumlah_benih, tgl_awal_semai, tgl_akhir_semai, status, keterangan, created_at, updated_at)
           SELECT 50, current_date, current_date + 7, CASE WHEN g <= 30 THEN 'selesai' ELSE 'proses' END, 'uji-paginasi', now(), now()
           FROM generate_series(1, ${TOTAL}) g`);
});

after(async () => {
  await q("DELETE FROM semais WHERE keterangan = 'uji-paginasi'");
  if (srv) await srv.stop();
  await pool.end();
});

const ambil = (path) => request(base).get(path).set(auth);

test('/semai: ?limit & ?offset → potongan terurut baru→lama, tanpa tumpang tindih, X-Total-Count', async () => {
  const a = await ambil('/semai?limit=5');
  assert.equal(a.status, 200, a.text);
  assert.equal(a.body.length, 5);
  assert.ok(Number(a.headers['x-total-count']) >= TOTAL, `total ${a.headers['x-total-count']}`);
  const b = await ambil('/semai?limit=5&offset=5');
  assert.equal(b.body.length, 5);
  const idA = a.body.map((r) => Number(r.id_semai));
  const idB = b.body.map((r) => Number(r.id_semai));
  assert.deepEqual(idA, [...idA].sort((x, y) => y - x), 'baru → lama');
  assert.ok(Math.min(...idA) > Math.max(...idB), 'halaman 2 lebih lama dari halaman 1, tanpa tumpang tindih');
});

test('/semai: tanpa parameter → dipotong 200 (bukan semua baris); nilai ngawur → bawaan, tidak 500', async () => {
  const def = await ambil('/semai');
  assert.equal(def.status, 200);
  assert.equal(def.body.length, 200);
  assert.ok(Number(def.headers['x-total-count']) >= TOTAL);
  for (const qs of ['limit=abc', 'limit=0', 'limit=-5', 'limit=1.5', 'offset=-3', 'offset=xyz']) {
    const r = await ambil(`/semai?${qs}`);
    assert.equal(r.status, 200, `${qs}: ${r.text}`);
    assert.ok(r.body.length >= 1 && r.body.length <= 200, `${qs} → ${r.body.length}`);
  }
  const besar = await ambil('/semai?limit=999999');
  assert.equal(besar.status, 200);
  assert.ok(besar.body.length <= 1000, 'batas atas 1000');
  assert.ok(besar.body.length >= TOTAL, 'semua baris uji tetap terkirim bila ≤ batas atas');
});

test('/semai: offset melewati akhir → array kosong, total tetap benar', async () => {
  const r = await ambil('/semai?offset=100000');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, []);
  assert.ok(Number(r.headers['x-total-count']) >= TOTAL);
});

test('/semai/selesai: dipaginasi + total hanya baris berstatus selesai', async () => {
  const r = await ambil('/semai/selesai?limit=10');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.length, 10);
  assert.ok(r.body.every((x) => x.status === 'selesai'));
  const [{ n }] = await q("SELECT count(*)::int AS n FROM semais WHERE status = 'selesai'");
  assert.equal(Number(r.headers['x-total-count']), n);
});

test('/peremajaan /pendewasaan /panen: memakai paginasi yang sama (header total ada)', async () => {
  for (const p of ['/peremajaan', '/pendewasaan', '/panen']) {
    const r = await ambil(`${p}?limit=2`);
    assert.equal(r.status, 200, `${p}: ${r.text}`);
    assert.ok(Array.isArray(r.body) && r.body.length <= 2, p);
    assert.ok(r.headers['x-total-count'] !== undefined, `${p} tanpa X-Total-Count`);
  }
});

test('/tanam: tiap tahap dipotong → terpotong:true, bentuk {page,list} tetap', async () => {
  const r = await ambil('/tanam');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.page, 'tanam');
  assert.equal(r.body.list.filter((x) => x.tipe === 'semai').length, 200);
  assert.equal(r.body.terpotong, true);
  const kecil = await ambil('/tanam?limit=5');
  assert.equal(kecil.body.list.filter((x) => x.tipe === 'semai').length, 5);
  assert.equal(kecil.body.terpotong, true);
});

test('tabel master kecil (/meja) tidak berubah: array penuh, tanpa X-Total-Count', async () => {
  const r = await ambil('/meja');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body));
  const [{ n }] = await q('SELECT count(*)::int AS n FROM mejas');
  assert.equal(r.body.length, n);
  assert.equal(r.headers['x-total-count'], undefined);
});
