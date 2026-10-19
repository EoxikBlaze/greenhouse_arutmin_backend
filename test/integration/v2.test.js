'use strict';
/**
 * Integripsi #4 — 11 ENDPOINT SKEMA V2 (src/routes/konfigurasi.js):
 *   8 GET daftar  → jumlah baris dicek terhadap DB live + floor seed (docs kontrak)
 *   3 PUT         → NET-ZERO: ubah satu kolom, verifikasi, kembalikan, bandingkan
 *                   seluruh baris (termasuk diubah_pada/updated_at yang TIDAK boleh
 *                   disentuh PUT sesuai kontrak V2)
 *
 * Catatan: jumlah baris dipakai API vs count(*) DB (bukan angka mati) supaya tes tidak
 * goyah bila data bertambah; floor seed tetap dipakai sebagai pagar minimal.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { pool, q } = require('../../src/db');
const { startServer, adminToken, bearer } = require('./_server');

/** Floor jumlah baris per seed (rujukan: komentar header src/routes/konfigurasi.js). */
const SUMBER = [
  { path: 'konfigurasi-dosis', table: 'konfigurasi_dosis', floor: 19 },
  { path: 'timing-operasi', table: 'timing_operasi', floor: 16 },
  { path: 'aturan-fail-safe', table: 'aturan_fail_safe', floor: 20 },
  { path: 'jadwal-perawatan', table: 'jadwal_perawatan', floor: 5 },
  { path: 'kalibrasi-sensor', table: 'kalibrasi_sensor', floor: 8 },
  { path: 'mapping-channel', table: 'mapping_channel_esp32', floor: 15 },
  { path: 'target-nutrisi', table: 'target_nutrisi', floor: 3 },
  { path: 'penampung-states', table: 'penampung_states', floor: 5 },
];

/** PUT yang harus dipulihkan walau tes gagal di tengah jalan (jaring net-zero). */
const pendingRestore = [];

let srv;
let base;
let auth;

before(async () => {
  srv = await startServer();
  base = srv.base;
  auth = bearer(await adminToken(base));
});

after(async () => {
  if (srv) {
    // Pulihkan semua baris yang sempat diubah, lalu verifikasi net-zero final.
    for (const r of pendingRestore) {
      const kini = await request(base).get(`/${r.path}/${encodeURIComponent(r.id)}`).set(auth);
      if (kini.status === 200 && kini.body[r.field] !== r.nilaiAsli) {
        const put = await request(base).put(`/${r.path}/${encodeURIComponent(r.id)}`)
          .set(auth).send({ [r.field]: r.nilaiAsli });
        assert.equal(put.status, 200, `pulihkan ${r.path}/${r.id} gagal: ${put.text}`);
      }
      if (kini.status === 200) {
        const akhir = await request(base).get(`/${r.path}/${encodeURIComponent(r.id)}`).set(auth);
        assert.equal(akhir.body[r.field], r.nilaiAsli,
          `NET-ZERO gagal: ${r.path}/${r.id} kolom ${r.field} belum kembali`);
      }
    }
    await srv.stop();
  }
  await pool.end(); // wajib: tutup pool agar proses test-runner bisa keluar
});

/* ── 8 GET — jumlah baris ──────────────────────────────────────────── */
for (const s of SUMBER) {
  test(`GET /${s.path} — jumlah baris == count(*) DB (floor seed ${s.floor})`, async () => {
    const res = await request(base).get(`/${s.path}`).set(auth);
    assert.equal(res.status, 200, `body: ${res.text}`);
    assert.ok(Array.isArray(res.body), 'respons daftar wajib array');
    assert.ok(res.body.length >= 1, 'setidaknya ada satu baris');

    const [{ c: dbCount }] = await q(`SELECT count(*)::int AS c FROM ${s.table}`);
    assert.equal(res.body.length, dbCount,
      `jumlah baris API (${res.body.length}) != DB (${dbCount})`);
    assert.ok(res.body.length >= s.floor,
      `jumlah baris ${res.body.length} di bawah floor seed ${s.floor}`);
    assert.ok(res.body.every((r) => r && typeof r === 'object'),
      'setiap elemen wajib objek baris');
  });
}

