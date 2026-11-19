'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const semua = () => [...fs.readdirSync(SRC).map((f) => path.join(SRC, f)), ...fs.readdirSync(path.join(SRC, 'routes')).map((f) => path.join(SRC, 'routes', f))]
  .filter((f) => f.endsWith('.js'));

test('3B.3: pengendali dosing lama (otomasi.js) sudah dihapus; tidak ada yang memuatnya; OTOMASI tidak dibaca', () => {
  assert.equal(fs.existsSync(path.join(SRC, 'otomasi.js')), false);
  for (const f of semua()) {
    const isi = fs.readFileSync(f, 'utf8');
    const nama = path.relative(SRC, f);
    assert.ok(!/require\(['"][./]*otomasi['"]\)/.test(isi), `${nama} memuat otomasi`);
    assert.ok(!/process\.env\.OTOMASI/.test(isi), `${nama} membaca env OTOMASI`);
  }
});

test('3B.3/3C: pemanggil buatPerintah di luar aktuator.js hanya rute admin (menolak DOSIS), kontrolAir (ISI_AIR saja), dosingSiklus (STOP saja), sinkronAlat (OTOMASI/KONFIGURASI/SEMAI/TARGET/PANEN), routes/iotV41 (UJI_POMPA, KALIBRASI, BALIK_KALIBRASI, JADWAL, STOP; tidak pernah DOSIS)', () => {
  const pemanggil = semua().filter((f) => !f.endsWith(`${path.sep}aktuator.js`) || f.includes(`routes${path.sep}`))
    .filter((f) => /buatPerintah\(/.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(SRC, f)).sort();
  assert.deepEqual(pemanggil, ['dosingSiklus.js', 'kontrolAir.js', 'sinkronAlat.js', path.join('routes', 'aktuator.js'), path.join('routes', 'iotV41.js')].sort());
  // alur tanam → alat (Perancangan v5.0 §2.2): hanya KONFIGURASI / SEMAI / TARGET / PANEN, tidak pernah DOSIS (K3)
  const sinkron = fs.readFileSync(path.join(SRC, 'sinkronAlat.js'), 'utf8');
  assert.equal((sinkron.match(/tipe: '([A-Z_]+)'/g) || []).join(), "tipe: 'KONFIGURASI',tipe: 'SEMAI',tipe: 'OTOMASI',tipe: 'OTOMASI',tipe: 'TARGET',tipe: 'TARGET',tipe: 'PANEN',tipe: 'PANEN'", 'sinkronAlat tanpa DOSIS (perintah + jawaban)');
  assert.equal((sinkron.match(/buatPerintah\(/g) || []).length, 5);
  // modul v4.1: uji pompa (terkunci bawaan), kiriman laju pompa, jadwal NVS (bukan aktuasi), dan STOP. Tidak ada jalur DOSIS.
  const v41 = fs.readFileSync(path.join(SRC, 'routes', 'iotV41.js'), 'utf8');
  assert.equal((v41.match(/tipe: '([A-Z_]+)'/g) || []).join(), "tipe: 'PEMELIHARAAN',tipe: 'UJI_POMPA',tipe: 'KALIBRASI',tipe: 'BALIK_KALIBRASI',tipe: 'KALIBRASI',tipe: 'JADWAL',tipe: 'STOP'", 'iotV41 tanpa DOSIS');
  assert.equal((v41.match(/buatPerintah\(/g) || []).length, 4);
  // alur persetujuan (3C): eksekusi diblokir — satu-satunya perintah adalah STOP saat siklus RUNNING dicabut
  const dos = fs.readFileSync(path.join(SRC, 'dosingSiklus.js'), 'utf8');
  assert.equal((dos.match(/tipe: '([A-Z_]+)'/g) || []).join(), "tipe: 'STOP'", 'dosingSiklus hanya STOP');
  assert.equal((dos.match(/buatPerintah\(/g) || []).length, 1);
  const air = fs.readFileSync(path.join(SRC, 'kontrolAir.js'), 'utf8');
  assert.equal((air.match(/tipe: '([A-Z_]+)'/g) || []).join(), "tipe: 'ISI_AIR'", 'kontrolAir hanya ISI_AIR');
  // kontrolAir belum dipasang ke rute mana pun (Water Control tetap nonaktif)
  for (const f of semua()) assert.ok(!/require\(['"][./]*kontrolAir['"]\)/.test(fs.readFileSync(f, 'utf8')), `${path.relative(SRC, f)} memuat kontrolAir`);
  const rute = fs.readFileSync(path.join(SRC, 'routes', 'aktuator.js'), 'utf8');
  assert.ok(rute.indexOf("=== 'DOSIS'") > -1 && rute.indexOf("=== 'DOSIS'") < rute.indexOf('A.buatPerintah({'), 'DOSIS ditolak sebelum antre');
});
