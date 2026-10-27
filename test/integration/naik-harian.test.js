'use strict';
/**
 * Target nutrisi NAIK HARIAN per jenis tanaman (tanamen.ppm_awal / ppm_target / hari_capai).
 * Membuat meja + tanaman + batch semai→peremajaan uji sendiri; semua dihapus di after().
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { startServer, craftToken, bearer } = require('./_server');
const { q, one } = require('../../src/db');
const { naikHarian } = require('../../src/presetDosing');

let srv; let base; let admin; let petani; let demo; let idMeja; let idTanaman; let idSemai;

before(async () => {
  srv = await startServer(); base = srv.base;
  admin = craftToken({ sub: 1, username: 'garap', level: 'admin', demo: false }, { expiresIn: '10m' });
  petani = craftToken({ sub: 3, username: 'petani', level: 'petani', demo: false }, { expiresIn: '10m' });
  demo = craftToken({ sub: 2, username: 'demo', level: 'user', demo: true }, { expiresIn: '10m' });
  idMeja = (await one("INSERT INTO mejas (meja, jumlah_lubang) VALUES ('UJI Naik Harian', 10) RETURNING id_meja")).id_meja;
  idTanaman = (await one("INSERT INTO tanamen (nama_tanaman) VALUES ('UJI Melon Naik') RETURNING id_tanaman")).id_tanaman;
  idSemai = (await one(
    `INSERT INTO semais (id_tanaman, jumlah_benih, tgl_awal_semai, tgl_akhir_semai, status, id_meja)
     VALUES ($1, 20, current_date - 40, current_date - 30, 'selesai', $2) RETURNING id_semai`, [idTanaman, idMeja])).id_semai;
  // pindah netpot 30 hari lalu → hari ke-30
  await q(
    `INSERT INTO peremajaans (id_semai, id_meja, benih_berhasil, benih_gagal, tgl_awal_peremajaan, tgl_akhir_peremajaan, jumlah_masuk, status)
     VALUES ($1, $2, 18, 2, current_date - 30, current_date + 10, 18, 'proses')`, [idSemai, idMeja]);
});

after(async () => {
  await q('DELETE FROM peremajaans WHERE id_semai = $1', [idSemai]);
  await q('DELETE FROM semais WHERE id_semai = $1', [idSemai]);
  await q('DELETE FROM penampung_states WHERE id_meja = $1', [idMeja]);
  await q('DELETE FROM tanamen WHERE id_tanaman = $1', [idTanaman]);
  await q('DELETE FROM mejas WHERE id_meja = $1', [idMeja]);
  await srv.stop();
});

test('unit: kurva 400 → 2400 dalam 60 hari, ditahan setelahnya; Semai & tanpa pengaturan → null', () => {
  const b = (h, tahap = 'Peremajaan') => ({ tahap, ppm_awal: '400', ppm_target: '2400', hari_capai: 60, hari_netpot: h });
  assert.equal(naikHarian(b(0)).target_hari_ini, 400);
  assert.equal(naikHarian(b(1)).target_hari_ini, 433);
  assert.equal(naikHarian(b(30)).target_hari_ini, 1400);
  assert.equal(naikHarian(b(60)).target_hari_ini, 2400);
  assert.equal(naikHarian(b(75, 'Pendewasaan')).target_hari_ini, 2400);
  assert.equal(naikHarian(b(75)).tercapai, true);
  assert.equal(naikHarian(b(-2)).target_hari_ini, 400, 'tanggal netpot di masa depan tidak menurunkan di bawah awal');
  assert.equal(naikHarian(b(10, 'Semai')), null);
  assert.equal(naikHarian({ tahap: 'Peremajaan', hari_netpot: 5 }), null);
});

test('hak akses: semua login boleh baca; demo tidak boleh ubah; petani & admin boleh', async () => {
  for (const t of [admin, petani, demo]) assert.equal((await request(base).get('/dosing/naik-harian').set(bearer(t))).status, 200);
  assert.equal((await request(base).get('/dosing/naik-harian')).status, 401);
  const body = { ppm_awal: 400, ppm_target: 2400, hari_capai: 60 };
  assert.equal((await request(base).put(`/dosing/naik-harian/${idTanaman}`).set(bearer(demo)).send(body)).status, 403);
  assert.equal((await request(base).put('/dosing/naik-harian/99999999').set(bearer(petani)).send(body)).status, 404);
  const r = await request(base).put(`/dosing/naik-harian/${idTanaman}`).set(bearer(petani)).send(body);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.per_hari, 33.3);
});

test('validasi: awal > target, hari 0, di luar 50–2500, isian setengah → 422', async () => {
  const put = (b) => request(base).put(`/dosing/naik-harian/${idTanaman}`).set(bearer(admin)).send(b);
  assert.ok((await put({ ppm_awal: 2000, ppm_target: 1000, hari_capai: 30 })).body.errors.ppm_target);
  assert.ok((await put({ ppm_awal: 400, ppm_target: 2400, hari_capai: 0 })).body.errors.hari_capai);
  assert.ok((await put({ ppm_awal: 400, ppm_target: 3000, hari_capai: 60 })).body.errors.ppm_target);
  assert.ok((await put({ ppm_awal: 400 })).body.errors.ppm_target, 'isian setengah ditolak');
});

test('target penampung ikut kurva: hari ke-30 = 1400 ppm; dimatikan → kembali ke preset/kosong', async () => {
  await request(base).put(`/dosing/naik-harian/${idTanaman}`).set(bearer(petani)).send({ ppm_awal: 400, ppm_target: 2400, hari_capai: 60 });
  const st = await one('SELECT target_ec_ppm FROM penampung_states WHERE id_meja = $1', [idMeja]);
  assert.equal(Number(st.target_ec_ppm), 1400);
  const ring = (await request(base).get('/dosing/target').set(bearer(admin))).body.find((r) => String(r.id_meja) === String(idMeja));
  assert.equal(ring.naik_harian.hari, 30);
  assert.equal(ring.naik_harian.target_hari_ini, 1400);
  assert.equal(ring.catatan, null);

  const off = await request(base).put(`/dosing/naik-harian/${idTanaman}`).set(bearer(petani))
    .send({ ppm_awal: null, ppm_target: null, hari_capai: null });
  assert.equal(off.status, 200);
  const st2 = await one('SELECT target_ec_ppm FROM penampung_states WHERE id_meja = $1', [idMeja]);
  assert.notEqual(Number(st2.target_ec_ppm), 1400, 'tidak lagi memakai kurva');
});
