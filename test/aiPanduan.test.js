'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const guard = require('../src/aiGuard');
const { deteksiPanduan, jawabPanduan, apakahMintaSaran, TEKS } = require('../src/aiPanduan');

const kunci = (t) => deteksiPanduan(guard.normalisasi(t));

test('pertanyaan umum dikenali ke topik yang benar', () => {
  assert.equal(kunci('Bagaimana cara menyemai?'), 'semai');
  assert.equal(kunci('gimana mulai semai baru'), 'semai');
  assert.equal(kunci('cara pindah tahap tanaman'), 'pindah_tahap');
  assert.equal(kunci('bagaimana cara mencatat panen'), 'panen');
  assert.equal(kunci('alat baru belum ada, apa yang harus disiapkan'), 'alat_baru');
  assert.equal(kunci('cara menghubungkan sensor lewat mqtt'), 'alat_baru');
  assert.equal(kunci('jelaskan alur aplikasi ini'), 'alur');
  assert.equal(kunci('ini sudah sampai fase berapa?'), 'fase');
  assert.equal(kunci('apa saja keputusan yang belum diputuskan'), 'keputusan');
  assert.equal(kunci('kenapa dosing otomatis belum jalan'), 'dosing');
});

test('pertanyaan kondisi kebun tidak dibajak panduan', () => {
  assert.equal(kunci('berapa pH sekarang'), null);
  assert.equal(kunci('tds terlalu tinggi, apa yang harus dilakukan'), null);
  assert.equal(kunci('tabel alert terbuka'), null);
});

test('permintaan saran diarahkan ke diagnosa data nyata', () => {
  assert.equal(apakahMintaSaran(guard.normalisasi('Beri saran untuk kebun saya')), true);
  assert.equal(apakahMintaSaran(guard.normalisasi('apa yang harus saya lakukan hari ini')), true);
  assert.equal(apakahMintaSaran(guard.normalisasi('berapa suhu air')), false);
});

test('pagar topik menerima pertanyaan panduan, tetap menolak di luar bidang', () => {
  for (const t of ['Bagaimana alur aplikasi?', 'Sudah sampai fase berapa?', 'Apa keputusan yang menunggu?', 'cara menyemai']) {
    assert.equal(guard.periksaPesan(t).ok, true, t);
  }
  assert.equal(guard.periksaPesan('siapa presiden indonesia').ok, false);
});

test('jawaban tidak memuat angka keselamatan karangan dan tetap jujur soal dosing', () => {
  const semua = Object.values(TEKS).join('\n');
  assert.doesNotMatch(semua, /\b\d+\s?(?:ml|mL|ppm|L\/menit)\b/);
  assert.match(TEKS.dosing, /dikunci/);
  assert.match(TEKS.dosing, /tidak menyalakan pompa/);
  assert.match(TEKS.fase, /belum siap dosing fisik/i);
  assert.equal(jawabPanduan('tidak-ada'), null);
});

test('petunjuk semai menyebut batas peran saat ini', () => {
  assert.match(TEKS.semai, /hanya admin/);
  assert.match(TEKS.semai, /Mulai Semai Baru/);
});

const { tautanUntuk, PATH_SAH, TAUTAN_TOPIK, HALAMAN } = require('../src/aiPanduan');

test('tautan: petani tidak ditawari halaman admin, admin dapat semuanya', () => {
  const petani = tautanUntuk('semai', 'petani');
  assert.deepEqual(petani.map((t) => t.to), ['/tanam']);
  const admin = tautanUntuk('semai', 'admin');
  assert.deepEqual(admin.map((t) => t.to), ['/tanam', '/semai', '/tanaman']);
  assert.deepEqual(tautanUntuk('semai', 'demo').map((t) => t.to), admin.map((t) => t.to));
  assert.deepEqual(tautanUntuk('semai', '').map((t) => t.to), ['/tanam']);
});

test('tautan: topik tanpa halaman tetap kosong, topik tak dikenal aman', () => {
  assert.deepEqual(tautanUntuk('fase', 'admin'), []);
  assert.deepEqual(tautanUntuk('keputusan', 'admin'), []);
  assert.deepEqual(tautanUntuk('tidak-ada', 'admin'), []);
});

test('tautan: hanya jalur internal tetap yang sah (tanpa host, tanpa query)', () => {
  for (const h of Object.values(HALAMAN)) assert.match(h.to, /^\/[a-z0-9-]+$/);
  for (const [topik, daftar] of Object.entries(TAUTAN_TOPIK)) {
    for (const k of daftar) assert.ok(HALAMAN[k], `${topik} → ${k} tidak ada di HALAMAN`);
    for (const t of tautanUntuk(topik, 'admin')) assert.ok(PATH_SAH.has(t.to));
  }
});

test('topik baru: logbook, tim, saklar, nutrisi manual, uji lab terdeteksi; daftar tim memuat 7 anggota', () => {
  const { deteksiPanduan, TEKS } = require('../src/aiPanduan');
  assert.equal(deteksiPanduan('tolong tampilkan logbook'), 'logbook');
  assert.equal(deteksiPanduan('siapa saja anggota tim'), 'tim');
  assert.equal(deteksiPanduan('bio data anggota'), 'tim');
  assert.equal(deteksiPanduan('cara pakai saklar'), 'saklar');
  assert.equal(deteksiPanduan('gimana nutrisi manual'), 'nutrisi_manual');
  assert.equal(deteksiPanduan('catat hasil uji lab'), 'uji_lab');
  assert.equal(deteksiPanduan('cara menyemai melon'), 'semai');
  assert.equal(TEKS.tim.split('\n').filter((l) => l.startsWith('•')).length, 7);
  assert.match(TEKS.semai, /Persiapan/);
});
