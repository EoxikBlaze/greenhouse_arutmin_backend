'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const trio = require('../src/aiTrioKolaborasi');

test('agenSensor mengevaluasi kondisi pH dan TDS dengan status yang tepat', async () => {
  const sensor = { ph: 5.2, tds: 1500, waterTemp: 26.5 };
  const ambang = { ph: { min: 5.8, max: 6.5 }, tds: { min: 1000, max: 1800 } };
  const res = await trio.agenSensor(sensor, ambang, 'Cek kondisi air');
  
  assert.ok(res.ringkasan.includes('5.2'));
  assert.ok(res.ringkasan.includes('terlalu asam'));
  assert.ok(res.ringkasan.includes('1500'));
  assert.ok(res.status === 'OK' || res.status === 'FALLBACK');
});

test('agenSensor mendeteksi suhu air tandon panas (>29°C)', async () => {
  const sensor = { ph: 6.2, tds: 1200, waterTemp: 31.0 };
  const ambang = { ph: { min: 5.8, max: 6.5 }, tds: { min: 1000, max: 1800 } };
  const res = await trio.agenSensor(sensor, ambang, 'Apakah air aman?');
  
  assert.ok(res.ringkasan.includes('panas'));
});

test('agenSintesis menggabungkan ulasan sensor dan agronomi ke format terpadu 3-pilar', async () => {
  const sensorRes = {
    ringkasan: 'Sensor: pH 6.0 (normal), TDS 1400 (normal), Suhu 26°C.',
    ulasan: 'Kondisi fisik tandon terpantau optimal.',
  };
  const agroRes = {
    jawaban: 'Fase melon pembesaran buah membutuhkan nutrisi stabil dan tali ajir kokoh.',
  };
  const hasil = await trio.agenSintesis('Bagaimana kondisi kebun?', sensorRes, agroRes);

  assert.match(hasil, /Kolaborasi 3 AI Smart Farm GARAP/);
  assert.match(hasil, /Kondisi Sensor & Lingkungan/);
  assert.match(hasil, /Tinjauan Botani & Agronomi/);
  assert.ok(hasil.includes('pH 6.0'));
  assert.ok(hasil.includes('pembesaran buah'));
});
