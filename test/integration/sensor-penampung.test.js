'use strict';
/**
 * B2 — bacaan sensor bertanda penampung (id_meja) dan otomasi hanya memakai bacaan penampungnya sendiri.
 * Membuat 2 meja uji + 1 kunci sensor; semuanya dihapus di after().
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { startServer, adminToken, bearer } = require('./_server');
const { q } = require('../../src/db');

let srv; let base; let kunci; let idKunci; let mejaA; let mejaB;
const TANDA = 77.77; // humidity penanda baris uji (mudah dibersihkan)
const hdr = () => ({ 'X-API-KEY': kunci });
const kirim = (body) => request(base).post('/api/device/v1/sensor').set(hdr()).send({ humidity: TANDA, ...body });
const barisUji = () => q('SELECT id_meja, tds FROM monitorings WHERE humidity = $1 ORDER BY id', [TANDA]);

before(async () => {
  srv = await startServer(); base = srv.base;
  const admin = await adminToken(base);
  const r = await request(base).post('/api/kunci').set(bearer(admin)).send({ nama: 'uji-penampung', perangkat_kode: 'sensor-01' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  kunci = r.body.data.kunci; idKunci = r.body.data.id;
  const ins = (nama) => q('INSERT INTO mejas (meja, jumlah_lubang, created_at, updated_at) VALUES ($1, 1, now(), now()) RETURNING id_meja', [nama]);
  mejaA = Number((await ins('uji-penampung-A'))[0].id_meja);
  mejaB = Number((await ins('uji-penampung-B'))[0].id_meja);
});

after(async () => {
  await q('DELETE FROM monitorings WHERE humidity = $1', [TANDA]);
  await q('DELETE FROM mejas WHERE id_meja = ANY($1::bigint[])', [[mejaA, mejaB]]);
  if (idKunci) await q('DELETE FROM api_keys WHERE id = $1', [idKunci]);
  await srv.stop();
});

test('B2 ingest: id_meja valid disimpan; dikirim angka atau string numerik', async () => {
  assert.equal((await kirim({ tds: 701, id_meja: mejaA })).status, 200);
  assert.equal((await kirim({ tds: 702, id_meja: String(mejaB) })).status, 200);
  const rows = await barisUji();
  assert.deepEqual(rows.slice(-2).map((r) => [Number(r.id_meja), Number(r.tds)]), [[mejaA, 701], [mejaB, 702]]);
});

test('B2 ingest: id_meja tidak sah → 422 errors.id_meja dan TIDAK menulis baris', async () => {
  const sebelum = (await barisUji()).length;
  for (const id of [0, -3, 1.5, 'abc', '12x', true, { a: 1 }, [mejaA], 999999999999]) {
    const r = await kirim({ tds: 703, id_meja: id });
    assert.equal(r.status, 422, `id_meja ${JSON.stringify(id)} → ${r.status}`);
    assert.ok(r.body.errors && r.body.errors.id_meja, JSON.stringify(r.body));
  }
  assert.equal((await barisUji()).length, sebelum);
});

test('B2 ingest: tanpa id_meja (firmware lama) tetap diterima, tersimpan NULL', async () => {
  assert.equal((await kirim({ tds: 704 })).status, 200);
  const r = (await barisUji()).at(-1);
  assert.equal(r.id_meja, null);
  assert.equal(Number(r.tds), 704);
});

test('B2 ingest: anti-duplikat per penampung — payload sama ke dua meja tetap dua baris', async () => {
  const sebelum = (await barisUji()).length;
  await kirim({ tds: 705, ph: 6.1, id_meja: mejaA });
  await kirim({ tds: 705, ph: 6.1, id_meja: mejaB });
  await kirim({ tds: 705, ph: 6.1, id_meja: mejaB }); // duplikat persis meja B → dilewati
  assert.equal((await barisUji()).length, sebelum + 2);
});

