'use strict';
/**
 * Fase 3B.3 — versi preset lewat API (audit), batas operasi per preset, gerbang dosis per siklus (snapshot).
 * HANYA DB uji (`garap_uji*`). Memakai preset Bayam hasil migrasi: versi baru yang dibuat lewat API tidak bisa
 * dihapus (isi versi beku — disengaja), jadi tertinggal di DB uji; versi aktif dipulihkan di after().
 * Angka batas_operasi di sini hanya fixture uji, bukan nilai agronomis.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');
const { startServer, stopChild, craftToken, bearer } = require('./_server');
const { pool, q } = require('../../src/db');

const namaDb = new URL(process.env.DATABASE_URL || 'postgres://x/none').pathname.slice(1);
const lewati = namaDb.startsWith('garap_uji') ? false : `hanya untuk DB uji garap_uji* (sekarang: ${namaDb || 'dari .env'})`;
let srv; let admin; let petani; let preset; let meja; const siklusUji = [];
const BATAS = { tds_min_ppm: 100, tds_max_ppm: 900, ph_min: 5, ph_max: 7 };

before(async () => {
  if (lewati) return;
  process.env.RATE_LIMIT_WRITE = '1000';
  srv = await startServer();
  const idAdmin = Number((await q("SELECT id FROM users WHERE level = 'admin' AND NOT is_demo ORDER BY id LIMIT 1"))[0].id);
  admin = craftToken({ sub: idAdmin, username: 'garap', level: 'admin', demo: false }, { expiresIn: '10m' });
  petani = craftToken({ sub: idAdmin, username: 'p', level: 'petani', demo: false }, { expiresIn: '10m' });
  preset = (await q(`SELECT p.id, p.id_tanaman, p.aktif_versi_id FROM preset_nutrisi p JOIN tanamen t USING (id_tanaman)
                      WHERE t.nama_tanaman = 'Bayam' AND p.aktif_versi_id IS NOT NULL LIMIT 1`))[0];
  meja = Number((await q("INSERT INTO mejas (meja, jumlah_lubang, created_at, updated_at) VALUES ('uji-3b3-gerbang', 1, now(), now()) RETURNING id_meja"))[0].id_meja);
});
after(async () => {
  if (!lewati) {
    try {
      if (siklusUji.length) {
        await q("DELETE FROM audit_logs WHERE tabel = 'siklus_budidaya' AND row_id = ANY($1::text[])", [siklusUji.map(String)]);
        await q('DELETE FROM siklus_transisi WHERE id_siklus = ANY($1)', [siklusUji]);
        await q('DELETE FROM siklus_budidaya WHERE id = ANY($1)', [siklusUji]);
      }
      if (preset) await q('UPDATE preset_nutrisi SET aktif_versi_id = $2 WHERE id = $1', [preset.id, preset.aktif_versi_id]);
      await q('DELETE FROM monitorings WHERE id_meja = $1', [meja]);
      await q('DELETE FROM mejas WHERE id_meja = $1', [meja]);
    } finally { await stopChild(srv?.child); }
  }
  await pool.end();
});

const api = (m, p, t = admin) => request(srv.base)[m](p).set(bearer(t));
async function siklusPreset(idVersi) {
  const r = await api('post', '/api/siklus').set('Idempotency-Key', crypto.randomUUID()).send({
    id_tanaman: Number(preset.id_tanaman), id_meja: meja, mode_target: 'PRESET', id_preset_versi: idVersi, ph_aktual: 6, tds_aktual_ppm: 400, jumlah_benih: 10,
  });
  assert.equal(r.status, 201, r.text);
  siklusUji.push(r.body.data.id);
  return r.body.data.id;
}
const gerbang = async (id) => (await api('get', `/api/siklus/${id}/gerbang-dosis`, petani)).body;

test('3B.3 preset: versi baru lewat API — admin saja, bentuk divalidasi, ber-audit, BELUM_TERVALIDASI', { skip: lewati }, async () => {
  assert.ok(preset, 'DB uji harus berisi preset Bayam hasil migrasi');
  assert.equal((await api('post', `/api/preset/${preset.id}/versi`, petani).send({ parameter: {}, catatan: 'uji petani' })).status, 403);
  const salah = await api('post', `/api/preset/${preset.id}/versi`).send({ parameter: { batas_operasi: { tds_min_ppm: 900, tds_max_ppm: 100, ph_min: 5, ph_max: 7 } }, catatan: 'uji salah' });
  assert.equal(salah.status, 422);
  assert.ok(salah.body.errors.batas_operasi);
  assert.equal((await api('post', `/api/preset/${preset.id}/versi`).send({ parameter: { ec_target: 5 }, catatan: 'uji kunci asing' })).status, 422);
  const ok = await api('post', `/api/preset/${preset.id}/versi`).send({ parameter: { batas_operasi: BATAS }, catatan: 'uji 3B.3 fixture batas operasi' });
  assert.equal(ok.status, 201, ok.text);
  assert.equal(ok.body.data.status_validasi, 'BELUM_TERVALIDASI');
  const a = await q("SELECT aksi FROM audit_logs WHERE tabel = 'preset_versi' AND row_id = $1", [String(ok.body.data.id)]);
  assert.deepEqual(a.map((x) => x.aksi), ['create']);
});

test('3B.3 gerbang: preset rancangan & tanpa batas operasi → ditolak; ganti versi aktif tidak mengubah snapshot siklus berjalan', { skip: lewati }, async () => {
  const lama = await siklusPreset(Number(preset.aktif_versi_id));
  let g = await gerbang(lama);
  assert.equal(g.boleh, false);
  for (const a of ['preset_belum_tervalidasi', 'batas_operasi_belum_ada', 'bacaan_tidak_ada', 'eksekusi_dosis_diblokir']) assert.ok(g.alasan.includes(a), `${a}: ${g.alasan}`);
  const v = await api('post', `/api/preset/${preset.id}/versi`).send({ parameter: { batas_operasi: BATAS }, catatan: 'uji 3B.3 versi untuk diaktifkan' });
  const akt = await api('post', `/api/preset/${preset.id}/versi/${v.body.data.versi}/aktifkan`);
  assert.equal(akt.status, 200, akt.text);
  assert.equal((await api('post', `/api/preset/${preset.id}/versi/${v.body.data.versi}/aktifkan`)).body.kode, 'sudah_aktif');
  assert.equal((await q("SELECT count(*)::int n FROM audit_logs WHERE tabel = 'preset_nutrisi' AND row_id = $1 AND aksi = 'update'", [String(preset.id)]))[0].n >= 1, true);
  g = await gerbang(lama);
  assert.equal(g.id_preset_versi, Number(preset.aktif_versi_id), 'siklus lama tetap memakai versi snapshot');
  assert.ok(g.alasan.includes('batas_operasi_belum_ada'));

  const baru = await siklusPreset(Number(v.body.data.id));
  assert.ok((await gerbang(baru)).alasan.includes('preset_belum_tervalidasi'), 'versi rancangan tidak mengizinkan dosis');
  assert.equal((await api('post', `/api/preset/${preset.id}/versi/${v.body.data.versi}/validasi`).send({ catatan: 'uji 3B.3 validasi fixture (bukan agronom)' })).status, 200);
  await q('INSERT INTO monitorings (ph, tds, "waterTemp", id_meja, created_at, updated_at, n_konfirmasi, celah_maks_detik) VALUES (6, 500, 25, $1, now(), now(), 1, 0)', [meja]);
  g = await gerbang(baru);
  assert.deepEqual(g.alasan, ['eksekusi_dosis_diblokir'], 'semua syarat lain terpenuhi, eksekusi tetap diblokir');
  assert.equal(g.boleh, false);
  await q('INSERT INTO monitorings (ph, tds, "waterTemp", id_meja, created_at, updated_at, n_konfirmasi, celah_maks_detik) VALUES (6, 1500, 25, $1, now(), now(), 1, 0)', [meja]);
  assert.ok((await gerbang(baru)).alasan.includes('di_luar_batas_operasi'));
  await q('INSERT INTO monitorings (ph, tds, "waterTemp", id_meja, created_at, updated_at, n_konfirmasi, celah_maks_detik) VALUES (6, 20, 25, $1, now(), now(), 1, 0)', [meja]);
  assert.ok((await gerbang(baru)).alasan.includes('bacaan_tidak_wajar'));
});

test('3B.4 gerbang: 3 bacaan mustahil di penampung siklus → sensor_rusak_3x, wajib_lock; GET tidak mengunci', { skip: lewati }, async () => {
  // tes sebelumnya mengaktifkan versi lain → pakai versi yang aktif SEKARANG
  const aktif = (await q('SELECT aktif_versi_id FROM preset_nutrisi WHERE id = $1', [preset.id]))[0].aktif_versi_id;
  const id = await siklusPreset(Number(aktif));
  for (let i = 0; i < 3; i += 1) {
    await q('INSERT INTO monitorings (ph, tds, "waterTemp", id_meja, created_at, updated_at, n_konfirmasi, celah_maks_detik) VALUES (6, $2, 25, $1, now(), now(), 1, 0)', [meja, 10 + i]);
  }
  const g = await gerbang(id);
  assert.ok(g.alasan.includes('sensor_rusak_3x'), g.alasan.join());
  assert.equal(g.wajib_lock, true);
  const st = (await q('SELECT status_lock FROM penampung_states WHERE id_meja = $1', [meja]))[0];
  assert.ok(!st || st.status_lock === false, 'evaluasi (GET) tidak berefek samping');
});
