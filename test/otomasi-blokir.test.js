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

test('3B.3: pemanggil buatPerintah di luar aktuator.js hanya rute admin (menolak DOSIS) dan kontrolAir (ISI_AIR saja)', () => {
  const pemanggil = semua().filter((f) => !f.endsWith(`${path.sep}aktuator.js`) || f.includes(`routes${path.sep}`))
    .filter((f) => /buatPerintah\(/.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(SRC, f)).sort();
  assert.deepEqual(pemanggil, ['kontrolAir.js', path.join('routes', 'aktuator.js')].sort());
  const air = fs.readFileSync(path.join(SRC, 'kontrolAir.js'), 'utf8');
  assert.equal((air.match(/tipe: '([A-Z_]+)'/g) || []).join(), "tipe: 'ISI_AIR'", 'kontrolAir hanya ISI_AIR');
  // kontrolAir belum dipasang ke rute mana pun (Water Control tetap nonaktif)
  for (const f of semua()) assert.ok(!/require\(['"][./]*kontrolAir['"]\)/.test(fs.readFileSync(f, 'utf8')), `${path.relative(SRC, f)} memuat kontrolAir`);
  const rute = fs.readFileSync(path.join(SRC, 'routes', 'aktuator.js'), 'utf8');
  assert.ok(rute.indexOf("=== 'DOSIS'") > -1 && rute.indexOf("=== 'DOSIS'") < rute.indexOf('A.buatPerintah({'), 'DOSIS ditolak sebelum antre');
});
