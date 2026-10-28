'use strict';
/**
 * Fase 3B.1 — penugasan petani ↔ penampung, batas 96 jam (termasuk data migrasi berpresisi tanggal),
 * idempotensi jawaban, preset & snapshot, dan pemicu kestabilan tandon.
 *
 * HANYA di DB uji (`garap_uji*`). Membuat user/meja/tanaman/preset uji `uji-3b1`, mengubah parameter
 * sementara, menulis bacaan monitorings untuk meja uji; semuanya dihapus/dipulihkan di after() dan
 * tabel historis diverifikasi identik.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');
const { startServer, stopChild, craftToken, bearer, delay } = require('./_server');
const { pool, q } = require('../../src/db');
const svc = require('../../src/siklusBudidaya');

const namaDb = new URL(process.env.DATABASE_URL || 'postgres://x/none').pathname.slice(1);
const lewati = namaDb.startsWith('garap_uji') ? false : `hanya untuk DB uji garap_uji* (sekarang: ${namaDb || 'dari .env'})`;

let srv; let base; let admin; let demo; let idAdmin;
const tok = {}; const uid = {}; const meja = [];
let tanaman; let presetId; let hashLama; let paramAwal;
const siklusUji = new Set();

const PARAM_T = ['stabil_menit', 'stabil_n_bacaan', 'konfirmasi_tandon_jam'];
const PARAM_K = ['stabil_toleransi_ph', 'stabil_toleransi_tds_ppm'];
const kunci = () => crypto.randomUUID();
const post = (path, body, t = admin, k = kunci()) => request(base).post(path).set(bearer(t)).set('Idempotency-Key', k).send(body);
const target = { ec_min_ppm: 400, ec_max_ppm: 600, ph_min: 5.8, ph_max: 6.5 };
const manual = (idMeja, o = {}) => ({ id_tanaman: tanaman, id_meja: idMeja, mode_target: 'MANUAL', ph_aktual: 6.1, tds_aktual_ppm: 450, jumlah_benih: 50, target, ...o });

async function hashHistoris() {
  const out = {};
  for (const t of ['semais', 'peremajaans', 'pendewasaans', 'panens', 'sikluses', 'target_nutrisi']) {
    out[t] = (await q(`SELECT count(*) n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) h FROM ${t} x`))[0];
  }
  return JSON.stringify(out);
}

async function fixtureSemai({ idMeja, jamLalu = 97, presisi = 'DETIK', asal = 'BARU', jadwal = 'now()' } = {}) {
  const id = Number((await q(
    `INSERT INTO siklus_budidaya (id_tanaman, id_meja_semai, mode_target, target, jumlah_benih, status, semai_mulai_pada,
       waktu_presisi, jadwal_konfirmasi_berikut, asal, selesai_pada)
     VALUES ($1,$2,'MANUAL',$3,50,'SEEDING', now() - make_interval(secs => $4::float8 * 3600), $5, ${jadwal}, $6, NULL) RETURNING id`,
    [tanaman, idMeja, target, jamLalu, presisi, asal]))[0].id);
  siklusUji.add(id);
  return id;
}

async function setParam(tabel, param, nilai, valid) {
  await q(`UPDATE ${tabel} SET nilai = $2, tervalidasi = $3, divalidasi_pada = CASE WHEN $3 THEN now() END,
           catatan_validasi = CASE WHEN $3 THEN 'uji 3B.1 (sementara)' END WHERE param = $1`, [param, nilai, valid]);
}

before(async () => {
  if (lewati) return;
  process.env.RATE_LIMIT_WRITE = '1000';
  srv = await startServer(); base = srv.base;
  idAdmin = Number((await q("SELECT id FROM users WHERE level = 'admin' AND NOT is_demo ORDER BY id LIMIT 1"))[0].id);
  admin = craftToken({ sub: idAdmin, username: 'garap', level: 'admin', demo: false }, { expiresIn: '20m' });
  demo = craftToken({ sub: idAdmin, username: 'demo', level: 'user', demo: true }, { expiresIn: '20m' });
  hashLama = await hashHistoris();
  paramAwal = [
    ...(await q('SELECT \'timing_operasi\' t, param, nilai, tervalidasi, divalidasi_pada, catatan_validasi FROM timing_operasi WHERE param = ANY($1)', [PARAM_T])),
    ...(await q('SELECT \'konfigurasi_dosis\' t, param, nilai, tervalidasi, divalidasi_pada, catatan_validasi FROM konfigurasi_dosis WHERE param = ANY($1)', [PARAM_K])),
  ];
  for (const k of ['a', 'b']) {
    // password '!' bukan hash bcrypt → akun uji tidak bisa login; token dibuat langsung
    uid[k] = Number((await q(`INSERT INTO users (username, email, password, level, is_demo, created_at, updated_at)
      VALUES ($1, $2, '!', 'petani', false, now(), now()) RETURNING id`, [`uji-3b1-${k}`, `uji-3b1-${k}@contoh.invalid`]))[0].id);
    tok[k] = craftToken({ sub: uid[k], username: `uji-3b1-${k}`, level: 'petani', demo: false }, { expiresIn: '20m' });
  }
  for (let i = 0; i < 5; i += 1) {
    meja.push(Number((await q("INSERT INTO mejas (meja, jumlah_lubang, created_at, updated_at) VALUES ($1, 10, now(), now()) RETURNING id_meja", [`uji-3b1-${i}`]))[0].id_meja));
  }
  tanaman = Number((await q("INSERT INTO tanamen (nama_tanaman, created_at, updated_at) VALUES ('uji-3b1', now(), now()) RETURNING id_tanaman"))[0].id_tanaman);
});

after(async () => {
  if (lewati) { await pool.end(); return; }
  try {
    const ids = [...siklusUji];
    await q("DELETE FROM notifikasi WHERE (tautan->>'id_siklus')::bigint = ANY($1) OR (tautan->>'tipe' = 'siklus' AND (tautan->>'id')::bigint = ANY($1))", [ids]);
    await q("DELETE FROM audit_logs WHERE (tabel = 'siklus_budidaya' AND row_id = ANY($1::text[])) OR (tabel = 'penugasan_penampung' AND row_id IN (SELECT id::text FROM penugasan_penampung WHERE id_meja = ANY($2)))", [ids.map(String), meja]);
    await q('DELETE FROM siklus_transisi WHERE id_siklus = ANY($1)', [ids]);
    await q('DELETE FROM permintaan_konfirmasi WHERE id_siklus = ANY($1)', [ids]);
    for (const tahap of ['PANEN', 'PENDEWASAAN', 'PEREMAJAAN']) await q('DELETE FROM siklus_lot WHERE id_siklus = ANY($1) AND tahap = $2', [ids, tahap]);
    await q('DELETE FROM siklus_budidaya WHERE id = ANY($1)', [ids]);
    if (presetId) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query("SET LOCAL garap.rollback_migrasi = 'on'");
        await c.query("DELETE FROM audit_logs WHERE tabel = 'preset_versi' AND row_id IN (SELECT id::text FROM preset_versi WHERE id_preset = $1)", [presetId]);
        await c.query('UPDATE preset_nutrisi SET aktif_versi_id = NULL WHERE id = $1', [presetId]);
        await c.query('DELETE FROM preset_versi WHERE id_preset = $1', [presetId]);
        await c.query('DELETE FROM preset_nutrisi WHERE id = $1', [presetId]);
        await c.query('COMMIT');
      } finally { c.release(); }
    }
    for (const p of paramAwal) {
      await q(`UPDATE ${p.t} SET nilai = $2, tervalidasi = $3, divalidasi_pada = $4, catatan_validasi = $5 WHERE param = $1`,
        [p.param, p.nilai, p.tervalidasi, p.divalidasi_pada, p.catatan_validasi]);
    }
    await q('DELETE FROM monitorings WHERE id_meja = ANY($1)', [meja]);
    await q('DELETE FROM penampung_states WHERE id_meja = ANY($1)', [meja]);
    await q('DELETE FROM penugasan_penampung WHERE id_meja = ANY($1)', [meja]);
    await q('DELETE FROM mejas WHERE id_meja = ANY($1)', [meja]);
    await q('DELETE FROM tanamen WHERE id_tanaman = $1', [tanaman]);
    await q('DELETE FROM users WHERE id = ANY($1)', [Object.values(uid)]);
    assert.equal(await hashHistoris(), hashLama, 'tabel historis harus identik setelah tes');
  } finally {
    await stopChild(srv?.child);
    await pool.end();
  }
});

const tugaskan = async (k, i) => {
  const r = await request(base).post('/api/penugasan').set(bearer(admin)).send({ id_user: uid[k], id_meja: meja[i] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data.id;
};
const cabut = (id) => request(base).post(`/api/penugasan/${id}/cabut`).set(bearer(admin)).send({ alasan: 'uji pencabutan' });

test('3B.1 penugasan: hanya admin yang menugaskan/mencabut; tercatat audit; petani melihat miliknya', { skip: lewati }, async () => {
  const id = await tugaskan('a', 0);
  assert.equal((await request(base).post('/api/penugasan').set(bearer(admin)).send({ id_user: uid.a, id_meja: meja[0] })).body.kode, 'sudah_ditugaskan');
  assert.equal((await request(base).post('/api/penugasan').set(bearer(admin)).send({ id_user: idAdmin, id_meja: meja[0] })).status, 422, 'hanya akun petani');
  assert.equal((await request(base).post('/api/penugasan').set(bearer(tok.a)).send({ id_user: uid.a, id_meja: meja[1] })).status, 403);
  assert.equal((await request(base).post('/api/penugasan').set(bearer(demo)).send({ id_user: uid.a, id_meja: meja[1] })).status, 403);
  const milik = await request(base).get('/api/penugasan').set(bearer(tok.b));
  assert.equal(milik.status, 200);
  assert.equal(milik.body.length, 0, 'petani B tidak melihat penugasan petani A');
  const a = await q("SELECT aksi FROM audit_logs WHERE tabel = 'penugasan_penampung' AND row_id = $1", [String(id)]);
  assert.deepEqual(a.map((x) => x.aksi), ['create']);
});

test('3B.1 otorisasi: petani hanya di penampung yang ditugaskan; demo ditolak; admin bebas', { skip: lewati }, async () => {
  const r = await post('/api/siklus', manual(meja[0]), tok.a);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  siklusUji.add(r.body.data.id);
  const lain = await post('/api/siklus', manual(meja[1]), tok.a);
  assert.equal(lain.status, 403);
  assert.equal(lain.body.kode, 'tidak_ditugaskan');
  assert.equal((await post('/api/siklus', manual(meja[0]), tok.b)).status, 403, 'petani B tidak ditugaskan');
  assert.equal((await post('/api/siklus', manual(meja[0]), demo)).status, 403);
  const id = r.body.data.id;
  assert.equal((await post(`/api/siklus/${id}/transisi`, { ke: 'TANK_PREPARATION' }, tok.b)).status, 403, 'petani B mengubah siklus penampung A');
  assert.equal((await post(`/api/siklus/${id}/transisi`, { ke: 'TANK_PREPARATION' }, tok.a)).status, 200);
  assert.equal((await post(`/api/siklus/${id}/konfirmasi`, {}, tok.a)).body.kode, 'akses_ditolak', 'konfirmasi manual khusus admin');
  const adm = await post('/api/siklus', manual(meja[1]), admin);
  assert.equal(adm.status, 201);
  siklusUji.add(adm.body.data.id);
  assert.equal((await post(`/api/siklus/${id}/transisi`, { ke: 'CANCELLED', alasan: 'dibatalkan petani' }, tok.a)).status, 200, 'petani boleh batal saat TANK_PREPARATION');
  await post(`/api/siklus/${adm.body.data.id}/transisi`, { ke: 'CANCELLED', alasan: 'bersihkan uji' });
});

test('3B.1 otorisasi: konfirmasi, benih & lot milik penampung lain ditolak', { skip: lewati }, async () => {
  const id = await fixtureSemai({ idMeja: meja[2], jadwal: "now() - interval '1 minute'" });
  await svc.jalankanPenjadwal();
  const p = (await svc.detail(id)).konfirmasi.at(-1);
  assert.equal((await post(`/api/konfirmasi/${p.id}/jawab`, { jawaban: 'SIAP' }, tok.a)).status, 403);
  const idT = await tugaskan('a', 2);
  const k = kunci();
  const j1 = await post(`/api/konfirmasi/${p.id}/jawab`, { jawaban: 'SIAP' }, tok.a, k);
  assert.equal(j1.status, 200, JSON.stringify(j1.body));
  const j2 = await post(`/api/konfirmasi/${p.id}/jawab`, { jawaban: 'SIAP' }, tok.a, k);
  assert.equal(j2.status, 200);
  assert.equal(j2.body.replay, true, 'pengulangan permintaan dengan kunci sama = replay');
  assert.equal((await post(`/api/konfirmasi/${p.id}/jawab`, { jawaban: 'BELUM_SIAP' }, tok.a, k)).status, 422, 'kunci sama, isi beda');
  assert.equal((await q("SELECT count(*)::int n FROM siklus_transisi WHERE id_siklus = $1 AND ke = 'WAITING_SEED_COUNT_CONFIRMATION'", [id]))[0].n, 1);
  const benihLain = await post(`/api/siklus/${id}/benih`, { jumlah_benih: 50, berhasil: 40, gagal: 10, id_meja_tujuan: meja[3] }, tok.a);
  assert.equal(benihLain.status, 403, 'meja tujuan tidak ditugaskan');
  assert.deepEqual(benihLain.body.id_meja, [meja[3]]);
  const b = await post(`/api/siklus/${id}/benih`, { jumlah_benih: 50, berhasil: 40, gagal: 10, id_meja_tujuan: meja[2] }, tok.a);
  assert.equal(b.status, 200, JSON.stringify(b.body));
  const lot = b.body.data.lot[0];
  assert.equal((await post(`/api/lot/${lot.id}/selesai`, { berhasil: 40, gagal: 0, tujuan: [{ id_meja: meja[4], jumlah: 40 }] }, tok.a)).status, 403);
  assert.equal((await post(`/api/lot/${lot.id}/selesai`, { berhasil: 40, gagal: 0, tujuan: [{ id_meja: meja[2], jumlah: 40 }] }, tok.b)).status, 403);
  assert.equal((await post(`/api/siklus/${id}/transisi`, { ke: 'CANCELLED', alasan: 'petani coba batal GROWTH' }, tok.a)).body.kode, 'akses_ditolak');
  // penugasan dicabut → hak hilang
  assert.equal((await cabut(idT)).status, 200);
  assert.equal((await cabut(idT)).body.kode, 'sudah_dicabut');
  assert.equal((await request(base).post(`/api/penugasan/${idT}/cabut`).set(bearer(admin)).send({ alasan: 'x' })).status, 422);
  const sesudah = await post(`/api/lot/${lot.id}/selesai`, { berhasil: 40, gagal: 0, tujuan: [{ id_meja: meja[2], jumlah: 40 }] }, tok.a);
  assert.equal(sesudah.status, 403, 'penugasan tidak aktif');
  await post(`/api/siklus/${id}/transisi`, { ke: 'CANCELLED', alasan: 'bersihkan uji' });
});

test('3B.1 otorisasi: pencabutan bersamaan — operasi tidak pernah lolos memakai penugasan yang sudah dicabut', { skip: lewati }, async () => {
  const idT = await tugaskan('b', 3);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("UPDATE penugasan_penampung SET aktif = false, dicabut_pada = now(), dicabut_oleh = $2, alasan_cabut = 'cabut bersamaan' WHERE id = $1", [idT, idAdmin]);
    let selesai = false;
    const jalan = post('/api/siklus', manual(meja[3]), tok.b).then((r) => { selesai = true; return r; });
    await delay(400);
    assert.equal(selesai, false, 'operasi menunggu pencabutan yang sedang berjalan (FOR SHARE)');
    await c.query('COMMIT');
    const r = await jalan;
    assert.equal(r.status, 403, JSON.stringify(r.body));
  } finally { c.release(); }
  assert.equal((await q('SELECT count(*)::int n FROM siklus_budidaya WHERE id_meja_semai = $1', [meja[3]]))[0].n, 0);
});

test('3B.1 konfirmasi: batas tepat 96 jam; data migrasi berpresisi tanggal dihitung dari akhir hari; tanpa jadwal otomatis', { skip: lewati }, async () => {
  const a = await fixtureSemai({ idMeja: meja[4], jamLalu: 95.98, jadwal: 'NULL' });
  assert.equal((await post(`/api/siklus/${a}/konfirmasi`, {})).body.kode, 'belum_waktunya');
  await q("UPDATE siklus_budidaya SET semai_mulai_pada = now() - interval '96 hours 1 minute' WHERE id = $1", [a]);
  const ok = await post(`/api/siklus/${a}/konfirmasi`, {});
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  await post(`/api/siklus/${a}/transisi`, { ke: 'CANCELLED', alasan: 'bersihkan uji' });

  // migrasi: hanya tanggal diketahui (disimpan 00:00); 97 jam dari tengah malam belum tentu 96 jam sejak semai
  const m = await fixtureSemai({ idMeja: meja[4], jamLalu: 97, presisi: 'TANGGAL', asal: 'MIGRASI', jadwal: 'NULL' });
  const hasil = await svc.jalankanPenjadwal();
  assert.equal((await svc.detail(m)).konfirmasi.length, 0, `siklus migrasi tanpa jadwal tidak diberi jadwal otomatis ${JSON.stringify(hasil)}`);
  assert.equal((await post(`/api/siklus/${m}/konfirmasi`, {})).body.kode, 'belum_waktunya');
  await q("UPDATE siklus_budidaya SET semai_mulai_pada = now() - interval '121 hours' WHERE id = $1", [m]);
  const m2 = await post(`/api/siklus/${m}/konfirmasi`, {});
  assert.equal(m2.status, 200, JSON.stringify(m2.body));
  assert.equal(m2.body.data.status, 'WAITING_REJUVENATION_CONFIRMATION', 'permintaan dibuat — bibit BELUM dianggap siap');
  const p = m2.body.data.konfirmasi.at(-1);
  await q("UPDATE permintaan_konfirmasi SET dibuat_pada = now() - interval '25 hours', kedaluwarsa_pada = now() - interval '1 second' WHERE id = $1", [p.id]);
  await svc.jalankanPenjadwal();
  const d = await svc.detail(m);
  assert.equal(d.status, 'SEEDING', 'kedaluwarsa ≠ siap');
  assert.equal(d.jadwal_konfirmasi_berikut, null);
  await post(`/api/siklus/${m}/transisi`, { ke: 'CANCELLED', alasan: 'bersihkan uji' });
});

test('3B.1 preset: kategori aktif/rancangan/tidak aktif, validasi admin, snapshot siklus tidak ikut berubah', { skip: lewati }, async () => {
  presetId = Number((await q("INSERT INTO preset_nutrisi (id_tanaman, nama) VALUES ($1, 'uji-3b1') RETURNING id", [tanaman]))[0].id);
  const v1 = Number((await q(`INSERT INTO preset_versi (id_preset, versi, parameter, sumber) VALUES ($1, 1, $2, 'migrasi: uji-3b1') RETURNING id`,
    [presetId, { tahap: { SEMAI: target } }]))[0].id);
  await q('UPDATE preset_nutrisi SET aktif_versi_id = $2 WHERE id = $1', [presetId, v1]);
  const kat = async () => Object.fromEntries((await request(base).get('/api/preset').set(bearer(tok.a))).body
    .filter((x) => Number(x.id) === presetId).map((x) => [x.versi, x.kategori]));
  assert.deepEqual(await kat(), { 1: 'AKTIF_RANCANGAN' });
  const s = await post('/api/siklus', { ...manual(meja[1]), mode_target: 'PRESET', id_preset_versi: v1, target: undefined });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  siklusUji.add(s.body.data.id);
  const v2 = Number((await q(`INSERT INTO preset_versi (id_preset, versi, parameter, sumber) VALUES ($1, 2, $2, 'migrasi: uji-3b1') RETURNING id`,
    [presetId, { tahap: { SEMAI: { ...target, ec_max_ppm: 900 } } }]))[0].id);
  await q('UPDATE preset_nutrisi SET aktif_versi_id = $2 WHERE id = $1', [presetId, v2]);
  assert.deepEqual(await kat(), { 1: 'TIDAK_AKTIF', 2: 'AKTIF_RANCANGAN' });
  const d = await svc.detail(s.body.data.id);
  assert.equal(d.target.parameter.tahap.SEMAI.ec_max_ppm, 600, 'snapshot siklus berjalan tetap versi 1');
  assert.equal(Number(d.target.id_preset_versi), v1);
  assert.equal((await post('/api/siklus', { ...manual(meja[1]), mode_target: 'PRESET', id_preset_versi: v1, target: undefined })).status, 422, 'versi tidak aktif tidak bisa dipakai');
  const val = (t, body) => request(base).post(`/api/preset/${presetId}/versi/2/validasi`).set(bearer(t)).send(body);
  assert.equal((await val(tok.a, { catatan: 'divalidasi oleh petani' })).status, 403);
  assert.equal((await val(admin, { catatan: 'pendek' })).status, 422);
  assert.equal((await val(admin, { catatan: 'uji: bukti validasi agronom (dokumen uji)' })).status, 200);
  assert.equal((await val(admin, { catatan: 'uji: validasi kedua kali' })).body.kode, 'sudah_tervalidasi');
  assert.deepEqual(await kat(), { 1: 'TIDAK_AKTIF', 2: 'AKTIF_TERVALIDASI' });
  await post(`/api/siklus/${s.body.data.id}/transisi`, { ke: 'CANCELLED', alasan: 'bersihkan uji' });
});

test('3B.1 tandon: transisi otomatis hanya bila parameter kestabilan SIAP dan bacaan teramati stabil', { skip: lewati }, async () => {
  const r = await post('/api/siklus', manual(meja[4]));
  const id = r.body.data.id;
  siklusUji.add(id);
  await post(`/api/siklus/${id}/transisi`, { ke: 'TANK_PREPARATION' });
  // bacaan identik 20 menit, diterima 240×, celah maks 5 dtk, terakhir 3 dtk lalu (bentuk deduplikasi)
  await q(`INSERT INTO monitorings ("waterTemp", ph, tds, "airTemp", humidity, id_meja, created_at, updated_at, n_konfirmasi, celah_maks_detik)
           VALUES (26, 6.0, 500, 28, 70, $1, now() - interval '20 minutes', now() - interval '3 seconds', 240, 5)`, [meja[4]]);

  let h = await svc.jalankanPenjadwal();
  assert.ok(h.dilewati.some((x) => /kestabilan tandon/.test(x)), JSON.stringify(h));
  assert.equal((await svc.detail(id)).status, 'TANK_PREPARATION', 'parameter NULL → tidak ada transisi otomatis');
  const diag = await request(base).get(`/api/siklus/${id}/kestabilan`).set(bearer(admin));
  assert.equal(diag.body.dievaluasi, false);

  await setParam('timing_operasi', 'stabil_menit', 10, false);
  await setParam('timing_operasi', 'stabil_n_bacaan', 5, false);
  await setParam('konfigurasi_dosis', 'stabil_toleransi_ph', 0.3, false);
  await setParam('konfigurasi_dosis', 'stabil_toleransi_tds_ppm', 50, false);
  h = await svc.jalankanPenjadwal();
  assert.equal((await svc.detail(id)).status, 'TANK_PREPARATION', 'nilai ada tetapi belum tervalidasi → tetap mati');

  for (const [t, p] of [['timing_operasi', 'stabil_menit'], ['timing_operasi', 'stabil_n_bacaan'], ['konfigurasi_dosis', 'stabil_toleransi_ph'], ['konfigurasi_dosis', 'stabil_toleransi_tds_ppm']]) {
    await q(`UPDATE ${t} SET tervalidasi = true, divalidasi_pada = now(), catatan_validasi = 'uji 3B.1 (sementara)' WHERE param = $1`, [p]);
  }
  // bacaan basi → bukan bukti
  await q("UPDATE monitorings SET updated_at = now() - interval '10 minutes' WHERE id_meja = $1", [meja[4]]);
  assert.match((await request(base).get(`/api/siklus/${id}/kestabilan`).set(bearer(admin))).body.alasan, /basi/);
  await svc.jalankanPenjadwal();
  assert.equal((await svc.detail(id)).status, 'TANK_PREPARATION');

  await q("UPDATE monitorings SET updated_at = now() - interval '3 seconds' WHERE id_meja = $1", [meja[4]]);
  h = await svc.jalankanPenjadwal();
  const d = await svc.detail(id);
  assert.equal(d.status, 'WAITING_TANK_CONFIRMATION', JSON.stringify(h));
  const p = d.konfirmasi.at(-1);
  assert.equal(p.jenis, 'TANK_READY');
  assert.equal(p.kedaluwarsa_pada, null, 'konfirmasi_tandon_jam NULL → tanpa batas, tidak pernah dianggap siap otomatis');
  assert.equal(d.transisi.at(-1).aktor_tipe, 'system');

  const j = await post(`/api/konfirmasi/${p.id}/jawab`, { jawaban: 'SIAP' });
  assert.equal(j.status, 200, JSON.stringify(j.body));
  assert.equal(j.body.data.status, 'SEEDING');
  const jam = (new Date(j.body.data.jadwal_konfirmasi_berikut) - new Date(j.body.data.semai_mulai_pada)) / 3600e3;
  assert.ok(Math.abs(jam - 96) < 0.01, `jadwal H+4 = 96 jam, dapat ${jam}`);
  await post(`/api/siklus/${id}/transisi`, { ke: 'CANCELLED', alasan: 'bersihkan uji' });
});
