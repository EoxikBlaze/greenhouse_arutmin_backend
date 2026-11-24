'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const matrix = require('../src/aiMatrixPengetahuan');

test('matriks pengetahuan memuat 20+ kategori analisis mendalam', () => {
  assert.ok(matrix.MATRIX.length >= 20);
});

test('cariAnalisisCepat mengenali defisiensi magnesium dan zat besi secara instan (<2ms)', () => {
  const t0 = performance.now();
  const mg = matrix.cariAnalisisCepat('tanaman saya kekurangan magnesium');
  const durasiMg = performance.now() - t0;
  assert.ok(mg);
  assert.equal(mg.id, 'defisiensi_magnesium');
  assert.ok(durasiMg < 5, `Pencarian harus di bawah 5ms, didapat: ${durasiMg}ms`);

  const fe = matrix.cariAnalisisCepat('daun muda kuning pucat tulang hijau');
  assert.ok(fe);
  assert.equal(fe.id, 'defisiensi_zat_besi');
});

test('cariAnalisisCepat mengenali hama thrips dan jamur powdery mildew', () => {
  const thrips = matrix.cariAnalisisCepat('daun keriting ke bawah ada garis perak');
  assert.ok(thrips);
  assert.equal(thrips.id, 'hama_thrips');

  const jamur = matrix.cariAnalisisCepat('daun putih seperti bedak');
  assert.ok(jamur);
  assert.equal(jamur.id, 'penyakit_powdery_mildew');
});

test('formatHasilAnalisis menghasilkan struktur bersih tanpa bintang markdown', () => {
  const item = matrix.MATRIX[0];
  const formatted = matrix.formatHasilAnalisis(item);
  assert.ok(formatted.includes('Gejala & Kondisi:'));
  assert.ok(formatted.includes('Akar Masalah:'));
  assert.ok(formatted.includes('Langkah Tindakan Rekomendasi:'));
  assert.ok(!formatted.includes('**'), 'jangan kirim ** markdown mentah ke UI');
});

test('cariAnalisisCepat mengenali keluhan melon umum (bintik putih+menggulung, iklim ideal, manis/brix, sanitasi tandon)', () => {
  assert.equal(matrix.cariAnalisisCepat('kenapa daun melon berbintik putih dan menggulung ke atas?')?.id, 'daun_bintik_putih_menggulung');
  assert.equal(matrix.cariAnalisisCepat('berapa suhu dan kelembapan ideal untuk melon?')?.id, 'iklim_ideal_melon');
  assert.equal(matrix.cariAnalisisCepat('melon manis atau brix tinggi itu gimana caranya?')?.id, 'melon_manis_brix');
  assert.equal(matrix.cariAnalisisCepat('air tandon keruh dan berlumut cara bersihinnya gimana?')?.id, 'sanitasi_tandon_lumut');
  assert.equal(matrix.cariAnalisisCepat('bedanya ppm dan ec apa ya?')?.id, 'perbedaan_ppm_ec');
  assert.equal(matrix.cariAnalisisCepat('kenapa bibit melon mengambang saat direndam air bawang merah?')?.id, 'semai_bawang_merah_kain_hitam');
  assert.equal(matrix.cariAnalisisCepat('kenapa bibit melon mengambang saat direndam?')?.id, 'semai_bawang_merah_kain_hitam');
  assert.equal(matrix.cariAnalisisCepat('rekomendasi varietas melon inthanon atau golden aroma')?.id, 'varietas_unggul_melon');
  assert.equal(matrix.cariAnalisisCepat('bagaimana jadwal tanam melon dari awal hst sampai panen?')?.id, 'jadwal_hst_lengkap_melon');
  assert.equal(matrix.cariAnalisisCepat('cara meracik pekatan a dan pekatan b ab mix agar tidak ada endapan')?.id, 'racik_stok_ab_mix_melon');
  assert.equal(matrix.cariAnalisisCepat('cara sterilisasi media tanam cocopeat dan sekam bakar untuk melon')?.id, 'media_tanam_hidroponik_melon');
  assert.equal(matrix.cariAnalisisCepat('cara pruning pewiwilan tunas air dan topping pucuk melon')?.id, 'pruning_pewiwilan_topping_melon');
  assert.equal(matrix.cariAnalisisCepat('apa ciri buah melon sudah matang siap panen?')?.id, 'ciri_matang_dan_panen_melon');
  assert.equal(matrix.cariAnalisisCepat('tanaman melon kena layu fusarium atau layu bakteri')?.id, 'penyakit_layu_fusarium_bakteri');
  assert.equal(matrix.cariAnalisisCepat('daun melon kena virus gemini kuning keriting')?.id, 'penyakit_virus_gemini_kuning');
  assert.equal(matrix.cariAnalisisCepat('cara mengatasi lalat buah dan ulat daun di kebun melon')?.id, 'hama_ulat_lalat_buah_kumbang');
  assert.equal(matrix.cariAnalisisCepat('standar air baku sumur dan oksigen terlarut untuk hidroponik melon')?.id, 'kualitas_air_baku_dan_oksigen');
  assert.equal(matrix.cariAnalisisCepat('sop sterilisasi greenhouse sebelum tanam baru')?.id, 'persiapan_greenhouse_sterilisasi');
});

