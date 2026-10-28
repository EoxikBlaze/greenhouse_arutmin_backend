'use strict';
/**
 * Fase 3B.2 — penyimpanan bacaan sensor bersamaan (saveSensorRows: jalur MQTT, /api/device/v1 & /api/saveSensor).
 * Dulu 20 kiriman identik bersamaan → 4–20 baris ganda. HANYA DB uji (`garap_uji*`, butuh migrasi 04).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool, q } = require('../../src/db');
const { saveSensorRows } = require('../../src/routes/monitoring');

const namaDb = new URL(process.env.DATABASE_URL || 'postgres://x/none').pathname.slice(1);
const lewati = namaDb.startsWith('garap_uji') ? false : `hanya untuk DB uji garap_uji* (sekarang: ${namaDb || 'dari .env'})`;
const meja = [];

before(async () => {
  if (lewati) return;
  for (const n of ['a', 'b']) meja.push(Number((await q("INSERT INTO mejas (meja, jumlah_lubang, created_at, updated_at) VALUES ($1, 1, now(), now()) RETURNING id_meja", [`uji-3b2-${n}`]))[0].id_meja));
});
after(async () => {
  if (!lewati) {
    await q('DELETE FROM monitorings WHERE id_meja = ANY($1)', [meja]);
    await q('DELETE FROM mejas WHERE id_meja = ANY($1)', [meja]);
  }
  await pool.end();
});

const baris = (m) => q('SELECT ph, tds, n_konfirmasi FROM monitorings WHERE id_meja = $1 ORDER BY id', [m]);

test('3B.2 sensor: 20 kiriman identik bersamaan → 1 baris, 20 penerimaan tercatat', { skip: lewati }, async () => {
  await Promise.all(Array.from({ length: 20 }, () => saveSensorRows({ ph: 6.1, tds: 501, waterTemp: 26 }, { idMeja: meja[0] })));
  const r = await baris(meja[0]);
  assert.equal(r.length, 1);
  assert.equal(r[0].n_konfirmasi, 20);
});

test('3B.2 sensor: dua penampung bersamaan tidak saling menimpa dan tidak saling menunggu kunci global', { skip: lewati }, async () => {
  const t0 = Date.now();
  await Promise.all(Array.from({ length: 30 }, (_, i) => saveSensorRows(
    i % 2 ? { ph: 5.9, tds: 700, waterTemp: 25 } : { ph: 6.4, tds: 900, waterTemp: 27 },
    { idMeja: i % 2 ? meja[1] : meja[0] })));
  const a = await baris(meja[0]);
  const b = await baris(meja[1]);
  assert.ok(a.every((x) => Number(x.tds) !== 700), 'data penampung B tidak masuk ke A');
  assert.ok(b.every((x) => Number(x.tds) === 700), 'data penampung A tidak masuk ke B');
  assert.equal(b.length, 1);
  assert.equal(b[0].n_konfirmasi, 15);
  assert.equal(a.filter((x) => Number(x.tds) === 900).length, 1);
  assert.ok(Date.now() - t0 < 10000, `selesai wajar (${Date.now() - t0} ms)`);
});

test('3B.2 sensor: urutan bacaan berbeda tetap tersimpan semua (tidak hilang karena antrean)', { skip: lewati }, async () => {
  const sebelum = (await baris(meja[1])).length;
  await Promise.all([700, 710, 720, 730, 740].map((tds) => saveSensorRows({ ph: 6.0, tds, waterTemp: 25 }, { idMeja: meja[1] })));
  assert.equal((await baris(meja[1])).length, sebelum + 5);
});

test('3B.3 sensor: jalur simpan sensor (termasuk /api/saveSensor lama) tidak pernah membuat perintah aktuator', { skip: lewati }, async () => {
  const n = async () => Number((await q('SELECT count(*) FROM perintah_aktuator'))[0].count);
  const awal = await n();
  await Promise.all(Array.from({ length: 10 }, (_, i) => saveSensorRows({ ph: 6, tds: 800 + i, waterTemp: 25, solenoid_state: 'ON' }, { idMeja: meja[0] })));
  assert.equal(await n(), awal);
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', 'src', 'routes', 'monitoring.js'), 'utf8');
  assert.ok(!/buatPerintah|require\(['"]\.\.\/aktuator['"]\)|perintah_aktuator/.test(src), 'monitoring.js tidak menyentuh antrean aktuator');
});
