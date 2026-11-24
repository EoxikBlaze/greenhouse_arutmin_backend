'use strict';
/**
 * Pagar keselamatan: kode AI hanya boleh MEMBACA. Uji ini gagal bila ada berkas AI yang
 * memuat modul aktuator/MQTT/gerbang dosis, mempublikasikan MQTT, atau menulis ke database.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const berkasAi = [
  ...fs.readdirSync(SRC).filter((f) => /^ai.*\.js$/.test(f)).map((f) => path.join(SRC, f)),
  ...fs.readdirSync(path.join(SRC, 'routes')).filter((f) => /^ai.*\.js$/.test(f)).map((f) => path.join(SRC, 'routes', f)),
];

const MODUL_TERLARANG = /require\(\s*['"][./]*\/?(mqttJembatan|gerbangDosis|aktuator|dosingSiklus|saklar|kontrolAir|kunci|presetDosing|iotV41|routes\/(aktuator|dosing|saklar|watercontrol|iotV41))['"]\s*\)|require\(\s*['"]mqtt['"]\s*\)/;
const TULIS_SQL = /\b(INSERT\s+INTO|UPDATE\s+[\w."]+\s+SET|DELETE\s+FROM|TRUNCATE|ALTER\s+TABLE|DROP\s+TABLE)\b/;
const PUBLISH = /\.publish\s*\(/;

test('ada berkas AI yang diperiksa', () => {
  assert.ok(berkasAi.length >= 8);
});

for (const berkas of berkasAi) {
  const nama = path.relative(SRC, berkas);
  const isi = fs.readFileSync(berkas, 'utf8');
  test(`${nama}: tidak memuat modul aktuator/MQTT/gerbang dosis`, () => {
    assert.equal(MODUL_TERLARANG.exec(isi)?.[0], undefined);
  });
  test(`${nama}: tidak mempublikasikan MQTT`, () => {
    assert.equal(PUBLISH.test(isi), false);
  });
  test(`${nama}: tidak menulis ke database`, () => {
    assert.equal(TULIS_SQL.exec(isi)?.[0], undefined);
  });
}

test('EKSEKUSI_DIIZINKAN tetap false', () => {
  assert.equal(require('../src/gerbangDosis').EKSEKUSI_DIIZINKAN, false);
});
