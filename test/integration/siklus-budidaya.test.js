'use strict';
/**
 * Fase 3B — API & layanan siklus budidaya (state machine, konfirmasi H+4, benih, lot, idempotensi, audit).
 *
 * HANYA berjalan di DB uji (nama diawali `garap_uji`): tes ini mengubah parameter timing sementara dan
 * menjalankan penjadwal. Semua baris uji (meja/tanaman `uji-3b`, siklus, lot, transisi, konfirmasi,
 * notifikasi, audit) dihapus di after(); parameter dipulihkan; tabel historis diverifikasi identik.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');
const { startServer, stopChild, craftToken, bearer } = require('./_server');
const { pool, q } = require('../../src/db');
const svc = require('../../src/siklusBudidaya');
const { wajibSiap } = require('../../src/parameter');

const namaDb = new URL(process.env.DATABASE_URL || 'postgres://x/none').pathname.slice(1);
const DB_UJI = namaDb.startsWith('garap_uji');
const lewati = DB_UJI ? false : `hanya untuk DB uji garap_uji* (sekarang: ${namaDb || 'dari .env'})`;

let srv; let base; let admin; let petani; let demo; let idAdmin;
let meja = []; let tanaman; let melon; let hashLama; let paramAwal;
const siklusUji = new Set();

const PARAM = ['ulang_konfirmasi_jam', 'pengingat_konfirmasi_jam', 'konfirmasi_peremajaan_batas_jam'];
const kunci = () => crypto.randomUUID();
const post = (path, body, tok = admin, k = kunci()) => request(base).post(path).set(bearer(tok)).set('Idempotency-Key', k).send(body);

async function hashHistoris() {
  const out = {};
  for (const t of ['semais', 'peremajaans', 'pendewasaans', 'panens', 'sikluses', 'target_nutrisi', 'tanamen']) {
    out[t] = (await q(`SELECT count(*) n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) h FROM ${t} x
                        WHERE NOT (${t === 'tanamen' ? "nama_tanaman = 'uji-3b'" : 'false'})`))[0];
  }
  return JSON.stringify(out);
}

const manual = (o = {}) => ({
  id_tanaman: tanaman, id_meja: meja[0], mode_target: 'MANUAL', ph_aktual: 6.1, tds_aktual_ppm: 450, jumlah_benih: 100,
  target: { ec_min_ppm: 400, ec_max_ppm: 600, ph_min: 5.8, ph_max: 6.5 }, ...o,
});

async function buat(o) {
  const r = await post('/api/siklus', manual(o));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  siklusUji.add(r.body.data.id);
  return r.body.data;
}

/** Siklus fiktif langsung di status SEEDING (melewati persiapan tandon yang belum bisa otomatis — lihat laporan). */
async function siklusSemai({ jamLalu = 97, jadwalJamLalu = 1, benih = 100, idMeja = meja[1] } = {}) {
  const s = (await q(
    `INSERT INTO siklus_budidaya (id_tanaman, id_meja_semai, mode_target, target, jumlah_benih, status, semai_mulai_pada, jadwal_konfirmasi_berikut, asal)
     VALUES ($1,$2,'MANUAL','{"ec_min_ppm":400,"ec_max_ppm":600,"ph_min":5.8,"ph_max":6.5}',$3,'SEEDING',
             now() - make_interval(hours => $4), now() - make_interval(hours => $5), 'BARU') RETURNING id`,
    [tanaman, idMeja, benih, jamLalu, jadwalJamLalu]))[0];
  siklusUji.add(Number(s.id));
  return Number(s.id);
}

async function setParam(param, nilai, tervalidasi) {
  await q(`UPDATE timing_operasi SET nilai = $2, tervalidasi = $3, divalidasi_pada = CASE WHEN $3 THEN now() END,
           catatan_validasi = CASE WHEN $3 THEN 'uji 3B (sementara)' END WHERE param = $1`, [param, nilai, tervalidasi]);
}

