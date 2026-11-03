'use strict';
/**
 * Bukti migrasi koreksi aman v4.1 (2026-11-03_01): saklar izin bawaan MATI, bentrok GPIO ditandai,
 * parameter baru belum tervalidasi. HANYA DB uji (garap_uji*, loopback).
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { q, pool } = require('../../src/db');
const { lewati } = require('./_isolasi');

after(async () => { await pool.end(); });

test('v4.1 koreksi: semua saklar izin dan mode isi otomatis bernilai 0', { skip: lewati }, async () => {
  const r = await q(`SELECT param, nilai::float AS nilai FROM konfigurasi_dosis
                      WHERE param IN ('saklar_ab','saklar_ph_up','saklar_ph_down','saklar_pengenceran','mode_isi_otomatis')`);
  assert.equal(r.length, 5);
  for (const x of r) assert.equal(x.nilai, 0, x.param);
});

test('v4.1 koreksi: parameter v4.1 tidak ditandai tervalidasi', { skip: lewati }, async () => {
  const r = await q(`SELECT param, tervalidasi FROM konfigurasi_dosis
                      WHERE sumber LIKE 'Perancangan v4.1%' AND tervalidasi IS TRUE`);
  assert.deepEqual(r, []);
});

test('v4.1 koreksi: bentrok GPIO dengan firmware v0.2 tertulis di pemetaan, dan migrasi idempoten', { skip: lewati }, async () => {
  const r = await q("SELECT kode, keterangan FROM mapping_channel_esp32 WHERE kode IN ('V2-FLOAT-2','V2-RELAY-5') ORDER BY kode");
  assert.equal(r.length, 2);
  for (const x of r) {
    assert.match(x.keterangan, /PERINGATAN 3 Nov 2026/);
    assert.equal(x.keterangan.match(/PERINGATAN 3 Nov 2026/g).length, 1); // tidak berlipat saat dijalankan ulang
  }
});

test('v4.1 koreksi: tidak ada perintah DOSIS di antrean', { skip: lewati }, async () => {
  assert.equal((await q("SELECT count(*)::int AS n FROM perintah_aktuator WHERE tipe = 'DOSIS'"))[0].n, 0);
});
