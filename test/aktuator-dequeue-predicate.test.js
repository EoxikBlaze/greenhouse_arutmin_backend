'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { test } = require('node:test');

const calls = [];
const dbPalsu = {
  pool: {},
  one: async () => null,
  async q(sql, params) {
    calls.push({ sql, params });
    if (sql.includes("SET status = 'dikirim'")) {
      return [{ id: 7, tipe: 'STOP', parameter: {}, kedaluwarsa_pada: '2099-01-01T00:00:00Z' }];
    }
    return [];
  },
};

const targetAktuator = path.join(__dirname, '..', 'src', 'aktuator.js');
const loadAsli = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === './db' && parent?.filename === targetAktuator) return dbPalsu;
  return loadAsli.call(this, request, parent, isMain);
};
let aktuator;
try {
  aktuator = require('../src/aktuator');
} finally {
  Module._load = loadAsli;
}

test('ambilPerintah menjalankan cleanup dan dequeue dengan allowlist tanpa DOSIS; STOP tetap keluar', async () => {
  calls.length = 0;
  const rows = await aktuator.ambilPerintah('aktuator-01', 3);

  assert.equal(calls.length, 3);
  assert.match(calls[0].sql, /SET status = 'kedaluwarsa'/);
  assert.match(calls[0].sql, /tipe = ANY\(\$2::text\[\]\)/);
  assert.deepEqual(calls[0].params, ['aktuator-01', aktuator.TIPE_DIKIRIM]);

  assert.match(calls[1].sql, /status = 'dikirim'.*interval '90 seconds'/s);
  assert.deepEqual(calls[1].params, ['aktuator-01']);

  assert.match(calls[2].sql, /SET status = 'dikirim'/);
  assert.match(calls[2].sql, /status = 'menunggu' AND tipe = ANY\(\$3::text\[\]\)/);
  assert.match(calls[2].sql, /kedaluwarsa_pada > now\(\)/);
  assert.deepEqual(calls[2].params, ['aktuator-01', 3, aktuator.TIPE_DIKIRIM]);
  assert.equal(aktuator.TIPE_DIKIRIM.includes('DOSIS'), false);
  assert.deepEqual(rows.map((row) => row.tipe), ['STOP']);
});