before(async () => {
  if (!DB_UJI) return;
  // suite ini mengirim >60 POST/menit dari satu IP; batas tulis bawaan (60) tidak sedang diuji di sini
  process.env.RATE_LIMIT_WRITE = '1000';
  srv = await startServer(); base = srv.base;
  idAdmin = Number((await q("SELECT id FROM users WHERE level = 'admin' AND NOT coalesce(is_demo, false) ORDER BY id LIMIT 1"))[0].id);
  admin = craftToken({ sub: idAdmin, username: 'garap', level: 'admin', demo: false }, { expiresIn: '20m' });
  petani = craftToken({ sub: idAdmin, username: 'petani', level: 'petani', demo: false }, { expiresIn: '20m' });
  demo = craftToken({ sub: idAdmin, username: 'demo', level: 'user', demo: true }, { expiresIn: '20m' });
  hashLama = await hashHistoris();
  paramAwal = await q('SELECT param, nilai, tervalidasi, divalidasi_pada, catatan_validasi FROM timing_operasi WHERE param = ANY($1)', [PARAM]);
  for (let i = 0; i < 4; i += 1) {
    meja.push(Number((await q("INSERT INTO mejas (meja, jumlah_lubang, created_at, updated_at) VALUES ($1, 10, now(), now()) RETURNING id_meja", [`uji-3b-${i}`]))[0].id_meja));
  }
  tanaman = Number((await q("INSERT INTO tanamen (nama_tanaman, created_at, updated_at) VALUES ('uji-3b', now(), now()) RETURNING id_tanaman"))[0].id_tanaman);
  melon = (await q(`SELECT p.id_tanaman, p.aktif_versi_id FROM preset_nutrisi p JOIN tanamen t ON t.id_tanaman = p.id_tanaman
                     WHERE t.nama_tanaman = 'Melon' AND p.aktif_versi_id IS NOT NULL LIMIT 1`))[0];
});

after(async () => {
  if (!DB_UJI) { await pool.end(); return; }
  try {
    const ids = [...siklusUji];
    if (ids.length) {
      await q("DELETE FROM notifikasi WHERE (tautan->>'id_siklus')::bigint = ANY($1) OR (tautan->>'tipe' = 'siklus' AND (tautan->>'id')::bigint = ANY($1))", [ids]);
      await q("DELETE FROM audit_logs WHERE tabel = 'siklus_budidaya' AND row_id = ANY($1::text[])", [ids.map(String)]);
      await q('DELETE FROM siklus_transisi WHERE id_siklus = ANY($1)', [ids]);
      await q('DELETE FROM permintaan_konfirmasi WHERE id_siklus = ANY($1)', [ids]);
      await q("DELETE FROM siklus_lot WHERE id_siklus = ANY($1) AND tahap = 'PANEN'", [ids]);
      await q("DELETE FROM siklus_lot WHERE id_siklus = ANY($1) AND tahap = 'PENDEWASAAN'", [ids]);
      await q('DELETE FROM siklus_lot WHERE id_siklus = ANY($1)', [ids]);
      await q('DELETE FROM siklus_budidaya WHERE id = ANY($1)', [ids]);
    }
    for (const p of paramAwal) {
      await q('UPDATE timing_operasi SET nilai = $2, tervalidasi = $3, divalidasi_pada = $4, catatan_validasi = $5 WHERE param = $1',
        [p.param, p.nilai, p.tervalidasi, p.divalidasi_pada, p.catatan_validasi]);
    }
    await q('DELETE FROM penampung_states WHERE id_meja = ANY($1)', [meja]);
    await q('DELETE FROM mejas WHERE id_meja = ANY($1)', [meja]);
    await q('DELETE FROM tanamen WHERE id_tanaman = $1', [tanaman]);
    assert.equal(await hashHistoris(), hashLama, 'tabel historis harus identik setelah tes');
  } finally {
    await stopChild(srv?.child);
    await pool.end();
  }
});

