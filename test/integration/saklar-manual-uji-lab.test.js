'use strict';
/** Saklar per aktuator, Nutrisi Manual (pagar + catat), Uji Lab buah/sayur. Eksekusi pompa TETAP terkunci. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { startServer, craftToken, bearer } = require('./_server');
const { lewati } = require('./_isolasi');
const { q } = require('../../src/db');
const { buatPerintah, PerintahDitolak } = require('../../src/aktuator');
const ujiLab = require('../../src/ujiLab');

let srv; let admin; let petani; let demo; let mejaId;

before(async () => {
  if (lewati) return;
  srv = await startServer();
  admin = bearer(craftToken({ sub: 1, username: 'garap', level: 'admin', demo: false }, { expiresIn: '1h' }));
  petani = bearer(craftToken({ sub: 2, username: 'petani', level: 'petani', demo: false }, { expiresIn: '1h' }));
  demo = bearer(craftToken({ sub: 3, username: 'demo', level: 'demo', demo: true }, { expiresIn: '1h' }));
  mejaId = Number((await q("INSERT INTO mejas (meja, jumlah_lubang, created_at, updated_at) VALUES ('uji-saklar', 1, now(), now()) RETURNING id_meja"))[0].id_meja);
});
after(async () => {
  if (lewati) return;
  await q("UPDATE saklar_aktuator SET aktif = false");
  await q("DELETE FROM dosing_events WHERE id_meja = $1", [mejaId]);
  await q("DELETE FROM perintah_aktuator WHERE (parameter->>'penampung')::bigint = $1", [mejaId]).catch(() => {});
  await q("DELETE FROM penampung_states WHERE id_meja = $1", [mejaId]);
  await q("DELETE FROM mejas WHERE id_meja = $1", [mejaId]);
  await q("DELETE FROM uji_lab");
  await srv?.stop();
});

test('saklar: GET semua login, PUT hanya admin, audit_logs mencatat dari/ke', { skip: lewati }, async () => {
  assert.equal((await request(srv.base).get('/saklar').set(petani)).status, 200);
  assert.equal((await request(srv.base).put('/saklar/ph_up').set(petani).send({ aktif: true })).status, 403);
  assert.equal((await request(srv.base).put('/saklar/ph_up').set(demo).send({ aktif: true })).status, 403);
  assert.equal((await request(srv.base).put('/saklar/ph_up').set(admin).send({ aktif: 'ya' })).status, 422);
  assert.equal((await request(srv.base).put('/saklar/tidak_ada').set(admin).send({ aktif: true })).status, 404);
  const r = await request(srv.base).put('/saklar/ph_up').set(admin).send({ aktif: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.find((s) => s.kode === 'ph_up').aktif, true);
  await new Promise((ok) => setTimeout(ok, 300));
  const a = (await q("SELECT aksi, before_data, after_data, meta, actor_user_id FROM audit_logs WHERE tabel = 'saklar_aktuator' AND row_id = 'ph_up' ORDER BY id DESC LIMIT 1"))[0];
  assert.equal(a.aksi, 'config_change');
  assert.equal(a.meta.dari, 'OFF');
  assert.equal(a.meta.ke, 'ON');
  assert.ok(a.actor_user_id);
  const d = await request(srv.base).get('/dashboard').set(admin);
  assert.ok(Array.isArray(d.body.saklar) && d.body.saklar.some((s) => s.kode === 'ph_up' && s.aktif === true), 'dashboard memuat saklar realtime');
});

test('saklar OFF: otomasi tidak boleh dosis/isi air, pengguna (manual) tetap lolos ke pagar berikutnya', { skip: lewati }, async () => {
  await q('UPDATE saklar_aktuator SET aktif = false');
  await q('UPDATE penampung_states SET volume_ab_hari_ml = 0, volume_ph_hari_ml = 0, kejadian_dosis_hari = 0, status_lock = false WHERE id_meja = $1', [mejaId]);
  for (const larutan of ['AB', 'PH_UP', 'PH_DOWN']) {
    await assert.rejects(
      buatPerintah({ tipe: 'DOSIS', parameter: { penampung: mejaId, larutan, ml: 5 }, sumber: 'otomasi' }),
      (e) => e instanceof PerintahDitolak && e.status === 423 && /Saklar/.test(e.message));
  }
  await assert.rejects(
    buatPerintah({ tipe: 'ISI_AIR', parameter: { penampung: mejaId, aksi: 'MULAI' }, sumber: 'otomasi' }),
    (e) => e instanceof PerintahDitolak && e.status === 423);
  // saklar ON -> otomasi lolos
  await q("UPDATE saklar_aktuator SET aktif = true WHERE kode = 'ph_up'");
  const p = await buatPerintah({ tipe: 'DOSIS', parameter: { penampung: mejaId, larutan: 'PH_UP', ml: 5 }, sumber: 'otomasi' });
  assert.equal(p.tipe, 'DOSIS');
  // saklar OFF -> pengguna manual tetap boleh (override)
  await q("UPDATE saklar_aktuator SET aktif = false WHERE kode = 'ph_up'");
  const m = await buatPerintah({ tipe: 'DOSIS', parameter: { penampung: mejaId, larutan: 'PH_UP', ml: 5 }, sumber: 'pengguna', userId: 1 });
  assert.equal(m.tipe, 'DOSIS');
});

test('Uji Lab: spesifikasi, validasi, simpan buah/sayur, filter kategori, hapus, hanya admin menulis', { skip: lewati }, async () => {
  assert.deepEqual(Object.keys(ujiLab.PARAMETER), ['buah', 'sayur']);
  const spek = await request(srv.base).get('/uji-lab/parameter').set(admin);
  assert.equal(spek.body.bawaan, 'buah');
  assert.equal((await request(srv.base).post('/uji-lab').set(admin).send({ kategori: 'buah', hasil: [{ parameter: 'tinggi_cm', nilai: 5 }] })).status, 422, 'parameter sayur tidak sah untuk buah');
  assert.equal((await request(srv.base).post('/uji-lab').set(admin).send({ kategori: 'daging', hasil: [{ parameter: 'ph', nilai: 6 }] })).status, 422);
  assert.equal((await request(srv.base).post('/uji-lab').set(admin).send({ kategori: 'buah', hasil: [{ parameter: 'brix', nilai: 99 }] })).status, 422);
  assert.equal((await request(srv.base).post('/uji-lab').set(admin).send({ kategori: 'buah', id_siklus_budidaya: 999999999, hasil: [{ parameter: 'brix', nilai: 12 }] })).status, 422);
  assert.equal((await request(srv.base).post('/uji-lab').set(petani).send({ kategori: 'buah', hasil: [{ parameter: 'brix', nilai: 12 }] })).status, 403);
  const b = await request(srv.base).post('/uji-lab').set(admin).send({ kategori: 'buah', tanggal: '2026-11-01', catatan: 'panen 1', hasil: [{ parameter: 'brix', nilai: '12,5' }, { parameter: 'bobot_g', nilai: 1800 }] });
  assert.equal(b.status, 201); assert.equal(b.body.ids.length, 2);
  const s = await request(srv.base).post('/uji-lab').set(admin).send({ kategori: 'sayur', hasil: [{ parameter: 'tinggi_cm', nilai: 20 }] });
  assert.equal(s.status, 201);
  const buah = await request(srv.base).get('/uji-lab?kategori=buah').set(admin);
  assert.equal(buah.body.data.length, 2);
  assert.ok(buah.body.data.every((x) => x.kategori === 'buah'));
  assert.equal(buah.body.data.find((x) => x.parameter === 'brix').nilai, 12.5);
  assert.equal((await request(srv.base).get('/uji-lab?kategori=x').set(admin)).status, 422);
  assert.equal((await request(srv.base).delete(`/uji-lab/${s.body.ids[0]}`).set(admin)).status, 200);
  assert.equal((await request(srv.base).delete(`/uji-lab/${s.body.ids[0]}`).set(admin)).status, 404);
});

test('alert-logs: daftar semua login, ack hanya admin dan tercatat', { skip: lewati }, async () => {
  const id = Number((await q("INSERT INTO alert_logs (type, value, severity, created_at, updated_at) VALUES ('uji-ack', 'pH uji', 'warning', now(), now()) RETURNING id"))[0].id);
  try {
    const l = await request(srv.base).get('/alert-logs?limit=5').set(petani);
    assert.equal(l.status, 200);
    assert.ok(l.body.data.some((a) => Number(a.id) === id && a.acknowledged === false));
    assert.ok(l.body.aktif >= 1);
    assert.equal((await request(srv.base).post(`/alert-logs/${id}/ack`).set(petani)).status, 403);
    assert.equal((await request(srv.base).post('/alert-logs/abc/ack').set(admin)).status, 404);
    assert.equal((await request(srv.base).post(`/alert-logs/${id}/ack`).set(admin)).status, 200);
    assert.equal((await q('SELECT acknowledged FROM alert_logs WHERE id = $1', [id]))[0].acknowledged, true);
  } finally { await q('DELETE FROM alert_logs WHERE id = $1', [id]); }
});

test('Asisten AI: logbook dari data aplikasi, biodata tim tetap, tanpa LLM', { skip: lewati }, async () => {
  await q("INSERT INTO uji_lab (kategori, parameter, nilai, satuan) VALUES ('buah', 'brix', 11.5, '°Brix')");
  const lb = await request(srv.base).post('/api/ai/chat').set(admin).send({ pesan: 'tampilkan logbook kebun' });
  assert.equal(lb.status, 200);
  assert.equal(lb.body.sumber, 'panduan');
  assert.match(lb.body.jawaban, /Logbook kebun 7 hari terakhir/);
  assert.match(lb.body.jawaban, /Uji lab buah: brix = 11\.5/);
  const tim = await request(srv.base).post('/api/ai/chat').set(admin).send({ pesan: 'siapa saja anggota tim?' });
  assert.equal(tim.body.sumber, 'panduan');
  assert.match(tim.body.jawaban, /Muhammad Rizki Maulana — Backend Engineering/);
});
