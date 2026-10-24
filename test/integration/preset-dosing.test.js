'use strict';
/**
 * Preset dosing: target EC/pH penampung diisi otomatis dari preset (target_nutrisi) yang cocok dengan
 * batch berjalan di meja itu; mode manual tidak disentuh; berganti tahap → target ikut berganti.
 * Memakai meja/tanaman uji sendiri; semua dihapus di after().
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { startServer, craftToken, bearer } = require('./_server');
const { q } = require('../../src/db');
const { pilihPreset, tengah } = require('../../src/presetDosing');

let srv; let base; let admin; let demo; let petani; let meja; let tanaman;
const presetIds = [];

before(async () => {
  srv = await startServer(); base = srv.base;
  admin = craftToken({ sub: 1, username: 'garap', level: 'admin', demo: false }, { expiresIn: '10m' });
  demo = craftToken({ sub: 2, username: 'demo', level: 'user', demo: true }, { expiresIn: '10m' });
  petani = craftToken({ sub: 3, username: 'petani', level: 'petani', demo: false }, { expiresIn: '10m' });
  meja = Number((await q("INSERT INTO mejas (meja, jumlah_lubang, created_at, updated_at) VALUES ('uji-preset-dosing', 10, now(), now()) RETURNING id_meja"))[0].id_meja);
  tanaman = Number((await q("INSERT INTO tanamen (nama_tanaman, created_at, updated_at) VALUES ('Uji Preset Pakcoy', now(), now()) RETURNING id_tanaman"))[0].id_tanaman);
});

after(async () => {
  await q('DELETE FROM penampung_states WHERE id_meja = $1', [meja]);
  await q('DELETE FROM target_nutrisi WHERE id = ANY($1::bigint[]) OR id_tanaman = $2', [presetIds, tanaman]);
  await q('DELETE FROM pendewasaans WHERE id_meja = $1', [meja]);
  await q('DELETE FROM peremajaans WHERE id_meja = $1', [meja]);
  await q('DELETE FROM semais WHERE id_meja = $1', [meja]);
  await q('DELETE FROM tanamen WHERE id_tanaman = $1', [tanaman]);
  await q('DELETE FROM mejas WHERE id_meja = $1', [meja]);
  await srv.stop();
});

const get = (p, t = admin) => request(base).get(p).set(bearer(t));
const kirim = (m, p, b, t = admin) => request(base)[m](p).set(bearer(t)).send(b);
const baris = async () => (await get('/dosing/target')).body.find((r) => Number(r.id_meja) === meja);
async function buatPreset(b) {
  const r = await kirim('post', '/dosing/preset', { id_tanaman: tanaman, status: 'aktif', ...b });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  presetIds.push(r.body.data.id);
  return r.body.data;
}
// sinkron setelah POST berjalan di latar → panggil sinkron eksplisit agar deterministik
const sinkron = async () => assert.equal((await kirim('post', '/dosing/sinkron', {})).status, 200);

test('unit: pemilihan preset — tanaman sendiri sebelum global, umur cocok, rentang tersempit', () => {
  const batch = { tahap: 'Peremajaan', id_tanaman: 7, umur_hari: 12 };
  const P = [
    { id: 1, id_tanaman: null, tahap: 'Peremajaan', ec_min_ppm: 500, ec_max_ppm: 700 },
    { id: 2, id_tanaman: 7, tahap: 'Peremajaan', umur_min_hari: 0, umur_max_hari: 30, ec_min_ppm: 600, ec_max_ppm: 800 },
    { id: 3, id_tanaman: 7, tahap: 'Peremajaan', umur_min_hari: 10, umur_max_hari: 14, ec_min_ppm: 700, ec_max_ppm: 900 },
    { id: 4, id_tanaman: 7, tahap: 'Pendewasaan', ec_min_ppm: 900, ec_max_ppm: 1100 },
    { id: 5, id_tanaman: 7, tahap: 'Peremajaan', umur_min_hari: 20, ec_min_ppm: 1, ec_max_ppm: 2 },
  ];
  assert.equal(pilihPreset(batch, P).id, 3);
  assert.equal(pilihPreset({ ...batch, id_tanaman: 99 }, P).id, 1, 'tanaman lain → preset global');
  assert.equal(pilihPreset(null, P), null);
  assert.equal(tengah(600, 800, 0), 700);
  assert.equal(tengah(5.8, 6.3, 2), 6.05);
  assert.equal(tengah(null, 6.5, 2), 6.5);
});

test('hak akses: petani 403, demo boleh baca tapi tidak menulis', async () => {
  assert.equal((await get('/dosing/preset', petani)).status, 403);
  assert.equal((await get('/dosing/target', demo)).status, 200);
  assert.equal((await kirim('post', '/dosing/preset', { tahap: 'Semai', ec_min_ppm: 400, ec_max_ppm: 600 }, demo)).status, 403);
  assert.equal((await kirim('put', `/dosing/target/${meja}`, { mode: 'manual', target_ec_ppm: 800 }, demo)).status, 403);
});

test('validasi preset: tahap, rentang terbalik, nilai di luar batas wajar, preset aktif tanpa angka', async () => {
  const salah = async (b) => {
    const r = await kirim('post', '/dosing/preset', { id_tanaman: tanaman, ...b });
    assert.equal(r.status, 422, JSON.stringify(b));
    return r.body.errors;
  };
  assert.ok((await salah({ tahap: 'Panen', ec_min_ppm: 500 })).tahap);
  assert.ok((await salah({ tahap: 'Semai', ec_min_ppm: 800, ec_max_ppm: 600 })).ec_max_ppm);
  assert.ok((await salah({ tahap: 'Semai', ph_min: 2 })).ph_min);
  assert.ok((await salah({ tahap: 'Semai', ec_min_ppm: 5000 })).ec_min_ppm);
  assert.ok((await salah({ tahap: 'Semai' })).ec_min_ppm, 'aktif tanpa rentang');
  assert.ok((await salah({ tahap: 'Semai', ec_min_ppm: 500, id_tanaman: 999999999 })).id_tanaman);
});

test('alur: semai → target otomatis dari preset; manual tidak disentuh; ganti tahap → target ikut', async () => {
  const s = (await kirim('post', '/tanam/mulai', { id_tanaman: tanaman, id_meja: meja, jumlah_benih: 40 })).body.data;
  await sinkron();
  let r = await baris();
  assert.equal(r.batch.tahap, 'Semai');
  assert.equal(r.preset_cocok, null);
  assert.match(r.catatan, /Belum ada preset aktif/);

  const pSemai = await buatPreset({ tahap: 'Semai', ec_min_ppm: 400, ec_max_ppm: 600, ph_min: 5.8, ph_max: 6.2 });
  await buatPreset({ tahap: 'Peremajaan', ec_min_ppm: 700, ec_max_ppm: 900, ph_min: 5.8, ph_max: 6.4 });
  await sinkron();
  r = await baris();
  assert.equal(r.target_mode, 'otomatis');
  assert.equal(Number(r.target_ec_ppm), 500);
  assert.equal(Number(r.target_ph), 6);
  assert.equal(Number(r.target_preset_id), Number(pSemai.id));

  // ubah preset → target ikut
  assert.equal((await kirim('put', `/dosing/preset/${pSemai.id}`, { ec_max_ppm: 800 })).status, 200);
  await sinkron();
  assert.equal(Number((await baris()).target_ec_ppm), 600);

  // manual: nilai admin tetap walau disinkron
  const m = await kirim('put', `/dosing/target/${meja}`, { mode: 'manual', target_ec_ppm: 1000, target_ph: 6.5 });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  await sinkron();
  r = await baris();
  assert.equal(r.target_mode, 'manual');
  assert.equal(Number(r.target_ec_ppm), 1000);
  assert.equal((await kirim('put', `/dosing/target/${meja}`, { mode: 'manual' })).status, 422);
  assert.equal((await kirim('put', `/dosing/target/${meja}`, { mode: 'manual', target_ph: 12 })).status, 422);

  // kembali otomatis → dihitung ulang dari preset
  await kirim('put', `/dosing/target/${meja}`, { mode: 'otomatis' });
  assert.equal(Number((await baris()).target_ec_ppm), 600);

  // semai selesai → peremajaan → preset Peremajaan dipakai
  assert.equal((await kirim('post', `/tanam/semai/${s.id_semai}/selesai`, { berhasil: 38 })).status, 200);
  await sinkron();
  r = await baris();
  assert.equal(r.batch.tahap, 'Peremajaan');
  assert.equal(Number(r.target_ec_ppm), 800);
  assert.equal(Number(r.target_ph), 6.1);

  // hapus preset yang dipakai → target dikosongkan (otomasi diam)
  const dipakai = r.target_preset_id;
  assert.equal((await kirim('delete', `/dosing/preset/${dipakai}`)).status, 200);
  r = await baris();
  assert.equal(r.target_ec_ppm, null);
  assert.equal(r.target_preset_id, null);
});
