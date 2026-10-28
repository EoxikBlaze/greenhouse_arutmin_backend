'use strict';
/**
 * Fase 3B.3 — rancangan Water Control (src/kontrolAir.js, BELUM dipasang ke rute). Perangkat disimulasikan
 * lewat antrean DB (ambilPerintah/laporHasil); tidak ada perangkat fisik. HANYA DB uji (`garap_uji*`, migrasi 05).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool, q } = require('../../src/db');
const { mintaKontrolAir, statusKontrolAir } = require('../../src/kontrolAir');
const { ambilPerintah, laporHasil, resetEstop } = require('../../src/aktuator');

const namaDb = new URL(process.env.DATABASE_URL || 'postgres://x/none').pathname.slice(1);
const lewati = namaDb.startsWith('garap_uji') ? false : `hanya untuk DB uji garap_uji* (sekarang: ${namaDb || 'dari .env'})`;
const A = 'aktuator-01';
let meja; let mejaTanpaPeta;
const k = () => crypto.randomUUID();

before(async () => {
  if (lewati) return;
  meja = Number((await q("INSERT INTO mejas (meja, jumlah_lubang, created_at, updated_at) VALUES ('uji-3b3-air', 1, now(), now()) RETURNING id_meja"))[0].id_meja);
  mejaTanpaPeta = Number((await q("INSERT INTO mejas (meja, jumlah_lubang, created_at, updated_at) VALUES ('uji-3b3-air-2', 1, now(), now()) RETURNING id_meja"))[0].id_meja);
  // fixture pemetaan UJI (bukan pemetaan fisik nyata)
  await q("INSERT INTO pemetaan_katup (id_meja, perangkat_kode, nomor_katup, bukti) VALUES ($1, $2, 9, 'fixture uji 3B.3, bukan kabel nyata')", [meja, A]);
  await q("UPDATE perintah_aktuator SET status = 'batal' WHERE perangkat_kode = $1 AND status IN ('menunggu','dikirim')", [A]);
});
after(async () => {
  if (!lewati) {
    await resetEstop();
    await q("DELETE FROM perintah_aktuator WHERE perangkat_kode = $1 AND alasan LIKE 'kontrol air meja %'", [A]);
    await q('DELETE FROM pemetaan_katup WHERE id_meja = ANY($1)', [[meja, mejaTanpaPeta]]);
    await q('DELETE FROM mejas WHERE id_meja = ANY($1)', [[meja, mejaTanpaPeta]]);
  }
  await pool.end();
});

test('3B.3 air: penampung tanpa pemetaan ditolak; pemetaan nyata kosong di DB uji', { skip: lewati }, async () => {
  await assert.rejects(mintaKontrolAir({ idMeja: mejaTanpaPeta, aksi: 'MULAI', userId: null, idempotencyKey: k() }), (e) => e.status === 409);
  assert.equal((await q('SELECT count(*)::int n FROM pemetaan_katup WHERE id_meja <> $1', [meja]))[0].n, 0);
  await assert.rejects(mintaKontrolAir({ idMeja: meja, aksi: 'BUKA', userId: null, idempotencyKey: k() }), (e) => e.status === 422);
  await assert.rejects(mintaKontrolAir({ idMeja: meja, aksi: 'MULAI', userId: null, idempotencyKey: 'x' }), (e) => e.status === 422);
});

test('3B.3 air: permintaan = menunggu (BUKAN berhasil); kunci sama = perintah sama; laporan sah menentukan status fisik', { skip: lewati }, async () => {
  const kunci = k();
  const a = await mintaKontrolAir({ idMeja: meja, aksi: 'MULAI', userId: null, idempotencyKey: kunci });
  assert.equal(a.status_perintah, 'menunggu');
  assert.equal(a.berhasil, false);
  assert.equal(a.status_fisik_katup, 'TIDAK_DIKETAHUI');
  const b = await mintaKontrolAir({ idMeja: meja, aksi: 'MULAI', userId: null, idempotencyKey: kunci });
  assert.equal(b.id_perintah, a.id_perintah);
  assert.equal(b.replay, true);
  const [c, d] = await Promise.all([k(), k()].map((x) => mintaKontrolAir({ idMeja: meja, aksi: 'STOP', userId: null, idempotencyKey: x })));
  assert.notEqual(c.id_perintah, d.id_perintah, 'kunci berbeda = perintah berbeda');
  const kirim = await ambilPerintah(A, 10);
  assert.ok(kirim.some((p) => Number(p.id) === a.id_perintah));
  assert.equal((await statusKontrolAir(a.id_perintah)).status_perintah, 'dikirim');
  assert.equal((await statusKontrolAir(a.id_perintah)).berhasil, false, 'terkirim ≠ berhasil');
  await laporHasil(A, a.id_perintah, { status: 'selesai', hasil: { katup: 'on' } });
  const s = await statusKontrolAir(a.id_perintah);
  assert.equal(s.berhasil, true);
  assert.equal(s.status_fisik_katup, 'ON');
  await laporHasil(A, c.id_perintah, { status: 'selesai', hasil: { alasan: 'isi_air_stop' } });
  assert.equal((await statusKontrolAir(c.id_perintah)).status_fisik_katup, 'TIDAK_DIKETAHUI', 'laporan tanpa status katup');
  await laporHasil(A, d.id_perintah, { status: 'gagal', hasil: { alasan: 'server_hilang' } });
  assert.equal((await statusKontrolAir(d.id_perintah)).berhasil, false);
});

test('3B.3 air: kedaluwarsa & timeout tidak pernah dilaporkan berhasil', { skip: lewati }, async () => {
  const a = await mintaKontrolAir({ idMeja: meja, aksi: 'MULAI', userId: null, idempotencyKey: k() });
  await q("UPDATE perintah_aktuator SET kedaluwarsa_pada = now() - interval '1 second' WHERE id = $1", [a.id_perintah]);
  await ambilPerintah(A, 10);
  const s1 = await statusKontrolAir(a.id_perintah);
  assert.equal(s1.status_perintah, 'kedaluwarsa');
  assert.equal(s1.berhasil, false);
  const b = await mintaKontrolAir({ idMeja: meja, aksi: 'MULAI', userId: null, idempotencyKey: k() });
  await ambilPerintah(A, 10);
  await q("UPDATE perintah_aktuator SET dikirim_pada = now() - interval '91 seconds' WHERE id = $1", [b.id_perintah]);
  await ambilPerintah(A, 10);
  const s2 = await statusKontrolAir(b.id_perintah);
  assert.equal(s2.status_perintah, 'gagal');
  assert.equal(s2.berhasil, false);
  assert.equal(s2.status_fisik_katup, 'TIDAK_DIKETAHUI');
});

test('3B.3 air: E-STOP menolak MULAI; STOP tetap boleh', { skip: lewati }, async () => {
  await q("UPDATE aktuator_state SET nilai = '1' WHERE kunci = 'estop'");
  try {
    await assert.rejects(mintaKontrolAir({ idMeja: meja, aksi: 'MULAI', userId: null, idempotencyKey: k() }), (e) => e.status === 423);
    const s = await mintaKontrolAir({ idMeja: meja, aksi: 'STOP', userId: null, idempotencyKey: k() });
    assert.equal(s.status_perintah, 'menunggu');
  } finally { await resetEstop(); }
});
