'use strict';
/**
 * Alur petani di aplikasi HP: mulai tanam → tiap tahap cukup isi JUMLAH BERHASIL → server menghitung gagal,
 * menutup tahap, dan membuat tahap berikutnya (semai → peremajaan → pendewasaan → panen).
 * Membuat meja/tanaman/siklus uji sendiri; semua dihapus di after().
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { startServer, craftToken, bearer } = require('./_server');
const { q } = require('../../src/db');

let srv; let base; let petani; let meja; let tanaman;
const ids = { semai: [], peremajaan: [], pendewasaan: [], panen: [] };

before(async () => {
  srv = await startServer(); base = srv.base;
  petani = craftToken({ sub: 3, username: 'petani', level: 'petani', demo: false }, { expiresIn: '10m' });
  meja = Number((await q("INSERT INTO mejas (meja, jumlah_lubang, created_at, updated_at) VALUES ('uji-alur-tanam', 20, now(), now()) RETURNING id_meja"))[0].id_meja);
  tanaman = Number((await q("INSERT INTO tanamen (nama_tanaman, id_meja, created_at, updated_at) VALUES ('Uji Selada Alur', $1, now(), now()) RETURNING id_tanaman", [meja]))[0].id_tanaman);
  for (const [nama, hari] of [['Semai', 7], ['Peremajaan', 14], ['Pendewasaan', 21]]) {
    await q('INSERT INTO sikluses (id_tanaman, nama_siklus, waktu_siklus, created_at, updated_at) VALUES ($1, $2, $3, now(), now())', [tanaman, nama, hari]);
  }
});

after(async () => {
  await q('DELETE FROM panens WHERE id_panen = ANY($1::bigint[])', [ids.panen]);
  await q('DELETE FROM pendewasaans WHERE id_pendewasaan = ANY($1::bigint[])', [ids.pendewasaan]);
  await q('DELETE FROM peremajaans WHERE id_peremajaan = ANY($1::bigint[])', [ids.peremajaan]);
  await q('DELETE FROM semais WHERE id_tanaman = $1', [tanaman]);
  await q('DELETE FROM sikluses WHERE id_tanaman = $1', [tanaman]);
  await q('DELETE FROM tanamen WHERE id_tanaman = $1', [tanaman]);
  await q('DELETE FROM mejas WHERE id_meja = $1', [meja]);
  await srv.stop();
});

const get = (p) => request(base).get(p).set(bearer(petani));
const post = (p, b) => request(base).post(p).set(bearer(petani)).send(b);
const item = async (tipe, id) => (await get('/tanam')).body.list.find((x) => x.tipe === tipe && String(x.id) === String(id));
async function mulai(jumlah) {
  const r = await post('/tanam/mulai', { id_tanaman: tanaman, id_meja: meja, jumlah_benih: jumlah });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  ids.semai.push(r.body.data.id_semai);
  return r.body.data;
}
async function selesai(tipe, id, berhasil) {
  const r = await post(`/tanam/${tipe}/${id}/selesai`, { berhasil });
  if (r.body.lanjut) ids[r.body.lanjut.tipe].push(r.body.lanjut.id);
  return r;
}

test('petani: pilihan tanaman & meja tersedia tanpa akses admin', async () => {
  assert.equal((await get('/tanaman')).status, 403);
  const r = await get('/tanam/pilihan');
  assert.equal(r.status, 200);
  const t = r.body.tanaman.find((x) => Number(x.id) === tanaman);
  assert.deepEqual([t.semai, t.peremajaan, t.pendewasaan], [7, 14, 21]);
  assert.equal(Number(t.id_meja), meja, 'meja bawaan tanaman ikut dikirim');
  assert.ok(r.body.meja.some((m) => Number(m.id) === meja));
});

test('alur lengkap: hanya mengisi jumlah berhasil, sisanya otomatis sampai panen', async () => {
  const s = await mulai(10);
  assert.ok(s.id_siklus, 'siklus Semai diisi otomatis');
  const kartu = await item('semai', s.id_semai);
  assert.equal(kartu.hari_ke, 1);
  assert.equal(kartu.durasi_hari, 7);
  assert.equal(kartu.siap, false);
  assert.equal(kartu.tahap_berikut, 'peremajaan');

  // semai: 8 dari 10 berhasil → 2 gagal dihitung server, peremajaan berisi 8
  let r = await selesai('semai', s.id_semai, 8);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.gagal, 2);
  assert.equal(r.body.lanjut.tipe, 'peremajaan');
  const [sm] = await q('SELECT status, benih_berhasil, benih_gagal FROM semais WHERE id_semai = $1', [s.id_semai]);
  assert.deepEqual(sm, { status: 'selesai', benih_berhasil: 8, benih_gagal: 2 });
  assert.equal(await item('semai', s.id_semai), undefined, 'semai selesai hilang dari daftar');
  const rem = await item('peremajaan', r.body.lanjut.id);
  assert.equal(rem.jumlah, 8);
  assert.equal(rem.meja, 'uji-alur-tanam', 'meja ikut tahap sebelumnya');
  assert.equal(rem.durasi_hari, 14);

  // dua kali → 409; melebihi jumlah → 422; bukan angka → 422
  assert.equal((await selesai('semai', s.id_semai, 8)).status, 409);
  assert.equal((await selesai('peremajaan', rem.id, 9)).status, 422);
  assert.equal((await selesai('peremajaan', rem.id, 'banyak')).status, 422);

  // peremajaan → pendewasaan (7 dari 8)
  r = await selesai('peremajaan', rem.id, 7);
  assert.equal(r.status, 200);
  assert.equal(r.body.lanjut.tipe, 'pendewasaan');
  assert.equal((await item('pendewasaan', r.body.lanjut.id)).jumlah, 7);

  // pendewasaan → panen tercatat (6 berhasil, 1 gagal)
  r = await selesai('pendewasaan', r.body.lanjut.id, 6);
  assert.equal(r.status, 200);
  assert.equal(r.body.lanjut.tipe, 'panen');
  assert.match(r.body.message, /Panen dicatat: 6 berhasil, 1 gagal/);
  const [pn] = await q('SELECT panen_berhasil, panen_gagal FROM panens WHERE id_panen = $1', [r.body.lanjut.id]);
  assert.deepEqual(pn, { panen_berhasil: 6, panen_gagal: 1 });
});

test('semua gagal → tahap ditutup "gagal", tidak ada tahap berikutnya', async () => {
  const s = await mulai(5);
  const r = await selesai('semai', s.id_semai, 0);
  assert.equal(r.status, 200);
  assert.equal(r.body.lanjut, null);
  assert.equal(r.body.gagal, 5);
  assert.equal((await q('SELECT status FROM semais WHERE id_semai = $1', [s.id_semai]))[0].status, 'gagal');
  assert.equal((await q('SELECT count(*)::int AS n FROM peremajaans WHERE id_semai = $1', [s.id_semai]))[0].n, 0);
});

test('bug lama: "Selesaikan tahap" tanpa body untuk peremajaan dulu 500 → kini 200; tahap "panen" → 422', async () => {
  const s = await mulai(4);
  const r = await selesai('semai', s.id_semai, 4);
  const res = await post(`/tanam/peremajaan/${r.body.lanjut.id}/selesai`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.status, 'selesai');
  assert.equal((await post('/tanam/panen/1/selesai', { berhasil: 1 })).status, 422);
  assert.equal((await post('/tanam/pendewasaan/999999999/selesai', { berhasil: 1 })).status, 404);
});
