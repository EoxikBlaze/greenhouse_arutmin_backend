'use strict';
/**
 * Fase 3F — id/angka ekstrem (di luar bigint, 1e20, string digit panjang) pada rute tulis non-dosing harus
 * menghasilkan 4xx terkontrol, bukan 500 (SQLSTATE 22003 tidak dijaring handler global).
 *
 * HANYA di DB uji (`garap_uji*`). Semua permintaan seharusnya ditolak; bila ada yang lolos, baris uji (keterangan
 * 'uji-3f') dihapus di after().
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');
const { startServer, stopChild, craftToken, bearer } = require('./_server');
const { pool, q } = require('../../src/db');

const { lewati } = require('./_isolasi'); // nama garap_uji* DAN host loopback

let srv; let base; let admin;
const BESAR = ['1e20', '99999999999999999999', '9'.repeat(40)];
const kunci = () => crypto.randomUUID();

before(async () => {
  if (lewati) return;
  process.env.RATE_LIMIT_WRITE = '5000';
  srv = await startServer(); base = srv.base;
  const id = Number((await q("SELECT id FROM users WHERE level = 'admin' AND NOT is_demo ORDER BY id LIMIT 1"))[0].id);
  admin = craftToken({ sub: id, username: 'garap', level: 'admin', demo: false }, { expiresIn: '20m' });
});

after(async () => {
  if (lewati) { await pool.end(); return; }
  try { await q("DELETE FROM target_nutrisi WHERE keterangan = 'uji-3f'"); } finally { await stopChild(srv?.child); await pool.end(); }
});

const kirim = (metode, path, body) => {
  const r = request(base)[metode](path).set(bearer(admin)).set('Idempotency-Key', kunci());
  return body === undefined ? r : r.send(body);
};
const harus4xx = (r, nama) => assert.ok(r.status >= 400 && r.status < 500, `${nama}: ${r.status} ${JSON.stringify(r.body).slice(0, 140)}`);

test('POST /dosing/preset: id_tanaman di luar bigint → 422, bukan 500', { skip: lewati }, async () => {
  for (const v of [1e20, ...BESAR]) {
    harus4xx(await kirim('post', '/dosing/preset', { tahap: 'Semai', id_tanaman: v, ec_min_ppm: 400, ec_max_ppm: 600, keterangan: 'uji-3f' }), `id_tanaman=${v}`);
  }
});

test('path id ekstrem pada rute dosing/preset/target/naik-harian → 4xx', { skip: lewati }, async () => {
  for (const v of BESAR) {
    harus4xx(await kirim('put', `/dosing/preset/${v}`, { keterangan: 'uji-3f' }), `PUT preset/${v}`);
    harus4xx(await kirim('delete', `/dosing/preset/${v}`), `DELETE preset/${v}`);
    harus4xx(await kirim('put', `/dosing/target/${v}`, { mode: 'otomatis' }), `PUT target/${v}`);
    harus4xx(await kirim('put', `/dosing/naik-harian/${v}`, { ppm_awal: 100, ppm_target: 200, hari_capai: 10 }), `PUT naik-harian/${v}`);
  }
});

test('rute siklus/penugasan/preset versi dengan id ekstrem → 4xx', { skip: lewati }, async () => {
  const target = { ec_min_ppm: 400, ec_max_ppm: 600, ph_min: 5.8, ph_max: 6.5 };
  for (const v of [1e20, ...BESAR]) {
    harus4xx(await kirim('post', '/api/siklus', { id_tanaman: v, id_meja: 1, mode_target: 'MANUAL', ph_aktual: 6, tds_aktual_ppm: 450, jumlah_benih: 5, target }), `siklus id_tanaman=${v}`);
    harus4xx(await kirim('post', '/api/siklus', { id_tanaman: 1, id_meja: v, mode_target: 'MANUAL', ph_aktual: 6, tds_aktual_ppm: 450, jumlah_benih: 5, target }), `siklus id_meja=${v}`);
    harus4xx(await kirim('post', '/api/penugasan', { id_user: v, id_meja: 1 }), `penugasan id_user=${v}`);
    harus4xx(await kirim('post', '/api/penugasan', { id_user: 1, id_meja: v }), `penugasan id_meja=${v}`);
  }
  for (const v of BESAR) {
    harus4xx(await kirim('post', `/api/siklus/${v}/transisi`, { ke: 'CANCELLED', alasan: 'uji ekstrem' }), `transisi ${v}`);
    harus4xx(await kirim('post', `/api/konfirmasi/${v}/jawab`, { jawaban: 'SIAP' }), `konfirmasi ${v}`);
    harus4xx(await kirim('post', `/api/lot/${v}/selesai`, { berhasil: 1, gagal: 0 }), `lot ${v}`);
    harus4xx(await kirim('post', `/api/preset/${v}/versi`, { parameter: {}, catatan: 'uji' }), `preset versi ${v}`);
    harus4xx(await kirim('post', `/api/dosing/siklus/${v}/setujui`, { cakupan: {} }), `dosing setujui ${v}`);
    harus4xx(await kirim('post', `/api/penampung/${v}/buka-kunci`, {}), `buka-kunci ${v}`);
  }
});
