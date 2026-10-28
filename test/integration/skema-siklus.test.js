'use strict';
/**
 * Skema Fase 3A (migrasi 2026-10-29_01/02): constraint, trigger beku, dan pelindung operasi ganda.
 * Semua uji berjalan di DALAM satu transaksi yang di-ROLLBACK → DB tidak berubah.
 * Dilewati bila migrasi belum dijalankan di DB tujuan.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../../src/db');

let c; let ada = false; let meja; let tanaman; let user;

before(async () => {
  c = await pool.connect();
  ada = (await c.query("SELECT to_regclass('siklus_budidaya') IS NOT NULL AND to_regclass('persetujuan_dosing') IS NOT NULL AS ada")).rows[0].ada;
  if (!ada) return;
  await c.query('BEGIN');
  meja = (await c.query("INSERT INTO mejas (meja, jumlah_lubang, created_at, updated_at) VALUES ('uji-skema-3a', 10, now(), now()) RETURNING id_meja")).rows[0].id_meja;
  tanaman = (await c.query("INSERT INTO tanamen (nama_tanaman, created_at, updated_at) VALUES ('uji-skema-3a', now(), now()) RETURNING id_tanaman")).rows[0].id_tanaman;
  user = (await c.query('SELECT id FROM users ORDER BY id LIMIT 1')).rows[0].id;
});

after(async () => {
  if (ada) await c.query('ROLLBACK');
  c.release();
  await pool.end();
});

/** Jalankan sql di savepoint; kembalikan pesan galat (null bila sukses). */
async function coba(sql, params) {
  await c.query('SAVEPOINT s');
  try {
    const r = await c.query(sql, params);
    await c.query('RELEASE SAVEPOINT s');
    return { ok: true, rows: r.rows };
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT s');
    return { ok: false, galat: e.message };
  }
}

const siklus = (o = {}) => coba(
  `INSERT INTO siklus_budidaya (id_tanaman, id_meja_semai, mode_target, jumlah_benih, benih_berhasil, benih_gagal, status, semai_mulai_pada, asal)
   VALUES ($1,$2,'MANUAL',$3,$4,$5,$6,$7,$8) RETURNING id`,
  [o.tanaman === undefined ? tanaman : o.tanaman, o.meja === undefined ? meja : o.meja, o.jumlah ?? 100, o.ok ?? null, o.gagal ?? null,
    o.status ?? 'DRAFT', o.mulai ?? null, o.asal ?? 'BARU']);

test('skema: siklus BARU wajib benih cocok, tanaman & meja; MIGRASI boleh selisih', async (t) => {
  if (!ada) return t.skip('migrasi 3A belum dijalankan');
  assert.equal((await siklus({ ok: 60, gagal: 40 })).ok, true);
  assert.match((await siklus({ ok: 60, gagal: 39 })).galat, /siklus_benih_cocok/);
  assert.match((await siklus({ ok: 60 })).galat, /siklus_benih_cocok/);
  assert.match((await siklus({ tanaman: null })).galat, /siklus_tanaman_wajib/);
  assert.match((await siklus({ meja: null })).galat, /siklus_meja_wajib/);
  assert.match((await siklus({ jumlah: 0 })).galat, /siklus_benih_positif/);
  assert.match((await siklus({ status: 'SEEDING' })).galat, /siklus_semai_waktu/);
  const m = await coba(`INSERT INTO siklus_budidaya (jumlah_benih, benih_berhasil, benih_gagal, status, asal, perlu_tinjau, alasan_tinjau, selesai_pada)
    VALUES (60, 0, 0, 'COMPLETED', 'MIGRASI', true, ARRAY['berhasil+gagal ≠ jumlah'], now()) RETURNING id`);
  assert.equal(m.ok, true, m.galat);
  assert.match((await coba(`INSERT INTO siklus_budidaya (jumlah_benih, status, asal, perlu_tinjau) VALUES (1, 'DRAFT', 'MIGRASI', true)`)).galat,
    /siklus_tinjau_cek/);
});

test('skema: satu siklus persiapan/semai per penampung', async (t) => {
  if (!ada) return t.skip('migrasi 3A belum dijalankan');
  assert.equal((await siklus({ status: 'TANK_PREPARATION' })).ok, true);
  assert.match((await siklus({ status: 'SEEDING', mulai: new Date() })).galat, /siklus_budidaya_meja_semai_unik/);
  assert.equal((await siklus({ status: 'DRAFT' })).ok, true, 'DRAFT tidak terhitung aktif');
});

