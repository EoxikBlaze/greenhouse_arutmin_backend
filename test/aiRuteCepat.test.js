'use strict';
// Uji 15 Nov 2026: dua pertanyaan umum jatuh ke LLM (12–22 dtk, satu dijawab salah)
// padahal jawabannya sudah ada di jalur data / panduan tetap.
const test = require('node:test');
const assert = require('node:assert/strict');
const guard = require('../src/aiGuard');
const diag = require('../src/aiDiagnosa');
const { deteksiPanduan, jawabPanduan } = require('../src/aiPanduan');

const niat = (s) => diag.deteksiNiat(guard.normalisasi(s));
const kunci = (s) => deteksiPanduan(guard.normalisasi(s));

test('kondisi sensor umum → jalur data sensor (bukan LLM)', () => {
  assert.equal(niat('Bagaimana kondisi sensor sekarang?'), 'sensor');
  assert.equal(niat('status sensor saat ini gimana'), 'sensor');
  assert.equal(niat('cek bacaan sensor terkini'), 'sensor');
  assert.equal(niat('sensor hari ini bagaimana?'), 'sensor');
});

test('pertanyaan pH tunggal tetap ke LLM (kontrak lama tidak berubah)', () => {
  assert.equal(niat('Bagaimana kondisi pH sekarang?'), null);
});

test('jumlah cabang melon → panduan pemangkasan yang menyebut jumlah cabang', () => {
  assert.equal(kunci('Berapa cabang melon yang dipelihara per tanaman?'), 'polinasi_melon');
  assert.equal(kunci('cabang melon disisakan berapa?'), 'polinasi_melon');
  assert.match(jawabPanduan('polinasi_melon').jawaban, /1 batang utama/);
});
