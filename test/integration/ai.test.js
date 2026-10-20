'use strict';
/**
 * Integrasi — asisten keputusan budidaya: POST /api/ai/langkah-selanjutnya
 * (src/routes/ai.js).
 *
 * Kontrak yang diuji (dibaca dari kode):
 *   1. tanpa token          → 401 'Tidak terautentikasi.'
 *   2. token demo           → 403 (guard aiRole: demo ditolak)
 *   3. token admin          → 200 + sumber 'heuristik' — Ollama sengaja DIPANCING
 *                             mati (AI_OLLAMA_URL → port tertutup) sehingga fallback
 *                             KERAS teruji deterministik walau ada Ollama di mesin dev.
 *   4. token petani         → 200 (role admin|petani diizinkan)
 *   5. body id tidak valid  → 422 terstruktur
 *   6. Ollama BLOW-UP balasan valid (mock lokal) → sumber 'ollama' + model dari AI_MODEL;
 *      mock membalas JSON rusak → fallback heuristik dgn fallback_karena 'json_invalid'.
 *
 * Tidak ada tulis data → net-zero. Token petani/demo ditandatangani lokal (nol login);
 * 1× login admin per server via helper _server.js.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');
const { startServer, adminToken, craftToken, bearer } = require('./_server');

const DEAD_URL = 'http://127.0.0.1:1';   // port hampir selalu tertutup → ECONNREFUSED
const PRIORITAS = ['tinggi', 'sedang', 'rendah'];
const pesanTerdapat = (b, field) => typeof b[field] === 'string' && b[field].length > 0;

const tokenPetani = () => bearer(craftToken(
  { sub: 3, username: 'petani', level: 'petani', demo: false }, { expiresIn: '1h' }));
const tokenDemo = () => bearer(craftToken(
  { sub: 2, username: 'demo', level: 'user', demo: true }, { expiresIn: '1h' }));

const asliOllamaUrl = process.env.AI_OLLAMA_URL;
let srv;         // server dgn Ollama mati (uji fallback)
let base;
let auth;
let mock;        // { server, port, panggilan, mode }
let srvMock;     // server dgn Ollama mock (uji jalur LLM)
let baseMock;

/** Mock Ollama: POST /api/generate → balasan sesuai mode ('valid' | 'rusak'). */
function bukaMockOllama() {
  const state = { mode: 'valid', panggilan: 0, prompt: null, model: null };
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url.startsWith('/api/generate')) {
      res.writeHead(404);
      return res.end('{}');
    }
    state.panggilan += 1;
    let badan = '';
    req.on('data', (c) => { badan += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      // Catat isi request — divalidasi di test, BUKAN di sini, supaya exception
      // tidak terlempar dari dalam handler http (bisa menjatuhkan proses tes).
      try {
        const isi = JSON.parse(badan || '{}');
        state.prompt = String(isi.prompt || '');
        state.model = isi.model;
      } catch { state.prompt = null; }
      if (state.mode === 'rusak') {
        return res.end(JSON.stringify({ response: 'maaf, saya bukan JSON' }));
      }
      return res.end(JSON.stringify({
        response: JSON.stringify({
          keputusan: 'Aktifkan aerasi tambahan pada meja utama',
          alasan: 'Suhu air mendekati batas atas ambang sensor_thresholds.',
          prioritas: 'sedang',
        }),
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        get panggilan() { return state.panggilan; },
        get prompt() { return state.prompt; },
        get model() { return state.model; },
        set mode(v) { state.mode = v; },
      });
    });
  });
}

before(async () => {
  process.env.AI_OLLAMA_URL = DEAD_URL;          // deterministik: Ollama "mati"
  srv = await startServer();
  base = srv.base;
  auth = bearer(await adminToken(base));
});

after(async () => {
  if (srv) await srv.stop();
  if (srvMock) await srvMock.stop();
  if (mock) await new Promise((r) => mock.server.close(r));
  if (asliOllamaUrl === undefined) delete process.env.AI_OLLAMA_URL;
  else process.env.AI_OLLAMA_URL = asliOllamaUrl;
});

/* ── proteksi ──────────────────────────────────────────────────────── */
test('POST /api/ai/langkah-selanjutnya tanpa token → 401 kontrak', async () => {
  const res = await request(base).post('/api/ai/langkah-selanjutnya').send({});
  assert.equal(res.status, 401, `body: ${res.text}`);
  assert.deepEqual(res.body, { message: 'Tidak terautentikasi.' });
});

test('POST (token demo) → 403 guard aiRole (demo tidak memakai asisten AI)', async () => {
  const res = await request(base).post('/api/ai/langkah-selanjutnya').set(tokenDemo()).send({});
  assert.equal(res.status, 403, `body: ${res.text}`);
  assert.deepEqual(res.body, { message: 'Mode demo tidak boleh memakai asisten AI.' });
});

