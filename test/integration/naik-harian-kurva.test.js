'use strict';
/**
 * Kurva target naik harian dengan batch nyata di DB: tanggal mulai Peremajaan digeser ke berbagai hari,
 * lalu sinkronTarget() (yang dijalankan server tiap 10 menit) memperbarui target penampung.
 * Meja/tanaman/batch uji dibuat sendiri dan dihapus di after().
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { q, one, pool } = require('../../src/db');
const { sinkronTarget, ringkasTarget } = require('../../src/presetDosing');

let meja; let tanaman; let semai; let peremajaan; let preset;

const target = async () => Number((await one('SELECT target_ec_ppm FROM penampung_states WHERE id_meja = $1', [meja])).target_ec_ppm);
const targetNull = async () => (await one('SELECT target_ec_ppm FROM penampung_states WHERE id_meja = $1', [meja])).target_ec_ppm;
const baris = async () => (await ringkasTarget()).find((r) => String(r.id_meja) === String(meja));
const hariKe = (d) => q('UPDATE peremajaans SET tgl_awal_peremajaan = current_date - $2::int WHERE id_peremajaan = $1', [peremajaan, d]);
const kurva = (d, awal = 400, akhir = 2400, lama = 60) => Math.round(Math.min(akhir, awal + ((akhir - awal) / lama) * d));

before(async () => {
  meja = (await one("INSERT INTO mejas (meja, jumlah_lubang) VALUES ('UJI Kurva', 10) RETURNING id_meja")).id_meja;
  tanaman = (await one(
    "INSERT INTO tanamen (nama_tanaman, ppm_awal, ppm_target, hari_capai) VALUES ('UJI Melon Kurva', 400, 2400, 60) RETURNING id_tanaman")).id_tanaman;
  semai = (await one(
    `INSERT INTO semais (id_tanaman, jumlah_benih, tgl_awal_semai, tgl_akhir_semai, status, id_meja)
     VALUES ($1, 20, current_date - 50, current_date - 40, 'selesai', $2) RETURNING id_semai`, [tanaman, meja])).id_semai;
  peremajaan = (await one(
    `INSERT INTO peremajaans (id_semai, id_meja, benih_berhasil, benih_gagal, tgl_awal_peremajaan, tgl_akhir_peremajaan, jumlah_masuk, status)
     VALUES ($1, $2, 18, 2, current_date, current_date + 40, 18, 'proses') RETURNING id_peremajaan`, [semai, meja])).id_peremajaan;
  preset = (await one(
    `INSERT INTO target_nutrisi (id_tanaman, tahap, ec_min_ppm, ec_max_ppm, ph_min, ph_max, status, sumber)
     VALUES ($1, 'Semai', 500, 700, 5.8, 6.3, 'aktif', 'uji') RETURNING id`, [tanaman])).id;
  await q('INSERT INTO penampung_states (id_meja) VALUES ($1) ON CONFLICT (id_meja) DO NOTHING', [meja]);
});

after(async () => {
  await q('DELETE FROM pendewasaans WHERE id_peremajaan = $1', [peremajaan]);
  await q('DELETE FROM peremajaans WHERE id_semai = $1', [semai]);
  await q('DELETE FROM semais WHERE id_semai = $1', [semai]);
  await q('DELETE FROM target_nutrisi WHERE id = $1', [preset]);
  await q('DELETE FROM penampung_states WHERE id_meja = $1', [meja]);
  await q('DELETE FROM tanamen WHERE id_tanaman = $1', [tanaman]);
  await q('DELETE FROM mejas WHERE id_meja = $1', [meja]);
  await pool.end();
});

beforeEach(async () => {
  await q("UPDATE penampung_states SET target_mode = 'otomatis', target_ec_ppm = NULL, target_ph = NULL WHERE id_meja = $1", [meja]);
  await q('UPDATE tanamen SET ppm_awal = 400, ppm_target = 2400, hari_capai = 60 WHERE id_tanaman = $1', [tanaman]);
  await q("UPDATE peremajaans SET status = 'proses' WHERE id_peremajaan = $1", [peremajaan]);
  await q('DELETE FROM pendewasaans WHERE id_peremajaan = $1', [peremajaan]);
});

test('S3: target mengikuti kurva pada hari 0, 1, 15, 30, 59, 60, 61, 90 sejak pindah netpot', async () => {
  for (const d of [0, 1, 15, 30, 59, 60, 61, 90]) {
    await hariKe(d);
    await sinkronTarget();
    assert.equal(await target(), kurva(d), `hari ke-${d}`);
    const r = await baris();
    assert.equal(r.naik_harian.hari, d);
    assert.equal(r.naik_harian.target_hari_ini, kurva(d));
    assert.equal(r.naik_harian.tercapai, d >= 60);
    assert.equal(r.catatan, null);
  }
  assert.deepEqual([0, 1, 30, 60].map((d) => kurva(d)), [400, 433, 1400, 2400]);
});

test('S3: sinkron berulang pada hari yang sama tidak mengubah apa pun (idempoten); target tak pernah turun dengan bertambahnya hari', async () => {
  await hariKe(20);
  await sinkronTarget();
  const sebelum = await one('SELECT target_diperbarui FROM penampung_states WHERE id_meja = $1', [meja]);
  await sinkronTarget(); await sinkronTarget();
  const sesudah = await one('SELECT target_diperbarui FROM penampung_states WHERE id_meja = $1', [meja]);
  assert.equal(String(sesudah.target_diperbarui), String(sebelum.target_diperbarui), 'tidak ada tulis ulang tanpa perubahan');
  let lalu = -1;
  for (let d = 0; d <= 70; d += 7) {
    await hariKe(d); await sinkronTarget();
    const t = await target();
    assert.ok(t >= lalu, `hari ${d}: ${t} ≥ ${lalu}`);
    lalu = t;
  }
});

test('S3: tahap Semai tetap preset (naik harian belum berlaku); pindah ke Peremajaan hari 0 → 400', async () => {
  await q("UPDATE peremajaans SET status = 'selesai' WHERE id_peremajaan = $1", [peremajaan]);
  await q("UPDATE semais SET status = 'proses', tgl_akhir_semai = current_date + 5 WHERE id_semai = $1", [semai]);
  await sinkronTarget();
  assert.equal(await target(), 600, 'titik tengah preset Semai 500–700');
  const r = await baris();
  assert.equal(r.batch.tahap, 'Semai');
  assert.equal(r.naik_harian, null);

  await q("UPDATE semais SET status = 'selesai' WHERE id_semai = $1", [semai]);
  await q("UPDATE peremajaans SET status = 'proses' WHERE id_peremajaan = $1", [peremajaan]);
  await hariKe(0);
  await sinkronTarget();
  assert.equal(await target(), 400, 'habis pindah netpot langsung 400 ppm');
  assert.equal((await baris()).batch.tahap, 'Peremajaan');
});

test('S3: pindah ke Pendewasaan tidak membuat target loncat — hari dihitung dari pindah netpot', async () => {
  await hariKe(30);
  await sinkronTarget();
  assert.equal(await target(), 1400);
  await q("UPDATE peremajaans SET status = 'selesai' WHERE id_peremajaan = $1", [peremajaan]);
  await q(
    `INSERT INTO pendewasaans (id_peremajaan, id_meja, tanaman_berhasil, tanaman_gagal, tgl_awal_pendewasaan, tgl_akhir_pendewasaan, jumlah_masuk, status)
     VALUES ($1, $2, 17, 1, current_date, current_date + 30, 17, 'proses')`, [peremajaan, meja]);
  await sinkronTarget();
  const r = await baris();
  assert.equal(r.batch.tahap, 'Pendewasaan');
  assert.equal(await target(), 1400);
  assert.equal(r.naik_harian.hari, 30);
  await hariKe(45);
  await sinkronTarget();
  assert.equal(await target(), kurva(45), 'terus naik di Pendewasaan');
});

test('S3: ubah target/lama saat batch berjalan → target ikut seketika; dimatikan → kembali ke preset tahap (kosong untuk Peremajaan)', async () => {
  await hariKe(15);
  await sinkronTarget();
  assert.equal(await target(), 900, '400 + 2000/60 × 15');
  await q('UPDATE tanamen SET ppm_target = 1000, hari_capai = 30 WHERE id_tanaman = $1', [tanaman]);
  await sinkronTarget();
  assert.equal(await target(), 700, '400 + 600/30 × 15');
  await q('UPDATE tanamen SET ppm_target = 1900, hari_capai = 30 WHERE id_tanaman = $1', [tanaman]);
  await sinkronTarget();
  assert.equal(await target(), 1150, '400 + 1500/30 × 15');
  await q('UPDATE tanamen SET ppm_awal = NULL, ppm_target = NULL, hari_capai = NULL WHERE id_tanaman = $1', [tanaman]);
  await sinkronTarget();
  assert.equal(await targetNull(), null, 'tanpa preset Peremajaan & tanpa naik harian → target kosong, otomasi diam');
  assert.match((await baris()).catatan, /Belum ada preset aktif/);
});

test('S3: tanggal pindah netpot di masa depan → 400 (tidak negatif); hari_capai 1 → 400 lalu 2400', async () => {
  await hariKe(-3);
  await sinkronTarget();
  assert.equal(await target(), 400);
  await q('UPDATE tanamen SET hari_capai = 1 WHERE id_tanaman = $1', [tanaman]);
  await hariKe(0); await sinkronTarget();
  assert.equal(await target(), 400);
  await hariKe(1); await sinkronTarget();
  assert.equal(await target(), 2400);
});

test('S3: mode MANUAL tidak disentuh kurva; kembali otomatis → langsung mengikuti kurva', async () => {
  await hariKe(30);
  await q("UPDATE penampung_states SET target_mode = 'manual', target_ec_ppm = 999 WHERE id_meja = $1", [meja]);
  await sinkronTarget();
  assert.equal(await target(), 999);
  assert.equal((await baris()).catatan, 'Target diatur manual oleh admin.');
  await q("UPDATE penampung_states SET target_mode = 'otomatis' WHERE id_meja = $1", [meja]);
  await sinkronTarget();
  assert.equal(await target(), 1400);
});

test('S3: dua batch di meja yang sama → batch yang paling baru dimulai dipakai', async () => {
  await hariKe(30);
  const semai2 = (await one(
    `INSERT INTO semais (id_tanaman, jumlah_benih, tgl_awal_semai, tgl_akhir_semai, status, id_meja)
     VALUES ($1, 5, current_date, current_date + 10, 'proses', $2) RETURNING id_semai`, [tanaman, meja])).id_semai;
  try {
    await sinkronTarget();
    const r = await baris();
    assert.equal(r.batch.tahap, 'Semai', 'batch terbaru = semai yang baru mulai');
    assert.equal(r.batch.jumlah_batch, 2);
    assert.equal(await target(), 600);
  } finally {
    await q('DELETE FROM semais WHERE id_semai = $1', [semai2]);
  }
});
