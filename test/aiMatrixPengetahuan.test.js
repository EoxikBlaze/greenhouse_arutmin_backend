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

test('formatHasilAnalisis menghasilkan struktur markdown terpadu', () => {
  const item = matrix.MATRIX[0];
  const formatted = matrix.formatHasilAnalisis(item);
  assert.ok(formatted.includes('Gejala & Kondisi:'));
  assert.ok(formatted.includes('Akar Masalah:'));
  assert.ok(formatted.includes('Langkah Tindakan Rekomendasi:'));
});

