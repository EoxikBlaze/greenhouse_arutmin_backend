'use strict';
/**
 * Integrasi — POST /api/ai/chat (chat bebas) dan /cctv (papan kamera).
 * Ollama diganti mock lokal / dimatikan; data CCTV yang dibuat dihapus lagi (net-zero).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');
const { startServer, adminToken, craftToken, bearer } = require('./_server');

const tokenPetani = () => bearer(craftToken(
  { sub: 3, username: 'petani', level: 'petani', demo: false }, { expiresIn: '1h' }));
const tokenDemo = () => bearer(craftToken(
  { sub: 2, username: 'demo', level: 'user', demo: true }, { expiresIn: '1h' }));

const asli = process.env.AI_OLLAMA_URL;
let mati; let hidup; let auth; let mock;

function bukaMock() {
  const state = { pesan: null, panggilan: 0 };
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method !== 'POST' || !req.url.startsWith('/api/chat')) { res.writeHead(404); return res.end('{}'); }
      state.panggilan += 1;
      try { state.pesan = JSON.parse(b).messages; } catch { state.pesan = null; }
      return res.end(JSON.stringify({ message: { role: 'assistant', content: 'pH Anda aman.' } }));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({
    server, port: server.address().port, state,
  })));
}

before(async () => {
  process.env.AI_OLLAMA_URL = 'http://127.0.0.1:1';
  mati = await startServer();
  auth = bearer(await adminToken(mati.base));
  mock = await bukaMock();
  process.env.AI_OLLAMA_URL = `http://127.0.0.1:${mock.port}`;
  hidup = await startServer();
});

after(async () => {
  if (mati) await mati.stop();
  if (hidup) await hidup.stop();
  if (mock) await new Promise((r) => mock.server.close(r));
  if (asli === undefined) delete process.env.AI_OLLAMA_URL; else process.env.AI_OLLAMA_URL = asli;
});

/* ── chat ──────────────────────────────────────────────────────────── */
test('chat tanpa token → 401, demo → 403', async () => {
  assert.equal((await request(mati.base).post('/api/ai/chat').send({ pesan: 'hai' })).status, 401);
  assert.equal((await request(mati.base).post('/api/ai/chat').set(tokenDemo()).send({ pesan: 'hai' })).status, 403);
});

test('chat pesan kosong / terlalu panjang / bukan teks → 422', async () => {
  for (const pesan of ['', '   ', 'x'.repeat(601), 123]) {
    const res = await request(mati.base).post('/api/ai/chat').set(auth).send({ pesan });
    assert.equal(res.status, 422, JSON.stringify(pesan).slice(0, 20));
    assert.ok(res.body.errors?.pesan);
  }
});

test('chat saat Ollama mati → 200 jawaban heuristik (bukan 500)', async () => {
  const res = await request(mati.base).post('/api/ai/chat').set(auth).send({ pesan: 'Bagaimana pH?' });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.sumber, 'heuristik');
  assert.ok(res.body.fallback_karena);
  assert.ok(typeof res.body.jawaban === 'string' && res.body.jawaban.length > 10);
});

test('chat dengan Ollama mock → jawaban model, system prompt + riwayat terkirim', async () => {
  const res = await request(hidup.base).post('/api/ai/chat').set(tokenPetani()).send({
    pesan: 'Apakah pH aman?',
    riwayat: [{ peran: 'user', teks: 'halo' }, { peran: 'ai', teks: 'Halo!' }],
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.sumber, 'ollama');
  assert.equal(res.body.jawaban, 'pH Anda aman.');
  const m = mock.state.pesan;
  assert.equal(m[0].role, 'system');
  assert.match(m[0].content, /<data>/);
  assert.deepEqual(m.slice(1).map((x) => x.role), ['user', 'assistant', 'user']);
  assert.equal(m[m.length - 1].content, '<pesan_pengguna>Apakah pH aman?</pesan_pengguna>');
});

/* ── cctv ──────────────────────────────────────────────────────────── */
test('cctv: tanpa token 401; petani & demo boleh baca', async () => {
  assert.equal((await request(mati.base).get('/cctv')).status, 401);
  const p = await request(mati.base).get('/cctv').set(tokenPetani());
  assert.equal(p.status, 200, p.text);
  assert.ok(Array.isArray(p.body.list));
  assert.equal((await request(mati.base).get('/cctv').set(tokenDemo())).status, 200);
});

test('cctv: petani & demo tidak boleh menulis', async () => {
  const body = { nama: 'X', tipe: 'snapshot', url: 'http://10.0.0.1/capture' };
  assert.equal((await request(mati.base).post('/cctv').set(tokenPetani()).send(body)).status, 403);
  assert.equal((await request(mati.base).post('/cctv').set(tokenDemo()).send(body)).status, 403);
});

test('cctv: validasi 422 (nama kosong, url bukan http, tipe salah, interval)', async () => {
  const res = await request(mati.base).post('/cctv').set(auth)
    .send({ nama: '', tipe: 'webrtc', url: 'javascript:alert(1)', interval_detik: 999 });
  assert.equal(res.status, 422, res.text);
  for (const f of ['nama', 'tipe', 'url', 'interval_detik']) assert.ok(res.body.errors[f], f);
});

test('cctv: tambah → daftar → ubah → hapus (net-zero)', async () => {
  const c = await request(mati.base).post('/cctv').set(auth)
    .send({ nama: 'Uji Kamera', lokasi: 'GH A', tipe: 'mjpeg', url: 'http://192.168.1.50:81/stream' });
  assert.equal(c.status, 201, c.text);
  const id = c.body.data.id;
  try {
    const l = await request(mati.base).get('/cctv').set(tokenPetani());
    assert.ok(l.body.list.some((k) => String(k.id) === String(id)));
    const u = await request(mati.base).put(`/cctv/${id}`).set(auth).send({ aktif: false, nama: 'Uji 2' });
    assert.equal(u.status, 200, u.text);
    assert.equal(u.body.data.aktif, false);
    assert.equal(u.body.data.nama, 'Uji 2');
  } finally {
    const d = await request(mati.base).delete(`/cctv/${id}`).set(auth);
    assert.equal(d.status, 200, d.text);
  }
  assert.equal((await request(mati.base).delete(`/cctv/${id}`).set(auth)).status, 404);
  assert.equal((await request(mati.base).put('/cctv/abc').set(auth).send({ nama: 'a' })).status, 404);
});
