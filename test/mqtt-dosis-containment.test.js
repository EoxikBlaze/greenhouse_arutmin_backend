'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { terbitkanPerintah } = require('../src/mqttJembatan');
const { TIPE_DIKIRIM } = require('../src/aktuator');

const root = path.resolve(__dirname, '..');

function mockClient() {
  const diterbitkan = [];
  return {
    diterbitkan,
    publish(...args) { diterbitkan.push(args); },
  };
}

test('DOSIS legacy selalu ditahan pada batas publisher tanpa mencatat payload', () => {
  const client = mockClient();
  const warnings = [];
  const log = { warn: (...args) => warnings.push(args) };
  const fixtures = [
    { id: 1, tipe: 'DOSIS', parameter: { ml: 20 } },
    { id: 2, tipe: ' dosis ', status: 'dikirim', parameter: { ml: 20 } },
    { id: 3, tipe: 'DOSIS', status: 'menunggu', siklus_id: 4, percobaan_id: 5, kedaluwarsa_pada: '2099-01-01' },
    { id: 4, tipe: 'DOSIS', status: 'selesai', parameter: { secret: 'sensitive' } },
  ];

  terbitkanPerintah(client, 'aktuator-01', fixtures, log);

  assert.deepEqual(client.diterbitkan, []);
  assert.ok(warnings.length > 0);
  assert.equal(JSON.stringify(warnings).includes('sensitive'), false);
});

test('daftar-izin: varian DOSIS (tab, newline, NBSP, Unicode, huruf kecil) dan tipe tak dikenal ditahan di publisher', () => {
  const client = mockClient();
  const log = { warn() {} };
  const varian = ['DOSIS\t', 'DOSIS\n', '\u00a0DOSIS', 'DOS\u0130S', 'dosis', 'Dosis', ' DOSIS', 'DOSIS ', 'DOSIS\u200b', 'FOO', '', null, undefined, 42, 'stop', ' STOP'];
  terbitkanPerintah(client, 'aktuator-01', varian.map((tipe, i) => ({ id: i + 1, tipe, parameter: { ml: 1 } })), log);
  assert.deepEqual(client.diterbitkan, []);
});

test('STOP, E-STOP, dan perintah non-DOSIS mempertahankan payload publisher', () => {
  const client = mockClient();
  const rows = ['STOP', 'STOP_DARURAT', 'BILAS', 'SAMPLING', 'ISI_AIR'].map((tipe, i) => ({
    id: i + 1, tipe, parameter: { n: i },
  }));

  terbitkanPerintah(client, 'aktuator-01', rows, { warn() {} });

  assert.deepEqual(client.diterbitkan.map(([topic, payload, options]) => [topic, JSON.parse(payload), options]),
    rows.map((p) => [`garap/aktuator-01/perintah`, { id: p.id, tipe: p.tipe, parameter: p.parameter }, { qos: 1 }]));
});

test('dequeue mengecualikan DOSIS sebelum status antrean diubah dan mempertahankan STOP', () => {
  const src = fs.readFileSync(path.join(root, 'src/aktuator.js'), 'utf8');
  const cleanup = src.slice(src.indexOf('async function rapikanAntrean'), src.indexOf('/** Ambil perintah'));
  assert.match(cleanup, /status = 'kedaluwarsa'[\s\S]*?status = 'menunggu' AND tipe = ANY\(\$2::text\[\]\)/,
    'hanya tipe pada daftar izin yang diubah statusnya oleh cleanup expiry (DOSIS menunggu tidak)');
  const dequeue = src.slice(src.indexOf('async function ambilPerintah'), src.indexOf('/** Laporan hasil'));
  assert.match(dequeue, /status = 'menunggu' AND tipe = ANY\(\$3::text\[\]\) AND kedaluwarsa_pada > now\(\)/);
  assert.ok(!TIPE_DIKIRIM.includes('DOSIS') && TIPE_DIKIRIM.includes('STOP') && TIPE_DIKIRIM.includes('STOP_DARURAT'));
  assert.match(dequeue, /ORDER BY \(tipe = 'STOP_DARURAT'\) DESC, \(tipe = 'STOP'\) DESC/);
  const lock = src.slice(src.indexOf('async function kunciPenampung'), src.indexOf('async function bukaKunci'));
  assert.match(lock, /SET status_lock = true/);
  assert.match(lock, /tipe = 'DOSIS'/, 'alur LOCK tetap membatalkan DOSIS menunggu');
  const estop = fs.readFileSync(path.join(root, 'src/routes/aktuator.js'), 'utf8');
  assert.match(estop, /tipe: 'STOP_DARURAT'/, 'route E-STOP tetap memasukkan perintah prioritas');
});

test('hanya satu batas publish perintah MQTT dan gerbang dosing tetap tertutup', () => {
  const src = fs.readFileSync(path.join(root, 'src/mqttJembatan.js'), 'utf8');
  const helper = src.slice(src.indexOf('function terbitkanPerintah'), src.indexOf('/** Perangkat + apakah'));
  const caller = src.slice(src.indexOf('async function kirimPerintah'), src.indexOf('async function terima'));
  assert.equal((src.match(/\.publish\([^\n]*\/perintah/g) || []).length, 1, 'hanya helper yang boleh menerbitkan perintah');
  assert.match(helper, /terbitkanPerintah/);
  assert.match(caller, /terbitkanPerintah\(client, kode, list, log\)/);
  assert.equal((src.match(/terbitkanPerintah\(/g) || []).length, 2, 'satu definisi helper dan satu pemanggilan');
  assert.match(fs.readFileSync(path.join(root, 'src/gerbangDosis.js'), 'utf8'), /EKSEKUSI_DIIZINKAN\s*=\s*false/);
});
