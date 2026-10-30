'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { periksa } = require('./integration/_isolasi');

test('pagar isolasi DB uji: butuh nama garap_uji* DAN host loopback', () => {
  const u = (s) => periksa({ DATABASE_URL: s }).lewati;
  assert.equal(u('postgres://x:y@127.0.0.1:5432/garap_uji_3a'), false);
  assert.equal(u('postgres://x:y@localhost/garap_uji_kosong'), false);
  assert.equal(u('postgres://x:y@[::1]:5432/garap_uji_3f'), false);
  assert.match(u('postgres://x:y@127.0.0.1:5432/vertonik_smartfarm'), /hanya untuk DB uji/);
  assert.match(u('postgres://x:y@192.168.1.50:5432/garap_uji_3a'), /bukan loopback/, 'nama garap_uji* di host lain (mis. Pi) ditolak');
  assert.match(u('postgres://x:y@raspberry-pi.local:5432/garap_uji_3a'), /bukan loopback/);
  assert.match(u(''), /tidak diisi/);
  assert.match(u('bukan url'), /tidak diisi atau tidak sah/);
});
