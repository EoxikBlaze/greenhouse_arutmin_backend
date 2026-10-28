'use strict';
/** Fase 3B.4 — sandi yang tertulis di MQTT_URL tidak boleh muncul di log jembatan. Broker aedes di dalam proses. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const jembatan = require('../../src/mqttJembatan');
const { pool } = require('../../src/db');

test('3B.4 mqtt: log "tersambung" menyamarkan kredensial di URL', async () => {
  const broker = require('aedes')();
  const srv = net.createServer(broker.handle);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const baris = [];
  const log = { log: (...a) => baris.push(a.join(' ')), warn: (...a) => baris.push(a.join(' ')) };
  const j = jembatan.mulai({ url: `mqtt://garap-api:SANDI-UJI-RAHASIA@127.0.0.1:${srv.address().port}`, log });
  try {
    for (let i = 0; i < 50 && !baris.some((b) => b.includes('tersambung')); i += 1) await new Promise((r) => setTimeout(r, 100));
    const s = baris.find((b) => b.includes('tersambung'));
    assert.ok(s, 'jembatan tersambung');
    assert.ok(!baris.join('\n').includes('SANDI-UJI-RAHASIA'), 'sandi tidak boleh ada di log');
    assert.match(s, /mqtt:\/\/\*\*\*@127\.0\.0\.1/);
  } finally {
    await j.berhenti();
    await new Promise((r) => broker.close(r));
    srv.close();
    await pool.end();
  }
});
