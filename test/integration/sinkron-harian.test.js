'use strict';
/**
 * S4 — sinkron target harian dengan ALUR PETANI NYATA (HTTP) dan restart server:
 * mulai tanam → selesai tiap tahap → panen, target penampung harus mengikuti setiap langkah;
 * server mati-hidup di tengah jalan; pergantian hari; data diubah/dihapus saat batch berjalan;
 * sinkron serentak. Meja/tanaman uji dibuat sendiri dan dihapus di after().
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { startServer, craftToken, bearer } = require('./_server');
const { q, one, pool } = require('../../src/db');
const { buatPerintah } = require('../../src/aktuator');
const { sinkronTarget, ringkasTarget } = require('../../src/presetDosing');

let srv; let base; let petani; let admin; let meja; let tanaman; let tanaman2; let preset; let akt; let awalEvent; let awalAlert; let awalPerintah;
const ids = { semai: [], peremajaan: [], pendewasaan: [], panen: [] };
const tunggu = (ms) => new Promise((r) => setTimeout(r, ms));
const kurva = (d) => Math.round(Math.min(2400, 400 + (2000 / 60) * d));

async function sampai(fn, ms = 8000) {
  const batas = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > batas) return v;
    await tunggu(100);
  }
}
const targetEc = async () => (await one('SELECT target_ec_ppm FROM penampung_states WHERE id_meja = $1', [meja]))?.target_ec_ppm;
const nilai = async () => { const t = await targetEc(); return t == null ? null : Number(t); };
const sampaiTarget = (v) => sampai(async () => (await nilai()) === v);
const get = (p) => request(base).get(p).set(bearer(petani));
const post = (p, b, t = petani) => request(base).post(p).set(bearer(t)).send(b);

before(async () => {
  srv = await startServer(); base = srv.base;
  petani = craftToken({ sub: 3, username: 'petani', level: 'petani', demo: false }, { expiresIn: '30m' });
  admin = craftToken({ sub: 1, username: 'garap', level: 'admin', demo: false }, { expiresIn: '30m' });
  awalEvent = Number((await one('SELECT coalesce(max(id),0) AS m FROM dosing_events')).m);
  awalAlert = Number((await one('SELECT coalesce(max(id),0) AS m FROM alert_logs')).m);
  awalPerintah = Number((await one('SELECT coalesce(max(id),0) AS m FROM perintah_aktuator')).m);
  meja = (await one("INSERT INTO mejas (meja, jumlah_lubang) VALUES ('UJI Sinkron', 10) RETURNING id_meja")).id_meja;
  tanaman = (await one(
    "INSERT INTO tanamen (nama_tanaman, id_meja, ppm_awal, ppm_target, hari_capai) VALUES ('UJI Melon Sinkron', $1, 400, 2400, 60) RETURNING id_tanaman", [meja])).id_tanaman;
  tanaman2 = (await one(
    "INSERT INTO tanamen (nama_tanaman, ppm_awal, ppm_target, hari_capai) VALUES ('UJI Selada Sinkron', 300, 900, 30) RETURNING id_tanaman")).id_tanaman;
  for (const [nama, hari] of [['Semai', 7], ['Peremajaan', 14], ['Pendewasaan', 21]]) {
    await q('INSERT INTO sikluses (id_tanaman, nama_siklus, waktu_siklus) VALUES ($1, $2, $3)', [tanaman, nama, hari]);
  }
  preset = (await one(
    `INSERT INTO target_nutrisi (id_tanaman, tahap, ec_min_ppm, ec_max_ppm, status, sumber)
     VALUES ($1, 'Semai', 500, 700, 'aktif', 'uji') RETURNING id`, [tanaman])).id;
  akt = 'uji-sinkron-akt';
  await q('DELETE FROM perangkat WHERE kode = $1', [akt]);
  await q("INSERT INTO perangkat (kode, nama, peran) VALUES ($1, 'uji', 'aktuator')", [akt]);
});

after(async () => {
  if (srv) await srv.stop();
  await q('DELETE FROM perintah_aktuator WHERE id > $1 AND perangkat_kode = $2', [awalPerintah, akt]);
  await q('DELETE FROM perangkat WHERE kode = $1', [akt]);
  await q('DELETE FROM dosing_events WHERE id > $1 AND id_meja = $2', [awalEvent, meja]);
  await q('DELETE FROM alert_logs WHERE id > $1 AND id_meja = $2', [awalAlert, meja]);
  await q('DELETE FROM panens WHERE id_panen = ANY($1::bigint[])', [ids.panen]);
  await q('DELETE FROM pendewasaans WHERE id_meja = $1', [meja]);
  await q('DELETE FROM peremajaans WHERE id_meja = $1', [meja]);
  await q('DELETE FROM semais WHERE id_meja = $1 OR id_tanaman = ANY($2::bigint[])', [meja, [tanaman, tanaman2]]);
  await q('DELETE FROM target_nutrisi WHERE id = $1', [preset]);
  await q('DELETE FROM penampung_states WHERE id_meja = $1', [meja]);
  await q('DELETE FROM sikluses WHERE id_tanaman = ANY($1::bigint[])', [[tanaman, tanaman2]]);
  await q('DELETE FROM tanamen WHERE id_tanaman = ANY($1::bigint[])', [[tanaman, tanaman2]]);
  await q('DELETE FROM mejas WHERE id_meja = $1', [meja]);
  await pool.end();
});

async function selesai(tipe, id, berhasil) {
  const r = await post(`/tanam/${tipe}/${id}/selesai`, { berhasil });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  if (r.body.lanjut) ids[r.body.lanjut.tipe].push(r.body.lanjut.id);
  return r.body.lanjut;
}

test('S4: alur petani nyata — target mengikuti tiap langkah, bertahan saat server restart, kosong setelah panen', async () => {
  const m = await post('/tanam/mulai', { id_tanaman: tanaman, id_meja: meja, jumlah_benih: 12 });
  assert.equal(m.status, 201, JSON.stringify(m.body));
  const semai = m.body.data.id_semai;
  assert.ok(await sampaiTarget(600), 'Semai → titik tengah preset 500–700');

  const rem = await selesai('semai', semai, 10);
  assert.ok(await sampaiTarget(400), 'pindah netpot (Peremajaan hari 0) → 400 ppm');

  // hari ke-30 sejak pindah netpot + target basi di DB + server mati-hidup
  await q('UPDATE peremajaans SET tgl_awal_peremajaan = current_date - 30 WHERE id_peremajaan = $1', [rem.id]);
  await q("UPDATE penampung_states SET target_ec_ppm = 111 WHERE id_meja = $1", [meja]);
  await srv.stop();
  srv = await startServer(); base = srv.base;
  assert.ok(await sampaiTarget(1400), 'setelah restart server target langsung dihitung ulang (hari ke-30 = 1400)');

  const dew = await selesai('peremajaan', rem.id, 8);
  await sinkronTarget();
  assert.equal(await nilai(), 1400, 'masuk Pendewasaan: tidak loncat, hari tetap dihitung dari pindah netpot');
  const ring = (await ringkasTarget()).find((r) => String(r.id_meja) === String(meja));
  assert.equal(ring.batch.tahap, 'Pendewasaan');
  assert.equal(ring.naik_harian.hari, 30);

  await selesai('pendewasaan', dew.id, 7);   // panen
  assert.ok(await sampai(async () => (await nilai()) === null), 'setelah panen tidak ada batch → target dikosongkan, otomasi diam');
  assert.match((await ringkasTarget()).find((r) => String(r.id_meja) === String(meja)).catatan, /Tidak ada batch berjalan/);
});

test('S4: pergantian hari — jatah volume & kejadian direset, kejadian kemarin ditutup "timeout"', async () => {
  await q('INSERT INTO penampung_states (id_meja) VALUES ($1) ON CONFLICT (id_meja) DO NOTHING', [meja]);
  await q(`UPDATE penampung_states SET volume_ab_hari_ml = 450, volume_ph_hari_ml = 90, kejadian_dosis_hari = 8, status_lock = false,
           reset_harian_pada = now() - interval '1 day' WHERE id_meja = $1`, [meja]);
  await q(`INSERT INTO dosing_events (id_meja, hari, pemicu, aktor_tipe, alasan, ronde_total, volume_total_ml, hasil)
           VALUES ($1, current_date - 1, 'SISTEM', 'system', 'kemarin', 4, 400, 'berjalan')`, [meja]);
  // tanpa reset ini 450 + 214 > 500 dan kejadian 8/8 → terkunci; setelah lewat tengah malam harus lolos
  const p = await buatPerintah({ tipe: 'DOSIS', parameter: { penampung: meja, larutan: 'AB', ml: 214 }, sumber: 'otomasi', perangkat: akt });
  assert.ok(p.id);
  const st = await one('SELECT * FROM penampung_states WHERE id_meja = $1', [meja]);
  assert.equal(Number(st.volume_ab_hari_ml), 214);
  assert.equal(Number(st.volume_ph_hari_ml), 0);
  assert.equal(Number(st.kejadian_dosis_hari), 1);
  assert.equal(st.status_lock, false);
  assert.equal((await one("SELECT hasil FROM dosing_events WHERE id_meja = $1 AND alasan = 'kemarin'", [meja])).hasil, 'timeout');
});

test('S4: jenis tanaman batch diganti saat berjalan → target ikut kurva tanaman baru; tanaman dihapus → tidak error', async () => {
  await q('DELETE FROM peremajaans WHERE id_meja = $1', [meja]);
  await q('DELETE FROM semais WHERE id_meja = $1', [meja]);
  const s = (await one(
    `INSERT INTO semais (id_tanaman, jumlah_benih, tgl_awal_semai, tgl_akhir_semai, status, id_meja)
     VALUES ($1, 5, current_date - 40, current_date - 30, 'selesai', $2) RETURNING id_semai`, [tanaman, meja])).id_semai;
  const p = (await one(
    `INSERT INTO peremajaans (id_semai, id_meja, benih_berhasil, benih_gagal, tgl_awal_peremajaan, tgl_akhir_peremajaan, jumlah_masuk, status)
     VALUES ($1, $2, 5, 0, current_date - 15, current_date + 20, 5, 'proses') RETURNING id_peremajaan`, [s, meja])).id_peremajaan;
  await q("UPDATE penampung_states SET target_mode = 'otomatis', target_ec_ppm = NULL WHERE id_meja = $1", [meja]);
  await sinkronTarget();
  assert.equal(await nilai(), kurva(15), 'melon hari ke-15 = 900');

  await q('UPDATE semais SET id_tanaman = $2 WHERE id_semai = $1', [s, tanaman2]);   // selada: 300 → 900 dalam 30 hari
  await sinkronTarget();
  assert.equal(await nilai(), 600, '300 + 600/30 × 15');

  await q('UPDATE semais SET id_tanaman = NULL WHERE id_semai = $1', [s]);            // tanaman terhapus (FK SET NULL)
  await sinkronTarget();
  assert.equal(await nilai(), null, 'tanpa tanaman tidak ada kurva/preset → kosong, tidak error');
  const r = (await ringkasTarget()).find((x) => String(x.id_meja) === String(meja));
  assert.equal(r.batch.tahap, 'Peremajaan');
  assert.equal(r.naik_harian, null);
  await q('DELETE FROM peremajaans WHERE id_peremajaan = $1', [p]);
  await q('DELETE FROM semais WHERE id_semai = $1', [s]);
});

test('S4: sinkron serentak (10×) tidak error, tidak membuat state ganda, hasil konsisten', async () => {
  const s = (await one(
    `INSERT INTO semais (id_tanaman, jumlah_benih, tgl_awal_semai, tgl_akhir_semai, status, id_meja)
     VALUES ($1, 5, current_date, current_date + 7, 'proses', $2) RETURNING id_semai`, [tanaman, meja])).id_semai;
  await q('DELETE FROM penampung_states WHERE id_meja = $1', [meja]);
  const hasil = await Promise.allSettled(Array.from({ length: 10 }, () => sinkronTarget()));
  assert.deepEqual(hasil.filter((h) => h.status === 'rejected').map((h) => h.reason?.message), []);
  assert.equal((await q('SELECT 1 FROM penampung_states WHERE id_meja = $1', [meja])).length, 1);
  assert.equal(await nilai(), 600);
  await q('DELETE FROM semais WHERE id_semai = $1', [s]);
});

test('S4: batch tanpa meja diabaikan; preset kedaluwarsa → target kosong; DB menolak naik harian yang tak masuk akal', async () => {
  const s = (await one(
    `INSERT INTO semais (id_tanaman, jumlah_benih, tgl_awal_semai, tgl_akhir_semai, status, id_meja)
     VALUES ($1, 5, current_date, current_date + 7, 'proses', NULL) RETURNING id_semai`, [tanaman])).id_semai;
  await sinkronTarget();
  assert.equal((await q('SELECT 1 FROM penampung_states WHERE id_meja IS NULL')).length, 0);
  await q('DELETE FROM semais WHERE id_semai = $1', [s]);

  const s2 = (await one(
    `INSERT INTO semais (id_tanaman, jumlah_benih, tgl_awal_semai, tgl_akhir_semai, status, id_meja)
     VALUES ($1, 5, current_date, current_date + 7, 'proses', $2) RETURNING id_semai`, [tanaman, meja])).id_semai;
  await q("UPDATE penampung_states SET target_mode = 'otomatis' WHERE id_meja = $1", [meja]);
  await sinkronTarget();
  assert.equal(await nilai(), 600);
  await q("UPDATE target_nutrisi SET status = 'kadaluarsa' WHERE id = $1", [preset]);
  await sinkronTarget();
  assert.equal(await nilai(), null, 'preset kedaluwarsa tidak dipakai');
  await q("UPDATE target_nutrisi SET status = 'aktif' WHERE id = $1", [preset]);
  await sinkronTarget();
  assert.equal(await nilai(), 600);
  await q('DELETE FROM semais WHERE id_semai = $1', [s2]);

  for (const [set, nama] of [['ppm_awal = 3000', 'awal di luar 50–2500'], ['ppm_awal = 2000, ppm_target = 1000', 'awal > target'], ['hari_capai = 0', 'hari 0'], ['hari_capai = NULL', 'isian setengah']]) {
    await assert.rejects(q(`UPDATE tanamen SET ${set} WHERE id_tanaman = $1`, [tanaman]), /tanamen_naik_harian_cek/, nama);
  }
});