/* ── 3 PUT — net-zero ─────────────────────────────────────────────── */
async function putNetZero(pathPrefix, id, field) {
  const dulu = await request(base).get(`/${pathPrefix}/${encodeURIComponent(id)}`).set(auth);
  assert.equal(dulu.status, 200, `GET ${pathPrefix}/${id}: ${dulu.text}`);
  const asli = dulu.body;
  const nilaiAsli = asli[field];
  assert.ok(nilaiAsli !== undefined && nilaiAsli !== null && nilaiAsli !== '',
    `baris ${id} harus punya ${field} terisi untuk uji net-zero`);
  pendingRestore.push({ path: pathPrefix, id, field, nilaiAsli });

  // 1) ubah
  const ubah = `${nilaiAsli} [uji integrasi]`;
  const put1 = await request(base).put(`/${pathPrefix}/${encodeURIComponent(id)}`)
    .set(auth).send({ [field]: ubah });
  assert.equal(put1.status, 200, `PUT ubah: ${put1.text}`);
  assert.equal(put1.body.status, true);
  assert.equal(put1.body.data[field], ubah);

  const sesudah = await request(base).get(`/${pathPrefix}/${encodeURIComponent(id)}`).set(auth);
  assert.equal(sesudah.body[field], ubah, 'perubahan harus terbaca kembali');

  // 2) kembalikan persis
  const put2 = await request(base).put(`/${pathPrefix}/${encodeURIComponent(id)}`)
    .set(auth).send({ [field]: nilaiAsli });
  assert.equal(put2.status, 200, `PUT kembalikan: ${put2.text}`);

  const akhir = await request(base).get(`/${pathPrefix}/${encodeURIComponent(id)}`).set(auth);
  assert.deepEqual(akhir.body, asli,
    `NET-ZERO gagal: baris ${pathPrefix}/${id} berbeda dari kondisi awal`);
  // Stempel waktu V2 wajib diam (PUT hanya menyentuh kolom yang diminta).
  for (const ts of ['diubah_pada', 'updated_at']) {
    if (ts in asli) assert.equal(akhir.body[ts], asli[ts], `${ts} tidak boleh berubah saat PUT`);
  }
}

/** Pilih baris & kolom teks terisi secara dinamis (tahan terhadap edit data seed). */
async function pilihBaris(pathPrefix, fieldAlternatives) {
  const res = await request(base).get(`/${pathPrefix}`).set(auth);
  assert.equal(res.status, 200);
  const pk = Object.keys(res.body[0])[0];
  const baris = res.body.find((r) => fieldAlternatives.some((f) => r[f] != null && r[f] !== ''));
  assert.ok(baris, `tidak ada baris ${pathPrefix} dengan kolom teks terisi`);
  const field = fieldAlternatives.find((f) => baris[f] != null && baris[f] !== '');
  return { id: baris[pk], field };
}

test('PUT /konfigurasi-dosis/:param → net-zero (ubah & kembalikan)', async () => {
  const { id, field } = await pilihBaris('konfigurasi-dosis', ['keterangan', 'sumber', 'satuan']);
  await putNetZero('konfigurasi-dosis', id, field);
});

test('PUT /timing-operasi/:param → net-zero (ubah & kembalikan)', async () => {
  const { id, field } = await pilihBaris('timing-operasi', ['keterangan', 'sumber', 'satuan']);
  await putNetZero('timing-operasi', id, field);
});

test('PUT /target-nutrisi/:id → net-zero (ubah & kembalikan)', async () => {
  const { id, field } = await pilihBaris('target-nutrisi', ['keterangan', 'sumber']);
  await putNetZero('target-nutrisi', id, field);
});

/* ── perilaku pendukung ───────────────────────────────────────────── */
test('GET /konfigurasi-dosis/:param (PK teks) → 200 dan identik dengan entri daftar', async () => {
  const daftar = await request(base).get('/konfigurasi-dosis').set(auth);
  const baris = daftar.body[0];
  const detail = await request(base)
    .get(`/konfigurasi-dosis/${encodeURIComponent(baris.param)}`).set(auth);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body, baris);
});

test('GET /penampung-states?id_meja=3 → tersaring; id_meja non-angka → 422 terstruktur', async () => {
  const ok = await request(base).get('/penampung-states?id_meja=3').set(auth);
  assert.equal(ok.status, 200);
  assert.ok(Array.isArray(ok.body));
  assert.ok(ok.body.every((r) => String(r.id_meja) === '3'),
    'filter id_meja harus diterapkan pada semua baris');

  const salah = await request(base).get('/penampung-states?id_meja=abc').set(auth);
  assert.equal(salah.status, 422);
  assert.deepEqual(salah.body, {
    message: 'Data tidak valid.',
    errors: { id_meja: ['Filter id_meja harus berupa angka yang valid.'] },
  });
});
