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
