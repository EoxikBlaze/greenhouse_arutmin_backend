'use strict';
/**
 * Unit test PERTAMA proyek ini (node:test — built-in, tanpa dependensi baru).
 * Fokus: idValidValue, helper validasi :id yang kini dipakai bersama oleh
 * routes/_crud.js, tahap.js, tanam.js, user.js (lihat src/routes/_id.js).
 *
 * Jalankan: npm test — script memakai glob ke dalam folder test/
 * (perintah `node --test test/` dengan argumen direktori tidak didukung di Node 26).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { BIGINT_MAX, idValid, idValidValue, notFound } = require('../src/routes/_id');

test('BIGINT_MAX = batas int8 Postgres', () => {
  assert.equal(BIGINT_MAX, 9223372036854775807n);
});

test('idValidValue — kasus wajib', () => {
  const cases = [
    ['1', true],
    ['007', true],                        // nol depan tetap diterima (bukan {1,19})
    ['abc', false],
    ['', false],
    ['9223372036854775807', true],        // tepat batas
    ['9223372036854775808', false],       // satu di atas batas → 404, bukan 500
    ['99999999999999999999999', false],   // lolos regex; BigInt besar, lalu > BIGINT_MAX → false
    ['-1', false],
    ['1e5', false],                       // notasi ilmiah bukan digit murni
    [' 1', false],                        // spasi
    ['1 ', false],
  ];
  for (const [input, expected] of cases) {
    assert.equal(idValidValue(input), expected, `idValidValue(${JSON.stringify(input)})`);
  }
});

test('idValid — membaca req.params.id', () => {
  assert.equal(idValid({ params: { id: '42' } }), true);
  assert.equal(idValid({ params: { id: 'abc' } }), false);
  assert.equal(idValid({ params: { id: '9223372036854775808' } }), false);
});

test('notFound — 404 dengan body kontrak {message, errors:{}}', () => {
  const calls = [];
  const res = {
    status(code) { calls.push(['status', code]); return this; },
    json(body) { calls.push(['json', body]); return this; },
  };
  const ret = notFound(res);
  assert.deepEqual(calls, [
    ['status', 404],
    ['json', { message: 'Data tidak ditemukan.', errors: {} }],
  ]);
  assert.equal(ret, res); // tetap chainable seperti aslinya
});
