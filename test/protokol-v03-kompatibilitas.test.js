'use strict';
/**
 * Fase 3F — KARAKTERISASI kompatibilitas server ↔ protokol aktuator v0.3 (docs/PROTOKOL_FIRMWARE_V03.md), memakai
 * MODEL perilaku scripts/aktuator-v03-sim.js dan klien MQTT tiruan. Ini BUKAN uji firmware, broker, atau perangkat.
 *
 * Tes "KARAKTERISASI" mencatat ketidakcocokan yang MASIH ADA (blocker P1-04): sengaja lulus selama payload server
 * belum memenuhi v0.3. Bila payload/detak diubah, tes ini gagal dan memaksa peninjauan ulang kompatibilitas sebelum
 * gerbang dosis boleh dipertimbangkan. Tidak ada DOSIS yang dibuat; fixture DOSIS hanya objek memori.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { AktuatorV03 } = require('../scripts/aktuator-v03-sim');
const { terbitkanPerintah } = require('../src/mqttJembatan');

const T0 = 1_800_000_000;
const NVS = () => ({ idTerakhir: null, kalibrasi: { AB: 2 }, batasMl: { AB: 100 }, sedangJalan: null });
const siap = () => { const a = new AktuatorV03({ nvs: NVS() }); a.detak({ ts: T0 }, 0); return a; };
const klien = () => { const keluar = []; return { keluar, publish: (topik, isi, opsi) => keluar.push({ topik, isi: JSON.parse(isi), opsi }) }; };

test('model v0.3: detak tanpa ts yang sah TIDAK menyinkronkan jam (jam_belum_sinkron, bukan NaN lolos)', () => {
  for (const ts of [undefined, null, 'x', NaN, Infinity]) {
    const a = new AktuatorV03({ nvs: NVS() });
    a.detak({ ts }, 0);
    assert.equal(a.epoch(), null, `ts=${String(ts)}`);
    const r = a.terima({ id: 5, tipe: 'DOSIS', parameter: { larutan: 'AB', ml: 10 }, kejadian: 1, percobaan: 1, exp: T0 + 60 }, 10);
    assert.equal(r.alasan, 'jam_belum_sinkron', `ts=${String(ts)}`);
    assert.equal(a.output, false);
  }
});

test('KARAKTERISASI P1-04: STOP dan STOP_DARURAT dari publisher server diterima model (kompatibel)', () => {
  const c = klien();
  terbitkanPerintah(c, 'aktuator-01', [{ id: 1, tipe: 'STOP', parameter: {} }, { id: 2, tipe: 'STOP_DARURAT', parameter: {} }], { warn() {} });
  const a = siap();
  for (const m of c.keluar) assert.equal(a.terima(m.isi, 1000).diterima, true, m.isi.tipe);
});

test('KARAKTERISASI P1-04: payload server untuk perintah berisiko belum memuat exp/v → model v0.3 menolak (exp_tidak_ada)', () => {
  const c = klien();
  terbitkanPerintah(c, 'aktuator-01', [
    { id: 11, tipe: 'ISI_AIR', parameter: { penampung: 1, aksi: 'MULAI', katup: 1 } },
    { id: 12, tipe: 'SAMPLING', parameter: { penampung: 1 } },
    { id: 13, tipe: 'BILAS', parameter: { penampung: 1, ml: 50 } },
  ], { warn() {} });
  assert.equal(c.keluar.length, 3);
  const a = siap();
  for (const m of c.keluar) {
    assert.deepEqual(Object.keys(m.isi).sort(), ['id', 'parameter', 'tipe'], 'payload saat ini: hanya id, tipe, parameter');
    assert.equal(a.terima(m.isi, 1000).alasan, 'exp_tidak_ada', m.isi.tipe);
  }
  assert.equal(a.output, false);
});

test('KARAKTERISASI P1-04: detak server saat ini {online, estop, t} tidak memuat ts epoch yang diwajibkan v0.3', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'mqttJembatan.js'), 'utf8');
  const detak = src.match(/server\/status`,\s*\n?\s*JSON\.stringify\(\{([^}]*)\}\), \{ qos: 0, retain: true \}/);
  assert.ok(detak, 'bentuk publish detak ditemukan');
  assert.match(detak[1], /\bt:\s*new Date\(\)\.toISOString\(\)/);
  assert.doesNotMatch(detak[1], /\bts\s*:/);
  const a = new AktuatorV03({ nvs: NVS() });
  a.detak({ ts: undefined, estop: false }, 0); // persis yang terjadi bila firmware v0.3 membaca detak server ini
  assert.equal(a.epoch(), null);
});

test('DOSIS tidak pernah diterbitkan walau payload memenuhi semua syarat v0.3 (v, exp, kejadian, percobaan)', () => {
  const c = klien();
  const v03 = { id: 99, tipe: 'DOSIS', v: 2, exp: T0 + 60, ttl_s: 60, kejadian: 7, percobaan: 8, parameter: { penampung: 1, larutan: 'AB', ml: 10 } };
  terbitkanPerintah(c, 'aktuator-01', [v03], { warn() {} });
  assert.deepEqual(c.keluar, []);
});
