'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { saringKeluaran } = require('../src/aiGuard');
const { alirkanKalimat } = require('../src/aiStreamKalimat');

test('klaim AI sudah menjalankan alat dibuang dari jawaban', () => {
  for (const klaim of [
    'Pompa pH down sudah saya nyalakan 200 ml.',
    'Saya telah menjalankan dosing AB Mix untuk Anda.',
    'Saya akan menyalakan pompa nutrisi sekarang.',
    'Kami sudah menambahkan pH Up ke penampung.',
  ]) {
    const s = saringKeluaran(`${klaim} pH 6.0 sudah ideal.`);
    assert.equal(s.teks, 'pH 6.0 sudah ideal.', klaim);
    assert.equal(saringKeluaran(klaim).teks, '', klaim);
  }
});

test('saran atau syarat soal pompa tetap lolos', () => {
  for (const t of [
    'Pastikan pompa sudah dinyalakan sebelum mengukur TDS.',
    'Ajukan dosing AB Mix lewat menu persetujuan.',
    'Saya sarankan menambah AB Mix lewat alur persetujuan dosing.',
  ]) assert.equal(saringKeluaran(t).teks, t);
});

test('gema aturan prompt diblokir sebagai kebocoran', () => {
  assert.equal(saringKeluaran('ATURAN KERAS: 1. Jawab 100% Bahasa Indonesia natural.').bocor, true);
  assert.equal(saringKeluaran('Aturan saya: dilarang kode/tautan/gambar atau mengaku menyalakan pompa.').bocor, true);
  assert.equal(saringKeluaran('Aturan pemupukan melon: AB Mix 1200 ppm.').bocor, false);
});

test('streaming tidak meneruskan kalimat klaim aksi', async () => {
  const dapat = [];
  async function* p() { yield 'Pompa sudah saya nyalakan. '; yield 'pH 6.0 sudah ideal. '; }
  await alirkanKalimat(p(), (k) => dapat.push(k));
  assert.deepEqual(dapat, ['pH 6.0 sudah ideal.']);
});
