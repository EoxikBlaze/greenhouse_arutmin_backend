'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buatPemecah, alirkanKalimat } = require('../src/aiStreamKalimat');
const guard = require('../src/aiGuard');

test('pemecah: kalimat utuh dilepas, potongan menggantung ditahan', () => {
  const p = buatPemecah();
  assert.deepEqual(p.tambah('pH air 6,1 masih'), []);
  assert.deepEqual(p.tambah(' aman. Suhu air 26'), ['pH air 6,1 masih aman.']);
  assert.deepEqual(p.tambah(',4 °C.\nTDS 980'), ['Suhu air 26,4 °C.']);
  assert.equal(p.sisa(), 'TDS 980');
});

test('pemecah: angka desimal bertitik tidak dipotong di tengah', () => {
  const p = buatPemecah();
  assert.deepEqual(p.tambah('Target pH 5.8 sampai 6.5 untuk melon. '), ['Target pH 5.8 sampai 6.5 untuk melon.']);
});

const dariPotongan = (arr) => (async function* () { for (const a of arr) yield a; })();

test('alirkanKalimat: kalimat aman diteruskan, teks lengkap dikembalikan', async () => {
  const keluar = [];
  const penuh = await alirkanKalimat(dariPotongan(['Daun kuning ', 'biasanya kurang nutrisi. ', 'Cek TDS.']), (k) => keluar.push(k));
  assert.deepEqual(keluar, ['Daun kuning biasanya kurang nutrisi.', 'Cek TDS.']);
  assert.equal(penuh, 'Daun kuning biasanya kurang nutrisi. Cek TDS.');
});

test('alirkanKalimat: berhenti meneruskan begitu ada kebocoran kode internal atau kode program', async () => {
  const keluar = [];
  await alirkanKalimat(dariPotongan(['Kalimat aman. ', `Kode ${guard.CANARY}. `, 'Ini tidak boleh tampil.']), (k) => keluar.push(k));
  assert.deepEqual(keluar, ['Kalimat aman.']);
  const k2 = [];
  await alirkanKalimat(dariPotongan(['Coba ini. ', 'print(1) dulu. ', 'Lalu cek.']), (k) => k2.push(k));
  assert.deepEqual(k2, ['Coba ini.']);
});

test('alirkanKalimat: baris tabel markdown tidak dialirkan (tabel dikirim di jawaban akhir)', async () => {
  const keluar = [];
  await alirkanKalimat(dariPotongan(['Ringkasan:\n', '| a | b |\n', 'Selesai.']), (k) => keluar.push(k));
  assert.deepEqual(keluar, ['Ringkasan:', 'Selesai.']);
});

const { potongKeKalimatUtuh } = require('../src/aiStreamKalimat');

test('potongKeKalimatUtuh: ekor yang terpotong batas token dibuang', () => {
  assert.equal(potongKeKalimatUtuh('TDS 980 masih aman. Namun, jika melon sudah berbuah Anda bisa'), 'TDS 980 masih aman.');
  assert.equal(potongKeKalimatUtuh('pH 6.1 aman.'), 'pH 6.1 aman.');
  assert.equal(potongKeKalimatUtuh('tanpa titik sama sekali'), 'tanpa titik sama sekali');
});

test('alirkanKalimat: ekor tanpa tanda akhir kalimat tidak dialirkan', async () => {
  const keluar = [];
  await alirkanKalimat(dariPotongan(['TDS aman. ', 'Namun Anda bisa']), (k) => keluar.push(k));
  assert.deepEqual(keluar, ['TDS aman.']);
});
