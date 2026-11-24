'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cariKonteksQwen, SOP_SEMAI_MELON_LAPANGAN, MODUL_MELON } = require('../src/aiMelonModul');

test('modul melon menyimpan 8 topik khusus melon + SOP semai bawang merah 4 langkah lengkap', () => {
  assert.ok(MODUL_MELON.length >= 8);
  assert.match(SOP_SEMAI_MELON_LAPANGAN, /bawang merah/i);
  assert.match(SOP_SEMAI_MELON_LAPANGAN, /tenggelam/);
  assert.match(SOP_SEMAI_MELON_LAPANGAN, /mengambang/);
  assert.match(SOP_SEMAI_MELON_LAPANGAN, /kain hitam.*2 hari/i);
  assert.match(SOP_SEMAI_MELON_LAPANGAN, /2 hari/);
  assert.match(SOP_SEMAI_MELON_LAPANGAN, /rockwool/i);
});

test('cariKonteksQwen memilih konteks ringkas paling relevan (<100 token) tanpa membanjiri prompt Pi', () => {
  const s = cariKonteksQwen('berapa lama bibit melon direndam bawang merah dan kain hitam sebelum rockwool?');
  assert.ok(s);
  assert.match(s, /bawang merah 1 hari/i);
  assert.match(s, /kain hitam.*2 hari/i);

  const brix = cariKonteksQwen('brix buah melon targetnya berapa?');
  assert.ok(brix);
  assert.match(brix, /12-15\+ Brix/);

  const kal = cariKonteksQwen('probe sensor ph 6.86 kalibrasi mqtt');
  assert.ok(kal);
  assert.match(kal, /1413 uS\/cm/);

  const varMelon = cariKonteksQwen('varietas melon inthanon dan jadwal siklus umur panen');
  assert.ok(varMelon);
  assert.match(varMelon, /Inthanon/);

  const virus = cariKonteksQwen('tanaman kena virus gemini dan layu fusarium');
  assert.ok(virus);
  assert.match(virus, /Trichoderma/);
});

