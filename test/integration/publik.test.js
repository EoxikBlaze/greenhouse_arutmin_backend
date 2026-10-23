'use strict';
/** Integrasi — GET /api/publik/ringkasan: publik (tanpa token), hanya agregat, tanpa data sensitif. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./_server');

let srv;
before(async () => { srv = await startServer(); });
after(async () => { if (srv?.stop) await srv.stop(); else if (srv?.close) await srv.close(); });

test('ringkasan publik dapat dibaca tanpa login dan berbentuk agregat', async () => {
  const r = await fetch(`${srv.base}/api/publik/ringkasan`);
  assert.equal(r.status, 200);
  const j = await r.json();
  for (const k of ['meja', 'lubang', 'jenis_tanaman', 'panen', 'iot', 'rata_6_jam', 'tren_24_jam', 'diperbarui']) {
    assert.ok(k in j, `kunci ${k} hilang`);
  }
  assert.equal(typeof j.iot.online, 'boolean');
  assert.ok(Array.isArray(j.tren_24_jam));
});

test('ringkasan publik tidak membocorkan data sensitif', async () => {
  const teks = await (await fetch(`${srv.base}/api/publik/ringkasan`)).text();
  assert.doesNotMatch(teks, /password|token|secret|rtsp|username|email|\bip\b/i);
});
