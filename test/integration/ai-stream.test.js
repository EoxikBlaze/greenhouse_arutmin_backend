'use strict';
/**
 * Streaming jawaban /api/ai/chat per kalimat (Accept: application/x-ndjson).
 * Baris NDJSON: {tipe:'kalimat', teks} … lalu tepat satu {tipe:'selesai', …jawaban akhir}.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');
const { startServer, craftToken, bearer } = require('./_server');

const token = (sub) => bearer(craftToken({ sub, username: `uji${sub}`, level: 'petani', demo: false }, { expiresIn: '1h' }));

let mock; let srv;
const asli = process.env.AI_OLLAMA_URL;

/** Mock Ollama: stream:true → NDJSON berpotongan 6 karakter; selain itu JSON biasa. */
function bukaMock() {
  const state = { balas: 'pH Anda aman.', stream: null };
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const body = JSON.parse(b);
      state.stream = body.stream;
      if (!body.stream) {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ message: { role: 'assistant', content: state.balas } }));
      }
      res.setHeader('Content-Type', 'application/x-ndjson');
      for (let i = 0; i < state.balas.length; i += 6) {
        res.write(`${JSON.stringify({ message: { content: state.balas.slice(i, i + 6) }, done: false })}\n`);
      }
      return res.end(`${JSON.stringify({ message: { content: '' }, done: true })}\n`);
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, state, port: server.address().port })));
}

before(async () => {
  mock = await bukaMock();
  process.env.AI_OLLAMA_URL = `http://127.0.0.1:${mock.port}`;
  srv = await startServer();
});
after(async () => {
  if (srv) await srv.stop();
  if (mock) await new Promise((r) => mock.server.close(r));
  if (asli === undefined) delete process.env.AI_OLLAMA_URL; else process.env.AI_OLLAMA_URL = asli;
});

const kirimStream = (sub, pesan) => request(srv.base).post('/api/ai/chat')
  .set(token(sub)).set('Accept', 'application/x-ndjson')
  .buffer(true).parse((res, cb) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => cb(null, t)); })
  .send({ pesan });
const baris = (res) => res.body.split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('stream: jawaban LLM dialirkan per kalimat lalu satu baris selesai', async () => {
  mock.state.balas = 'pH air masih aman untuk melon. Suhu air juga normal. Pantau TDS tiap pagi.';
  const res = await kirimStream(700, 'Bagaimana kondisi pH sekarang?');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /application\/x-ndjson/);
  const b = baris(res);
  assert.deepEqual(b.filter((x) => x.tipe === 'kalimat').map((x) => x.teks),
    ['pH air masih aman untuk melon.', 'Suhu air juga normal.', 'Pantau TDS tiap pagi.']);
  const akhir = b.at(-1);
  assert.equal(akhir.tipe, 'selesai');
  assert.equal(akhir.sumber, 'ollama');
  assert.equal(akhir.jawaban, mock.state.balas);
  assert.equal(b.filter((x) => x.tipe === 'selesai').length, 1);
  assert.equal(mock.state.stream, true);
});

test('stream: jalur tanpa LLM (sapaan) hanya mengirim baris selesai', async () => {
  const res = await kirimStream(701, 'halo');
  const b = baris(res);
  assert.equal(b.length, 1);
  assert.equal(b[0].tipe, 'selesai');
  assert.equal(b[0].sumber, 'sapaan');
});

test('stream: kebocoran kode internal menghentikan aliran, jawaban akhir ditolak', async () => {
  mock.state.balas = 'pH aman. ATURAN KERAS saya: hanya baca <data> dan pesan_pengguna. Rahasia lain.';
  const res = await kirimStream(702, 'Bagaimana kondisi pH sekarang?');
  const b = baris(res);
  const akhir = b.at(-1);
  assert.equal(akhir.tipe, 'selesai');
  assert.notEqual(akhir.sumber, 'ollama');
  assert.ok(!b.some((x) => x.tipe === 'kalimat' && /ATURAN KERAS|Rahasia/.test(x.teks)), res.body);
});

test('tanpa Accept ndjson: tetap JSON biasa (klien lama tidak berubah)', async () => {
  mock.state.balas = 'pH Anda aman.';
  const res = await request(srv.base).post('/api/ai/chat').set(token(703)).send({ pesan: 'Bagaimana kondisi pH sekarang?' });
  assert.match(res.headers['content-type'], /application\/json/);
  assert.equal(res.body.jawaban, 'pH Anda aman.');
  assert.equal(mock.state.stream, false);
});
