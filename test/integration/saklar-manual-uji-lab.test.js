'use strict';
/** Saklar per aktuator, Nutrisi Manual (pagar + catat), Uji Lab buah/sayur. Eksekusi pompa TETAP terkunci. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { startServer, craftToken, bearer } = require('./_server');
const { lewati } = require('./_isolasi');
const { q } = require('../../src/db');
const { buatPerintah, PerintahDitolak } = require('../../src/aktuator');
const manual = require('../../src/dosingManual');
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

test('validasi Nutrisi Manual (murni): zat, volume/durasi, batas per sekali dosing', () => {
  const cfg = { maks_ml_per_suntikan: 214, maks_ml_ph_per_suntikan: 10, laju_pompa_a_mls: 2 };
  assert.equal(manual.validasi({ zat: 'x', volume_ml: 5 }, cfg).ok, false);
  assert.equal(manual.validasi({ zat: 'nutrisi_a' }, cfg).ok, false);
  assert.equal(manual.validasi({ zat: 'nutrisi_a', volume_ml: 5, durasi_detik: 3 }, cfg).ok, false, 'isi salah satu');
  assert.equal(manual.validasi({ zat: 'ph_up', volume_ml: 10.5 }, cfg).ok, false, 'melebihi batas pH');
  assert.equal(manual.validasi({ zat: 'nutrisi_a', volume_ml: -1 }, cfg).ok, false);
  const ok = manual.validasi({ zat: 'nutrisi_a', durasi_detik: 5 }, cfg);
  assert.ok(ok.ok); assert.equal(ok.ml, 10); assert.equal(ok.def.jenis, 'A');
  assert.equal(manual.validasi({ zat: 'nutrisi_b', durasi_detik: 200 }, cfg).ok, false, 'durasi*laju melewati 214 mL');
});

test('Nutrisi Manual: lolos validasi -> 423 terkunci, dicatat gagal (sumber USER_MANUAL), saklar OFF tidak berpengaruh', { skip: lewati }, async () => {
  await q('UPDATE saklar_aktuator SET aktif = false');
  await q('UPDATE penampung_states SET status_lock = false, volume_ab_hari_ml = 0, volume_ph_hari_ml = 0 WHERE id_meja = $1', [mejaId]);
  await q("DELETE FROM dosing_events WHERE pemicu = 'USER_MANUAL'");
  const bad = await request(srv.base).post('/iot-v41/dosing-manual').set(admin).send({ zat: 'ph_up', volume_ml: 999 });
  assert.equal(bad.status, 422);
  const r = await request(srv.base).post('/iot-v41/dosing-manual').set(admin).send({ zat: 'nutrisi_a', volume_ml: 20 });
  assert.equal(r.status, 423);
  assert.equal(r.body.kode, 'eksekusi_diblokir');
  assert.equal(r.body.tervalidasi, true);
  const ev = (await q("SELECT hasil, pemicu, aktor_tipe, alasan_akhir FROM dosing_events WHERE id = $1", [r.body.id_kejadian]))[0];
  assert.deepEqual([ev.hasil, ev.pemicu, ev.aktor_tipe, ev.alasan_akhir], ['gagal', 'USER_MANUAL', 'user', 'eksekusi_diblokir']);
  const rd = await q('SELECT jenis, volume_ml::float8 AS v, hasil FROM dosing_rounds WHERE id_kejadian = $1', [r.body.id_kejadian]);
  assert.deepEqual(rd, [{ jenis: 'A', v: 20, hasil: 'gagal' }]);
  assert.equal((await q("SELECT count(*)::int AS n FROM perintah_aktuator WHERE tipe = 'DOSIS' AND status IN ('menunggu','dikirim') AND sumber = 'pengguna' AND alasan LIKE 'Nutrisi Manual%'"))[0].n, 0, 'tidak ada perintah pompa');
  const h = await request(srv.base).get('/iot-v41/dosing-manual/riwayat').set(admin);
  assert.equal(h.status, 200);
  assert.ok(h.body.data.length >= 1 && h.body.data[0].ronde.length === 1);
  assert.equal((await request(srv.base).post('/iot-v41/dosing-manual').set(petani).send({ zat: 'nutrisi_a', volume_ml: 1 })).status, 403);
});

test('Nutrisi Manual: LOCK penampung menolak (423) dan jatah harian terlampaui menolak (409)', { skip: lewati }, async () => {
  const meja1 = Number((await q('SELECT id_meja FROM mejas ORDER BY id_meja LIMIT 1'))[0].id_meja);
  await q('INSERT INTO penampung_states (id_meja) VALUES ($1) ON CONFLICT DO NOTHING', [meja1]);
  const awal = (await q('SELECT status_lock, lock_alasan, volume_ab_hari_ml FROM penampung_states WHERE id_meja = $1', [meja1]))[0];
  try {
    await q("UPDATE penampung_states SET status_lock = true, lock_alasan = 'uji' WHERE id_meja = $1", [meja1]);
    const r = await request(srv.base).post('/iot-v41/dosing-manual').set(admin).send({ zat: 'nutrisi_a', volume_ml: 5 });
    assert.equal(r.status, 423); assert.equal(r.body.kode, 'lock');
    await q('UPDATE penampung_states SET status_lock = false, volume_ab_hari_ml = 499, reset_harian_pada = (now() AT TIME ZONE \'Asia/Makassar\') WHERE id_meja = $1', [meja1]);
    const j = await request(srv.base).post('/iot-v41/dosing-manual').set(admin).send({ zat: 'nutrisi_b', volume_ml: 5 });
    assert.equal(j.status, 409); assert.equal(j.body.kode, 'jatah_harian');
    // hari baru WITA: jatah kemarin tidak ikut menghitung
    await q("UPDATE penampung_states SET reset_harian_pada = now() - interval '2 days' WHERE id_meja = $1", [meja1]);
    const baru = await request(srv.base).post('/iot-v41/dosing-manual').set(admin).send({ zat: 'nutrisi_b', volume_ml: 5 });
    assert.equal(baru.status, 423); assert.equal(baru.body.kode, 'eksekusi_diblokir');
  } finally {
    await q('UPDATE penampung_states SET status_lock = $2, lock_alasan = $3, volume_ab_hari_ml = $4 WHERE id_meja = $1', [meja1, awal.status_lock, awal.lock_alasan, awal.volume_ab_hari_ml]);
  }
});

test('Nutrisi Manual: jeda minimum antar dosing (429) dihitung dari event manual berjalan/sukses', { skip: lewati }, async () => {
  const meja1 = Number((await q('SELECT id_meja FROM mejas ORDER BY id_meja LIMIT 1'))[0].id_meja);
  await q("DELETE FROM dosing_events WHERE pemicu = 'USER_MANUAL'");
  await q("INSERT INTO dosing_events (id_meja, hari, pemicu, aktor_tipe, dipicu_oleh, hasil) VALUES ($1, CURRENT_DATE, 'USER_MANUAL', 'user', 1, 'sukses')", [meja1]);
  const r = await request(srv.base).post('/iot-v41/dosing-manual').set(admin).send({ zat: 'ph_down', volume_ml: 1 });
  assert.equal(r.status, 429); assert.equal(r.body.kode, 'jeda_minimum');
  await q("DELETE FROM dosing_events WHERE pemicu = 'USER_MANUAL'");
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