test('3B: buat siklus MANUAL & PRESET (snapshot target), audit create', { skip: lewati }, async () => {
  const s = await buat();
  assert.equal(s.status, 'DRAFT');
  assert.equal(s.asal, 'BARU');
  assert.equal(s.target.sumber, 'MANUAL');
  assert.equal(s.transisi.length, 1);
  assert.equal(s.transisi[0].ke, 'DRAFT');
  const a = await q("SELECT aksi, actor_user_id FROM audit_logs WHERE tabel = 'siklus_budidaya' AND row_id = $1", [String(s.id)]);
  assert.deepEqual(a.map((x) => x.aksi), ['create']);
  assert.equal(Number(a[0].actor_user_id), idAdmin);

  if (melon) {
    const r = await post('/api/siklus', { ...manual({ id_meja: meja[2] }), id_tanaman: Number(melon.id_tanaman), mode_target: 'PRESET', id_preset_versi: Number(melon.aktif_versi_id), target: undefined });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    siklusUji.add(r.body.data.id);
    assert.equal(r.body.data.target.sumber, 'PRESET');
    assert.equal(r.body.data.target.status_validasi, 'BELUM_TERVALIDASI', 'label validasi ikut di snapshot');
    assert.ok(r.body.data.target.parameter.tahap, 'parameter preset tersalin');
    const salah = await post('/api/siklus', { ...manual(), mode_target: 'PRESET', id_preset_versi: Number(melon.aktif_versi_id), target: undefined });
    assert.equal(salah.status, 422);
    assert.match(salah.body.errors.id_preset_versi[0], /bukan milik tanaman/);
  }
});