test('skema: lot baru wajib jumlah cocok; lot legacy dikecualikan', async (t) => {
  if (!ada) return t.skip('migrasi 3A belum dijalankan');
  const s = (await siklus({ ok: 50, gagal: 50 })).rows[0].id;
  const lot = (o) => coba(
    `INSERT INTO siklus_lot (id_siklus, tahap, id_meja, jumlah_masuk, berhasil, gagal, status, selesai_pada, legacy_tabel, legacy_id)
     VALUES ($1,'PEREMAJAAN',$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [s, meja, o.masuk ?? null, o.ok ?? null, o.gagal ?? null, o.status ?? 'PROSES', o.selesai ?? null, o.lt ?? null, o.li ?? null]);
  assert.equal((await lot({ masuk: 50 })).ok, true);
  assert.match((await lot({})).galat, /siklus_lot_jumlah_cek/);
  assert.match((await lot({ masuk: 50, ok: 40, gagal: 9 })).galat, /siklus_lot_jumlah_cek/);
  assert.match((await lot({ masuk: 50, status: 'SELESAI' })).galat, /siklus_lot_selesai_cek/);
  assert.equal((await lot({ masuk: 3, ok: 3, gagal: 3, lt: 'peremajaans', li: -99 })).ok, true);
  assert.match((await lot({ masuk: 3, lt: 'peremajaans', li: -99 })).galat, /siklus_lot_legacy_unik/);
});

test('skema: satu permintaan konfirmasi PENDING per (siklus, jenis)', async (t) => {
  if (!ada) return t.skip('migrasi 3A belum dijalankan');
  const id = (await siklus({ ok: 1, gagal: 99 })).rows[0].id;
  const minta = () => coba(
    "INSERT INTO permintaan_konfirmasi (id_siklus, jenis, kedaluwarsa_pada) VALUES ($1, 'REJUVENATION', now() + interval '24 hours') RETURNING id", [id]);
  const a = await minta();
  assert.equal(a.ok, true, a.galat);
  assert.match((await minta()).galat, /permintaan_konfirmasi_pending_unik/);
  await c.query("UPDATE permintaan_konfirmasi SET status = 'EXPIRED' WHERE id = $1", [a.rows[0].id]);
  assert.equal((await minta()).ok, true, 'setelah EXPIRED boleh dijadwalkan ulang');
  assert.match((await coba("UPDATE permintaan_konfirmasi SET status = 'ANSWERED_READY' WHERE id_siklus = $1 AND status = 'PENDING'", [id])).galat,
    /konfirmasi_jawab_cek/);
});

test('skema: preset_versi beku (parameter tidak bisa diubah/dihapus)', async (t) => {
  if (!ada) return t.skip('migrasi 3A belum dijalankan');
  const p = (await c.query("INSERT INTO preset_nutrisi (id_tanaman, nama) VALUES ($1, 'uji') RETURNING id", [tanaman])).rows[0].id;
  const v = (await c.query("INSERT INTO preset_versi (id_preset, versi, parameter, sumber) VALUES ($1, 1, '{\"a\":1}', 'uji') RETURNING id", [p])).rows[0].id;
  assert.match((await coba(`UPDATE preset_versi SET parameter = '{"a":2}' WHERE id = $1`, [v])).galat, /beku/);
  assert.match((await coba('DELETE FROM preset_versi WHERE id = $1', [v])).galat, /tidak boleh dihapus/);
  assert.match((await coba("UPDATE preset_versi SET status_validasi = 'TERVALIDASI' WHERE id = $1", [v])).galat, /preset_versi_validasi_cek/);
  assert.equal((await coba("UPDATE preset_versi SET status_validasi = 'TERVALIDASI', divalidasi_pada = now(), divalidasi_oleh = $2 WHERE id = $1", [v, user])).ok, true);
  assert.match((await coba("UPDATE preset_versi SET status_validasi = 'BELUM_TERVALIDASI' WHERE id = $1", [v])).galat, /tidak bisa dicabut/);
  assert.match((await coba("INSERT INTO preset_versi (id_preset, versi) VALUES ($1, 1)", [p])).galat, /preset_versi_unik/);
});

test('skema: persetujuan dosing — cakupan, 1:1 siklus, beku kecuali pencabutan', async (t) => {
  if (!ada) return t.skip('migrasi 3A belum dijalankan');
  const ev = (status) => coba(
    `INSERT INTO dosing_events (id_meja, hari, pemicu, aktor_tipe, status, mode) VALUES ($1, current_date, 'SISTEM', 'system', $2, 'OTOMATIS') RETURNING id`,
    [meja, status]);
  const e1 = (await ev('WAITING_APPROVAL')).rows[0].id;
  assert.match((await ev('APPROVED')).galat, /dosing_events_aktif_unik/, 'satu siklus dosing aktif per penampung');
  assert.match((await coba(`INSERT INTO dosing_events (id_meja, hari, pemicu, aktor_tipe, status) VALUES ($1, current_date, 'SISTEM', 'system', 'SUCCESS')`, [meja])).galat,
    /dosing_events_alur_baru_cek/);
  const setuju = (o = {}) => coba(
    `INSERT INTO persetujuan_dosing (id_kejadian, keputusan, oleh, pompa_diizinkan, maks_ml_per_percobaan, maks_ml_total, maks_percobaan, berlaku_sampai, idempotency_key)
     VALUES ($1, 'SETUJU', $2, $3, $4, $5, $6, now() + interval '1 hour', gen_random_uuid()) RETURNING id`,
    [o.ev ?? e1, user, o.pompa ?? ['AB'], o.ml ?? 50, o.total ?? 100, o.n ?? 2]);
  assert.match((await setuju({ n: 5 })).galat, /persetujuan_cakupan_cek/, 'maks 4 percobaan');
  assert.match((await setuju({ pompa: ['AIR'] })).galat, /persetujuan_cakupan_cek/);
  assert.match((await setuju({ total: 10 })).galat, /persetujuan_cakupan_cek/);
  const ok = await setuju();
  assert.equal(ok.ok, true, ok.galat);
  assert.match((await setuju()).galat, /persetujuan_dosing_id_kejadian_key/, 'persetujuan tidak bisa dipakai dua kali');
  const id = ok.rows[0].id;
  assert.match((await coba('UPDATE persetujuan_dosing SET maks_ml_total = 999 WHERE id = $1', [id])).galat, /beku/);
  assert.match((await coba('DELETE FROM persetujuan_dosing WHERE id = $1', [id])).galat, /tidak boleh dihapus/);
  assert.equal((await coba("UPDATE persetujuan_dosing SET dicabut_pada = now(), dicabut_oleh = $2, alasan_cabut = 'uji' WHERE id = $1", [id, user])).ok, true);
  assert.match((await coba("UPDATE persetujuan_dosing SET alasan_cabut = 'lagi' WHERE id = $1", [id])).galat, /sudah dicabut/);
});

test('skema 3B: status validasi parameter gugur saat nilai berubah; NULL tidak bisa divalidasi', async (t) => {
  if (!ada) return t.skip('migrasi 3A belum dijalankan');
  const kol = (await c.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'timing_operasi' AND column_name = 'tervalidasi'")).rows[0];
  if (!kol) return t.skip('migrasi 3B (2026-10-29_03) belum dijalankan');
  const baca = async () => (await c.query("SELECT nilai, tervalidasi, catatan_validasi FROM timing_operasi WHERE param = 'konfirmasi_peremajaan_jam_ke'")).rows[0];
  assert.equal((await baca()).tervalidasi, true);
  await c.query("UPDATE timing_operasi SET nilai = nilai + 1 WHERE param = 'konfirmasi_peremajaan_jam_ke'");
  const b = await baca();
  assert.equal(b.tervalidasi, false);
  assert.equal(b.catatan_validasi, null);
  assert.match((await coba("UPDATE timing_operasi SET tervalidasi = true WHERE param = 'ulang_konfirmasi_jam'")).galat, /timing_operasi_validasi_cek/);
  assert.match((await coba("UPDATE konfigurasi_dosis SET tervalidasi = true, divalidasi_pada = now() WHERE param = 'min_progres_persen'")).galat, /konfigurasi_dosis_validasi_cek/);
  // validasi ulang eksplisit dalam UPDATE yang sama tetap boleh
  await c.query(`UPDATE timing_operasi SET nilai = 96, tervalidasi = true, divalidasi_pada = now(), catatan_validasi = 'uji'
                  WHERE param = 'konfirmasi_peremajaan_jam_ke'`);
  assert.equal((await baca()).tervalidasi, true);
});

test('skema: perintah satu-percobaan-satu-DOSIS & parameter baru NULL', async (t) => {
  if (!ada) return t.skip('migrasi 3A belum dijalankan');
  const ev = (await c.query(
    `INSERT INTO dosing_events (id_meja, hari, pemicu, aktor_tipe, status, mode) VALUES ($1, current_date, 'SISTEM', 'system', 'CANCELLED', 'MANUAL') RETURNING id`, [meja])).rows[0].id;
  const r = (await c.query("INSERT INTO dosing_rounds (id_kejadian, ronde_ke, jenis, volume_ml, hasil) VALUES ($1, 1, 'AB', 10, 'dibatalkan') RETURNING id", [ev])).rows[0].id;
  const per = () => coba(
    `INSERT INTO perintah_aktuator (perangkat_kode, tipe, parameter, sumber, kedaluwarsa_pada, id_kejadian, id_percobaan)
     VALUES ('aktuator-01', 'DOSIS', '{}', 'sistem', now() + interval '1 minute', $1, $2) RETURNING id`, [ev, r]);
  assert.equal((await per()).ok, true);
  assert.match((await per()).galat, /perintah_aktuator_percobaan_unik/);
  const cfg = Object.fromEntries((await c.query(
    "SELECT param, nilai FROM konfigurasi_dosis WHERE param IN ('maks_gagal_berturut','maks_masa_persetujuan_menit','min_progres_persen','maks_lampau_persen','wajib_firmware_v03')")).rows
    .map((x) => [x.param, x.nilai]));
  assert.equal(Number(cfg.maks_gagal_berturut), 4);
  assert.equal(cfg.maks_masa_persetujuan_menit, null);
  assert.equal(cfg.min_progres_persen, null);
  assert.equal(cfg.maks_lampau_persen, null);
  const mode = (await c.query("SELECT column_default FROM information_schema.columns WHERE table_name = 'penampung_states' AND column_name = 'mode_operasi'")).rows[0];
  assert.match(mode.column_default, /MANUAL/);
});
