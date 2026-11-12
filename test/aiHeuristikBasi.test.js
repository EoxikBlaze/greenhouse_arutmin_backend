'use strict';
/** Bacaan sensor basi (alat terputus) tidak boleh menghasilkan "tidak ada kondisi kritis" atau saran koreksi larutan. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { heuristik } = require('../src/routes/ai');

const AMBANG = { ph: { min: 5, max: 7, satuan: '' }, tds: { min: 500, max: 1000, satuan: 'ppm' } };
const dasar = (sensor) => ({ ambang: AMBANG, sensor, alert: { total: 0, terbaru: [] }, tahap: [{ tahap: 'semai', status: 'berjalan' }], panen: null });
const lalu = (jam) => new Date(Date.now() - jam * 3600_000);

test('bacaan basi dalam rentang → minta periksa alat, bukan "pantau rutin"', () => {
  const h = heuristik(dasar({ ph: 6, tds: 800, created_at: lalu(5) }));
  assert.match(h.keputusan, /periksa alat sensor/i);
  assert.equal(h.prioritas, 'tinggi');
  assert.doesNotMatch(h.alasan, /tidak ada kondisi kritis/i);
});

test('bacaan basi di luar ambang → tidak menyuruh mengoreksi larutan dari angka lama', () => {
  const h = heuristik(dasar({ ph: 8.5, tds: 800, created_at: lalu(30) }));
  assert.match(h.keputusan, /periksa alat sensor/i);
  assert.doesNotMatch(h.alasan, /turunkan ph/i);
});

test('bacaan segar tetap dinilai terhadap ambang (updated_at terbaru dihitung segar)', () => {
  assert.match(heuristik(dasar({ ph: 8.5, tds: 800, created_at: new Date() })).keputusan, /turunkan ph/i);
  assert.match(heuristik(dasar({ ph: 8.5, tds: 800, created_at: lalu(30), updated_at: new Date() })).keputusan, /turunkan ph/i);
  assert.match(heuristik(dasar({ ph: 6, tds: 800, created_at: new Date() })).keputusan, /pantau/i);
});

test('bacaan tidak wajar (probe lepas: TDS 20, pH 11) → periksa probe, bukan menaikkan dosis', () => {
  for (const sensor of [{ ph: 6, tds: 20, created_at: new Date() }, { ph: 11, tds: 800, created_at: new Date() }]) {
    const h = heuristik(dasar(sensor));
    assert.match(h.keputusan, /periksa probe/i);
    assert.doesNotMatch(h.alasan, /dosis perlu dinaikkan|turunkan ph/i);
  }
});