test('3B: validasi input buat siklus → 422 tanpa baris baru', { skip: lewati }, async () => {
  const n0 = Number((await q('SELECT count(*) FROM siklus_budidaya'))[0].count);
  const cek = async (body, field) => {
    const r = await post('/api/siklus', body);
    assert.equal(r.status, 422, `${field}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.errors[field], `${field} ada di errors: ${JSON.stringify(r.body.errors)}`);
  };
  await cek(manual({ jumlah_benih: 0 }), 'jumlah_benih');
  await cek(manual({ jumlah_benih: 10.5 }), 'jumlah_benih');
  await cek(manual({ ph_aktual: 15 }), 'ph_aktual');
  await cek(manual({ id_tanaman: 'abc' }), 'id_tanaman');
  await cek(manual({ mode_target: 'AUTO' }), 'mode_target');
  await cek(manual({ target: { ec_min_ppm: 700, ec_max_ppm: 600, ph_min: 5.8, ph_max: 6.5 } }), 'target.ec_max_ppm');
  await cek(manual({ target: { ec_min_ppm: 400, ec_max_ppm: 600, ph_min: 5.8, ph_max: 6.5, ppm_awal: 400 } }), 'target.naik_harian');
  await cek(manual({ id_tanaman: 999999999 }), 'id_tanaman');
  assert.equal(Number((await q('SELECT count(*) FROM siklus_budidaya'))[0].count), n0);
});

test('3B: otorisasi — tanpa token 401, petani/demo tidak boleh menulis, semua boleh baca', { skip: lewati }, async () => {
  assert.equal((await request(base).post('/api/siklus').set('Idempotency-Key', kunci()).send(manual())).status, 401);
  assert.equal((await post('/api/siklus', manual(), petani)).status, 403);
  assert.equal((await post('/api/siklus', manual(), demo)).status, 403);
  const s = await buat();
  assert.equal((await post(`/api/siklus/${s.id}/transisi`, { ke: 'TANK_PREPARATION' }, petani)).status, 403);
  // 3B.1: petani lolos guard peran (hak per penampung dicek di layanan) → id yang tidak ada = 404;
  // penolakan petani pada konfirmasi penampung lain diuji di siklus-otorisasi.test.js
  assert.equal((await post('/api/konfirmasi/999999999/jawab', { jawaban: 'SIAP' }, petani)).status, 404);
  assert.equal((await post('/api/lot/1/selesai', { berhasil: 1, gagal: 0 }, demo)).status, 403);
  assert.equal((await request(base).get(`/api/siklus/${s.id}`).set(bearer(petani))).status, 200);
  assert.equal((await request(base).get('/api/siklus?asal=MIGRASI').set(bearer(petani))).status, 200);
  assert.equal((await request(base).get('/api/siklus/abc').set(bearer(admin))).status, 404);
  assert.equal((await request(base).get('/api/siklus?status=NGAWUR').set(bearer(admin))).status, 422);
});

test('3B: idempotensi — kunci sama diulang, kunci sama isi beda 422, tanpa kunci 422', { skip: lewati }, async () => {
  const k = kunci();
  const a = await post('/api/siklus', manual(), admin, k);
  assert.equal(a.status, 201);
  siklusUji.add(a.body.data.id);
  const b = await post('/api/siklus', manual(), admin, k);
  assert.equal(b.status, 200);
  assert.equal(b.body.replay, true);
  assert.equal(b.body.data.id, a.body.data.id);
  assert.equal((await post('/api/siklus', manual({ jumlah_benih: 7 }), admin, k)).status, 422);
  assert.equal((await request(base).post('/api/siklus').set(bearer(admin)).send(manual())).status, 422);
  assert.equal((await request(base).post('/api/siklus').set(bearer(admin)).set('Idempotency-Key', 'bukan-uuid').send(manual())).status, 422);
});

test('3B: transisi ilegal ditolak 409/422; jalur sah tercatat', { skip: lewati }, async () => {
  const s = await buat({ id_meja: meja[3] });
  assert.equal((await post(`/api/siklus/${s.id}/transisi`, { ke: 'SEEDING' })).status, 422);
  assert.equal((await post(`/api/siklus/${s.id}/benih`, { jumlah_benih: 100, berhasil: 100, gagal: 0, id_meja_tujuan: meja[0] })).body.kode, 'transisi_tidak_sah');
  assert.equal((await post(`/api/siklus/${s.id}/konfirmasi`, {})).status, 409);
  const ok = await post(`/api/siklus/${s.id}/transisi`, { ke: 'TANK_PREPARATION' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.status, 'TANK_PREPARATION');
  const lagi = await post(`/api/siklus/${s.id}/transisi`, { ke: 'TANK_PREPARATION' });
  assert.equal(lagi.status, 409);
  assert.equal(lagi.body.kode, 'transisi_tidak_sah');
  assert.equal(lagi.body.status_sekarang, 'TANK_PREPARATION');
  // penampung yang sama tidak bisa dipakai dua siklus persiapan
  const s2 = await buat({ id_meja: meja[3] });
  const bentrok = await post(`/api/siklus/${s2.id}/transisi`, { ke: 'TANK_PREPARATION' });
  assert.equal(bentrok.status, 409);
  assert.equal(bentrok.body.kode, 'penampung_dipakai');
  assert.equal((await post(`/api/siklus/${s.id}/transisi`, { ke: 'CANCELLED', alasan: 'abc' })).status, 422, 'alasan < 5');
  const batal = await post(`/api/siklus/${s.id}/transisi`, { ke: 'CANCELLED', alasan: 'uji pembatalan' });
  assert.equal(batal.body.data.status, 'CANCELLED');
  assert.equal(batal.body.data.hasil, 'DIBATALKAN');
  assert.ok(batal.body.data.selesai_pada);
  assert.equal((await post(`/api/siklus/${s.id}/transisi`, { ke: 'CANCELLED', alasan: 'uji lagi ya' })).status, 409, 'status akhir');
});

test('3B: dua permintaan bersamaan → satu transisi saja', { skip: lewati }, async () => {
  const s = await buat({ id_meja: meja[2] });
  const [a, b] = await Promise.all([
    post(`/api/siklus/${s.id}/transisi`, { ke: 'CANCELLED', alasan: 'paralel satu' }),
    post(`/api/siklus/${s.id}/transisi`, { ke: 'CANCELLED', alasan: 'paralel dua' }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  // kunci idempotensi sama dikirim bersamaan → keduanya sukses, transisi tetap satu
  const s2 = await buat({ id_meja: meja[2] });
  const k = kunci();
  const [c, d] = await Promise.all([
    post(`/api/siklus/${s2.id}/transisi`, { ke: 'TANK_PREPARATION' }, admin, k),
    post(`/api/siklus/${s2.id}/transisi`, { ke: 'TANK_PREPARATION' }, admin, k),
  ]);
  assert.deepEqual([c.status, d.status], [200, 200]);
  const n = await q("SELECT count(*)::int n FROM siklus_transisi WHERE id_siklus = $1 AND ke = 'TANK_PREPARATION'", [s2.id]);
  assert.equal(n[0].n, 1);
  await post(`/api/siklus/${s2.id}/transisi`, { ke: 'CANCELLED', alasan: 'bebaskan penampung' });
});

test('3B: konfirmasi H+4 — penjadwal meminta, tanpa jawaban TIDAK dianggap siap, kedaluwarsa tanpa jadwal tebakan', { skip: lewati }, async () => {
  await setParam('ulang_konfirmasi_jam', null, false);
  await setParam('pengingat_konfirmasi_jam', null, false);
  const id = await siklusSemai();
  const r1 = await svc.jalankanPenjadwal();
  assert.ok(r1.diminta >= 1, JSON.stringify(r1));
  let d = await svc.detail(id);
  assert.equal(d.status, 'WAITING_REJUVENATION_CONFIRMATION');
  const p = d.konfirmasi.at(-1);
  assert.equal(p.status, 'PENDING');
  const jam = (new Date(p.kedaluwarsa_pada) - new Date(p.dibuat_pada)) / 3600e3;
  assert.ok(Math.abs(jam - 24) < 0.01, `batas 24 jam, dapat ${jam}`);
  assert.equal(p.pengingat_pada, null, 'pengingat tidak dijadwalkan bila parameternya belum SIAP');
  await svc.jalankanPenjadwal();
  assert.equal((await svc.detail(id)).konfirmasi.length, 1, 'penjadwal berulang tidak menggandakan permintaan');

  // tanpa jawaban sampai lewat batas → EXPIRED, kembali SEEDING, jadwal ulang KOSONG (parameter NULL)
  await q("UPDATE permintaan_konfirmasi SET dibuat_pada = now() - interval '25 hours', kedaluwarsa_pada = now() - interval '1 minute' WHERE id = $1", [p.id]);
  const r2 = await svc.jalankanPenjadwal();
  assert.ok(r2.kedaluwarsa >= 1);
  d = await svc.detail(id);
  assert.equal(d.status, 'SEEDING');
  assert.equal(d.jadwal_konfirmasi_berikut, null);
  assert.notEqual(d.status, 'WAITING_SEED_COUNT_CONFIRMATION');
  assert.equal(d.konfirmasi[0].status, 'EXPIRED');
  assert.equal(d.transisi.at(-1).aktor_tipe, 'system');
  const jawabLama = await post(`/api/konfirmasi/${p.id}/jawab`, { jawaban: 'SIAP' });
  assert.equal(jawabLama.status, 410);
  assert.equal((await svc.detail(id)).status, 'SEEDING', 'jawaban atas permintaan kedaluwarsa tidak mengubah apa pun');
  const n = await q("SELECT count(*)::int n FROM notifikasi WHERE jenis = 'jadwal_ulang_manual' AND (tautan->>'id')::bigint = $1", [id]);
  assert.equal(n[0].n, 1, 'admin diberi tahu bahwa konfirmasi ulang harus diminta manual');
  await svc.jalankanPenjadwal();
  assert.equal((await svc.detail(id)).konfirmasi.length, 1, 'tanpa jadwal → tidak ada permintaan otomatis');
});

test('3B: jadwal ulang hanya memakai parameter SIAP (BELUM_TERVALIDASI diabaikan)', { skip: lewati }, async () => {
  const id = await siklusSemai({ idMeja: meja[2] });
  await svc.jalankanPenjadwal();
  let p = (await svc.detail(id)).konfirmasi.at(-1);
  await setParam('ulang_konfirmasi_jam', 12, false); // ada nilai tapi belum divalidasi
  let r = await post(`/api/konfirmasi/${p.id}/jawab`, { jawaban: 'BELUM_SIAP' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.status, 'SEEDING');
  assert.equal(r.body.data.jadwal_konfirmasi_berikut, null);
  assert.ok(r.body.data.semai_mulai_pada, 'tanggal semai tidak direset');

  // admin meminta manual (sudah lewat H+4), lalu jawaban BELUM_SIAP dengan parameter SIAP → jadwal +12 jam
  r = await post(`/api/siklus/${id}/konfirmasi`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.status, 'WAITING_REJUVENATION_CONFIRMATION');
  assert.equal(r.body.data.konfirmasi.at(-1).percobaan_ke, 2);
  p = r.body.data.konfirmasi.at(-1);
  await setParam('ulang_konfirmasi_jam', 12, true);
  r = await post(`/api/konfirmasi/${p.id}/jawab`, { jawaban: 'BELUM_SIAP' });
  const selisih = (new Date(r.body.data.jadwal_konfirmasi_berikut) - Date.now()) / 3600e3;
  assert.ok(selisih > 11.9 && selisih <= 12, `jadwal ulang ≈ 12 jam, dapat ${selisih}`);
  await setParam('ulang_konfirmasi_jam', null, false);
  const dua = await post(`/api/konfirmasi/${p.id}/jawab`, { jawaban: 'SIAP' });
  assert.equal(dua.status, 409, 'sudah dijawab');
  assert.equal(dua.body.kode, 'sudah_dijawab');
});

test('3B: konfirmasi manual sebelum H+4 ditolak; batas jawab belum SIAP → penjadwal melewati', { skip: lewati }, async () => {
  const id = await siklusSemai({ jamLalu: 1, jadwalJamLalu: -95, idMeja: meja[3] });
  const r = await post(`/api/siklus/${id}/konfirmasi`, {});
  assert.equal(r.status, 409);
  assert.equal(r.body.kode, 'belum_waktunya');
  await q("UPDATE siklus_budidaya SET semai_mulai_pada = now() - interval '97 hours', jadwal_konfirmasi_berikut = now() - interval '1 minute' WHERE id = $1", [id]);
  await setParam('konfirmasi_peremajaan_batas_jam', null, false);
  await assert.rejects(wajibSiap({ timing_operasi: ['konfirmasi_peremajaan_batas_jam'] }), /parameter belum siap/i);
  const hasil = await svc.jalankanPenjadwal();
  assert.ok(hasil.dilewati.some((x) => /batas_jam/.test(x)), JSON.stringify(hasil));
  assert.equal((await svc.detail(id)).status, 'SEEDING');
  const m = await post(`/api/siklus/${id}/konfirmasi`, {});
  assert.equal(m.status, 409);
  assert.equal(m.body.kode, 'parameter_belum_siap');
  await setParam('konfirmasi_peremajaan_batas_jam', 24, true);
  await post(`/api/siklus/${id}/transisi`, { ke: 'CANCELLED', alasan: 'selesai uji' });
});

test('3B: siap → benih (validasi ketat) → lot bercabang → panen → COMPLETED; audit = transisi', { skip: lewati }, async () => {
  const id = await siklusSemai({ benih: 100, idMeja: meja[0] });
  await svc.jalankanPenjadwal();
  const p = (await svc.detail(id)).konfirmasi.at(-1);
  let r = await post(`/api/konfirmasi/${p.id}/jawab`, { jawaban: 'SIAP' });
  assert.equal(r.body.data.status, 'WAITING_SEED_COUNT_CONFIRMATION');
  for (const [body, field] of [
    [{ jumlah_benih: 100, berhasil: 60, gagal: 30, id_meja_tujuan: meja[1] }, 'berhasil'],
    [{ jumlah_benih: 90, berhasil: 60, gagal: 30, id_meja_tujuan: meja[1] }, 'jumlah_benih'],
    [{ jumlah_benih: 100, berhasil: 60, gagal: 40 }, 'id_meja_tujuan'],
    [{ jumlah_benih: 100, berhasil: -1, gagal: 101, id_meja_tujuan: meja[1] }, 'berhasil'],
  ]) {
    const x = await post(`/api/siklus/${id}/benih`, body);
    assert.equal(x.status, 422, JSON.stringify(x.body));
    assert.ok(x.body.errors[field], `${field}: ${JSON.stringify(x.body.errors)}`);
  }
  assert.equal((await svc.detail(id)).status, 'WAITING_SEED_COUNT_CONFIRMATION', 'status tidak berubah setelah input salah');
  r = await post(`/api/siklus/${id}/benih`, { jumlah_benih: 100, berhasil: 60, gagal: 40, id_meja_tujuan: meja[1] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.status, 'GROWTH');
  const prm = r.body.data.lot[0];
  assert.equal(prm.tahap, 'PEREMAJAAN');
  assert.equal(prm.jumlah_masuk, 60);

  assert.equal((await post(`/api/lot/${prm.id}/selesai`, { berhasil: 50, gagal: 5, tujuan: [{ id_meja: meja[2], jumlah: 50 }] })).status, 422);
  assert.equal((await post(`/api/lot/${prm.id}/selesai`, { berhasil: 50, gagal: 10, tujuan: [{ id_meja: meja[2], jumlah: 40 }] })).status, 422);
  r = await post(`/api/lot/${prm.id}/selesai`, { berhasil: 50, gagal: 10, tujuan: [{ id_meja: meja[2], jumlah: 30 }, { id_meja: meja[3], jumlah: 20 }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const pdw = r.body.data.lot.filter((l) => l.tahap === 'PENDEWASAAN');
  assert.equal(pdw.length, 2, 'cabang ke dua meja');
  assert.ok(pdw.every((l) => Number(l.id_lot_induk) === Number(prm.id)));
  assert.equal(r.body.data.status, 'GROWTH');
  assert.equal((await post(`/api/lot/${prm.id}/selesai`, { berhasil: 50, gagal: 10 })).body.kode, 'sudah_selesai');
  r = await post(`/api/lot/${pdw[0].id}/selesai`, { berhasil: 28, gagal: 2 });
  assert.equal(r.body.data.status, 'GROWTH');
  r = await post(`/api/lot/${pdw[1].id}/selesai`, { berhasil: 20, gagal: 0 });
  assert.equal(r.body.data.status, 'COMPLETED');
  assert.equal(r.body.data.hasil, 'PANEN');
  assert.equal(r.body.data.lot.filter((l) => l.tahap === 'PANEN').length, 2);

  // audit konsisten: satu baris 'transition' per transisi yang mengubah status
  const t = await q('SELECT count(*)::int n FROM siklus_transisi WHERE id_siklus = $1 AND dari IS NOT NULL', [id]);
  const a = await q("SELECT count(*)::int n FROM audit_logs WHERE tabel = 'siklus_budidaya' AND row_id = $1 AND aksi = 'transition'", [String(id)]);
  assert.equal(a[0].n, t[0].n);
  const sys = await q("SELECT count(*)::int n FROM audit_logs WHERE row_id = $1 AND aksi = 'transition' AND actor_tipe = 'system'", [String(id)]);
  assert.equal(sys[0].n, 1, 'permintaan H+4 oleh sistem tercatat sebagai aktor system');
});

test('3B: siklus jumlah benih semua gagal → COMPLETED GAGAL_SEMAI tanpa lot', { skip: lewati }, async () => {
  const id = await siklusSemai({ benih: 10, idMeja: meja[3] });
  await svc.jalankanPenjadwal();
  const p = (await svc.detail(id)).konfirmasi.at(-1);
  await post(`/api/konfirmasi/${p.id}/jawab`, { jawaban: 'SIAP' });
  const r = await post(`/api/siklus/${id}/benih`, { jumlah_benih: 10, berhasil: 0, gagal: 10 });
  assert.equal(r.body.data.status, 'COMPLETED');
  assert.equal(r.body.data.hasil, 'GAGAL_SEMAI');
  assert.equal(r.body.data.lot.length, 0);
});

test('3B: data migrasi perlu_tinjau tetap terlacak tetapi tidak bisa dilanjutkan', { skip: lewati }, async () => {
  const s = (await q("SELECT id, legacy_semai_id, legacy_pendewasaan_yatim, alasan_tinjau FROM siklus_budidaya WHERE asal = 'MIGRASI' AND perlu_tinjau ORDER BY id LIMIT 1"))[0];
  assert.ok(s, 'DB uji harus sudah dimigrasi (scripts/migrasi-siklus.js --jalan)');
  const d = await request(base).get(`/api/siklus/${s.id}`).set(bearer(admin));
  assert.equal(d.status, 200);
  assert.ok(d.body.legacy_semai_id || d.body.legacy_pendewasaan_yatim, 'jejak ke tabel lama');
  assert.ok(d.body.alasan_tinjau.length > 0);
  const sebelum = JSON.stringify((await q('SELECT * FROM siklus_budidaya WHERE id = $1', [s.id]))[0]);
  const r = await post(`/api/siklus/${s.id}/transisi`, { ke: 'CANCELLED', alasan: 'coba batalkan data migrasi' });
  assert.equal(r.status, 409);
  assert.equal(r.body.kode, 'perlu_tinjau');
  const lot = (await q("SELECT id FROM siklus_lot WHERE perlu_tinjau AND status = 'PROSES' LIMIT 1"))[0];
  if (lot) {
    const x = await post(`/api/lot/${lot.id}/selesai`, { berhasil: 1, gagal: 0 });
    assert.equal(x.status, 409);
    assert.equal(x.body.kode, 'perlu_tinjau');
  }
  assert.equal(JSON.stringify((await q('SELECT * FROM siklus_budidaya WHERE id = $1', [s.id]))[0]), sebelum, 'baris migrasi tidak berubah');
  const daftar = await request(base).get('/api/siklus?perlu_tinjau=true').set(bearer(admin));
  assert.ok(daftar.body.every((x) => x.perlu_tinjau));
});

test('3B: status parameter terlihat lewat API (tanpa nilai karangan)', { skip: lewati }, async () => {
  const r = await request(base).get('/api/siklus/parameter').set(bearer(petani));
  assert.equal(r.status, 200);
  const m = Object.fromEntries(r.body.map((x) => [x.param, x]));
  assert.equal(m.maks_gagal_berturut.status, 'SIAP');
  assert.equal(m.konfirmasi_peremajaan_jam_ke.status, 'SIAP');
  for (const k of ['maks_masa_persetujuan_menit', 'min_progres_persen', 'maks_lampau_persen', 'stabil_menit', 'stabil_n_bacaan', 'limit_batas_ons_pompa']) {
    assert.equal(m[k].status, 'NULL', k);
    assert.equal(m[k].nilai, null, k);
  }
});