test('POST (id tidak valid) → 422 terstruktur', async () => {
  const res = await request(base).post('/api/ai/langkah-selanjutnya').set(auth)
    .send({ id_meja: 'bukan-angka' });
  assert.equal(res.status, 422, `body: ${res.text}`);
  assert.equal(res.body.message, 'Data tidak valid.');
  assert.ok(res.body.errors?.id_meja, 'errors.id_meja wajib ada');
});

/* ── fallback heuristik (Ollama mati) ──────────────────────────────── */
test('POST (admin, Ollama mati) → 200 sumber=heuristik dari data DB nyata', async () => {
  const res = await request(base).post('/api/ai/langkah-selanjutnya').set(auth)
    .send({ id_tanaman: 3 });
  assert.equal(res.status, 200, `body: ${res.text}`);
  const b = res.body;
  assert.ok(pesanTerdapat(b, 'keputusan'), 'keputusan wajib terisi');
  assert.ok(pesanTerdapat(b, 'alasan'), 'alasan wajib terisi');
  assert.ok(PRIORITAS.includes(b.prioritas), `prioritas tidak dikenal: ${b.prioritas}`);
  assert.equal(b.sumber, 'heuristik');
  assert.equal(b.model, null, 'model=null saat fallback (tidak memakai LLM)');
  assert.ok(['koneksi', 'timeout', 'respons_ollama_tidak_valid', 'json_invalid']
    .includes(b.fallback_karena), `fallback_karena tak terduga: ${b.fallback_karena}`);
  // ringkasan = data NYATA dari DB
  assert.ok(b.ringkasan && typeof b.ringkasan === 'object', 'ringkasan wajib ada');
  for (const k of ['filter', 'sensor', 'ambang', 'alert', 'tahap', 'panen']) {
    assert.ok(k in b.ringkasan, `ringkasan.${k} hilang`);
  }
  assert.equal(b.ringkasan.filter.id_tanaman, '3');
  assert.ok(Array.isArray(b.ringkasan.tahap), 'ringkasan.tahap wajib array');
  // ambang & alert datang dari tabel, bukan angka hardcode
  assert.ok(b.ringkasan.ambang.ph, 'ambang ph dari sensor_thresholds');
  assert.equal(typeof b.ringkasan.alert.total, 'number');
  assert.ok(Array.isArray(b.aturan) && b.aturan.length > 0, 'aturan heuristik wajib terisi');
  assert.equal(typeof b.generated_at, 'string');
});

test('POST (petani) → 200 (role admin|petani diizinkan; petani tetap lolos)', async () => {
  const res = await request(base).post('/api/ai/langkah-selanjutnya').set(tokenPetani())
    .send({ id_meja: 8 });
  assert.equal(res.status, 200, `body: ${res.text}`);
  assert.equal(res.body.sumber, 'heuristik');
  assert.ok(pesanTerdapat(res.body, 'keputusan'));
});

/* ── jalur Ollama beneran (mock lokal) ─────────────────────────────── */
test('POST (Ollama hidup) → 200 sumber=ollama + model AI_MODEL; balasan rusak → heuristik', async () => {
  mock = await bukaMockOllama();
  process.env.AI_OLLAMA_URL = `http://127.0.0.1:${mock.port}`;
  srvMock = await startServer();
  baseMock = srvMock.base;
  const authMock = bearer(await adminToken(baseMock));

  // (a) balasan LLM valid → dipakai
  const ok = await request(baseMock).post('/api/ai/langkah-selanjutnya').set(authMock).send({});
  assert.equal(ok.status, 200, `body: ${ok.text}`);
  assert.equal(ok.body.sumber, 'ollama');
  assert.equal(ok.body.model, process.env.AI_MODEL || 'deepseek-r1:1.5b');
  assert.equal(ok.body.keputusan, 'Aktifkan aerasi tambahan pada meja utama');
  assert.equal(ok.body.prioritas, 'sedang');
  assert.equal(ok.body.fallback_karena, null);
  assert.equal(mock.panggilan, 1, 'Ollama mock harus dipanggil tepat 1×');
  // prompt yang dikirim ke LLM wajib berisi ringkasan data DB nyata + instruksi JSON
  assert.match(mock.prompt, /Data sistem saat ini/, 'prompt wajib berisi ringkasan data');
  assert.match(mock.prompt, /"keputusan"/, 'prompt wajib minta JSON {keputusan,...}');
  assert.equal(mock.model, process.env.AI_MODEL || 'deepseek-r1:1.5b');

  // (b) balasan LLM bukan JSON valid → fallback heuristik keras
  mock.mode = 'rusak';
  const rusak = await request(baseMock).post('/api/ai/langkah-selanjutnya').set(authMock).send({});
  assert.equal(rusak.status, 200, `body: ${rusak.text}`);
  assert.equal(rusak.body.sumber, 'heuristik');
  assert.equal(rusak.body.model, null);
  assert.equal(rusak.body.fallback_karena, 'json_invalid');
  assert.ok(pesanTerdapat(rusak.body, 'keputusan'));
  assert.equal(mock.panggilan, 2, 'Ollama mock harus dipanggil 2× total');
});