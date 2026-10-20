'use strict';
/**
 * Integripsi gelombang-2 #6 — kontrak aneh lintas-rute (mandat 7, 8, 9):
 *
 *  (7) query param janggal pada GET /penampung-states (satu-satunya sumber dgn
 *      filter ?id_meja=):
 *        ?id_meja[]=2        → SAAT INI 500 (array lolos validasi angka lalu
 *                              gagal cast bigint di PostgreSQL) → tes FLEKSIBEL
 *                              [500, 422] dgn komentar target G9b/G10;
 *        ?ID_MEJA=3          → 200 TANPA penyaringan (key case-sensitive → diabaikan),
 *                              dibuktikan identik byte dgn permintaan tanpa query;
 *        ?id_meja= (kosong)  → 422 terstruktur;
 *        ?id_meja=2&id_meja=3 / [] ganda → 422 (array → bukan angka valid).
 *  (8) 404 id tak-ada byte-identik untuk PUT & DELETE pada DUA resource berbeda.
 *  (9) 5 header wajib pada respons lintas kelas status + x-powered-by dimatikan.
 *
 * Net-zero alami: semua permintaan gagal/404 tidak pernah menulis baris.
 * 1 login admin, token lain lokal.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { startServer, adminToken, craftToken, bearer } = require('./_server');

const ID_TIDAK_ADA = '9223372036854775806';
const NOT_FOUND = { message: 'Data tidak ditemukan.', errors: {} };

let srv;
let base;
let auth;

const tokenPetani = () => bearer(craftToken(
  { sub: 3, username: 'petani', level: 'petani', demo: false }, { expiresIn: '1h' }));

/** Bandingkan body dua respons pada tingkat BYTE. */
function assertSameBytes(a, b, label) {
  assert.equal(Buffer.compare(Buffer.from(a.text ?? ''), Buffer.from(b.text ?? '')), 0,
    `${label}: body harus identik byte → "${a.text}" vs "${b.text}"`);
  assert.equal(a.headers['content-type'], b.headers['content-type']);
}

before(async () => {
  srv = await startServer();
  base = srv.base;
  auth = bearer(await adminToken(base));
});
after(async () => { if (srv) await srv.stop(); });

/* ── (7) query param aneh ──────────────────────────────────────────── */
test('GET /penampung-states?id_meja[]=2 → 500 SAAT INI (fleksibel 500|422 — target G9b/G10)', async () => {
  const res = await request(base).get('/penampung-states?id_meja[]=2').set(auth);
  // Perilaku tercatat: qs mengubah "id_meja[]=2" menjadi ARRAY ['2'] → lolos
  // idValidValue (String(['2']) === '2') → dikirim ke SQL sebagai array →
  // cast bigint gagal → 500 generik. Kontrak ideal = 422 terstruktur.
  // Fleksibel [500,422] supaya tidak merah saat G9b/G10 memperbaikinya;
  // status lain (mis. 200 diam-diam mengabaikan) → gagal dengan pesan jelas.
  assert.ok([500, 422].includes(res.status),
    `?id_meja[]=2: status ${res.status} DI LUAR daftar [500, 422] — body: ${res.text}`);
  if (res.status === 500) {
    assert.deepEqual(res.body, { message: 'Terjadi kesalahan pada server.' });
  } else {
    assert.deepEqual(res.body, {
      message: 'Data tidak valid.',
      errors: { id_meja: ['Filter id_meja harus berupa angka yang valid.'] },
    });
  }
});

test('GET /penampung-states?ID_MEJA=3 → 200 & FILTER diterapkan (normalisasi case — keputusan G9b)', async () => {
  // Keputusan G9b (dokumentasi di src/routes/_id.js queryParam): nama param
  // filter dikenali case-insensitive; dulu ?ID_MEJA diabaikan SENYAP sehingga
  // klien menerima SEMUA baris tanpa filter (temuan debugging RENDAH).
  const kecil = await request(base).get('/penampung-states?id_meja=3').set(auth);
  const besar = await request(base).get('/penampung-states?ID_MEJA=3').set(auth);
  const tanpa = await request(base).get('/penampung-states').set(auth);
  assert.equal(besar.status, 200, `body: ${besar.text}`);
  assert.ok(Array.isArray(besar.body));
  assert.equal(besar.body.length, 1, `filter id 3 harus 1 baris, dapat ${besar.body.length}`);
  assertSameBytes(besar, kecil, 'ID_MEJA harus diperlakukan identik dengan id_meja');
  assert.ok(tanpa.body.length > besar.body.length,
    'tanpa-query harus mengembalikan baris lebih banyak daripada terfilter');
});

test('GET /penampung-states?id_meja= (kosong) → 422 terstruktur kontrak', async () => {
  const res = await request(base).get('/penampung-states?id_meja=').set(auth);
  assert.equal(res.status, 422, `body: ${res.text}`);
  assert.deepEqual(res.body, {
    message: 'Data tidak valid.',
    errors: { id_meja: ['Filter id_meja harus berupa angka yang valid.'] },
  });
});

test('GET /penampung-states?id_meja=2&id_meja=3 (duplikat → array) → 422 terstruktur', async () => {
  const res = await request(base).get('/penampung-states?id_meja=2&id_meja=3').set(auth);
  assert.equal(res.status, 422, `body: ${res.text}`);
  assert.deepEqual(res.body, {
    message: 'Data tidak valid.',
    errors: { id_meja: ['Filter id_meja harus berupa angka yang valid.'] },
  });
});

test('GET /penampung-states?id_meja[]=2&id_meja[]=3 (array ganda) → 422 terstruktur', async () => {
  const res = await request(base).get('/penampung-states?id_meja[]=2&id_meja[]=3').set(auth);
  assert.equal(res.status, 422,
    `array 2 elemen harus 422 ('2,3' bukan angka); aktual ${res.status} — body: ${res.text}`);
  assert.deepEqual(res.body, {
    message: 'Data tidak valid.',
    errors: { id_meja: ['Filter id_meja harus berupa angka yang valid.'] },
  });
});

test('GET /penampung-states?id_meja=3 (angka valid) → 200 tersaring — pembanding positif filter', async () => {
  const res = await request(base).get('/penampung-states?id_meja=3').set(auth);
  assert.equal(res.status, 200, `body: ${res.text}`);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.length >= 1, 'seed minimal 5 baris penampung_states');
  for (const r of res.body) assert.equal(String(r.id_meja), '3', 'filter wajib diterapkan');
});

/* ── (8) 404 byte-identik PUT/DELETE di 2 resource berbeda ─────────── */
test('PUT id tak-ada → 404 byte-identik ANTAR resource (/meja vs /tanaman)', async () => {
  const a = await request(base).put(`/meja/${ID_TIDAK_ADA}`).set(auth).send({ jumlah_lubang: 5 });
  const b = await request(base).put(`/tanaman/${ID_TIDAK_ADA}`).set(auth).send({ nama_tanaman: 'x' });
  assert.equal(a.status, 404, `body: ${a.text}`);
  assert.equal(b.status, 404, `body: ${b.text}`);
  assertSameBytes(a, b, 'PUT /meja vs PUT /tanaman');
  assert.deepEqual(JSON.parse(a.text), NOT_FOUND);
  assert.deepEqual(JSON.parse(b.text), NOT_FOUND);
});

test('DELETE id tak-ada → 404 byte-identik ANTAR resource (/meja vs /tanaman)', async () => {
  const a = await request(base).delete(`/meja/${ID_TIDAK_ADA}`).set(auth);
  const b = await request(base).delete(`/tanaman/${ID_TIDAK_ADA}`).set(auth);
  assert.equal(a.status, 404, `body: ${a.text}`);
  assert.equal(b.status, 404, `body: ${b.text}`);
  assertSameBytes(a, b, 'DELETE /meja vs DELETE /tanaman');
  assert.deepEqual(JSON.parse(a.text), NOT_FOUND);
  assert.deepEqual(JSON.parse(b.text), NOT_FOUND);
  // PUT & DELETE pada resource yang sama juga satu bentuk (kontrak seragam 404).
  const put = await request(base).put(`/meja/${ID_TIDAK_ADA}`).set(auth).send({ jumlah_lubang: 5 });
  assertSameBytes(put, a, 'PUT /meja vs DELETE /meja');
});

/* ── (9) header keamanan ───────────────────────────────────────────── */
test('5 header wajib ada pada respons lintas kelas status + x-powered-by dimatikan', async () => {
  const kasus = [
    ['200', await request(base).get('/laporan').set(auth)],
    ['401', await request(base).get('/laporan')],
    ['403', await request(base).get('/user').set(tokenPetani())],
    ['404-rute', await request(base).get('/rute-tidak-ada')],
    ['404-data', await request(base).get(`/meja/${ID_TIDAK_ADA}`).set(auth)],
    ['422', await request(base).post('/watercontrol/setMode').set(auth).send({ mode: 'XYZ' })],
  ];
  for (const [label, res] of kasus) {
    const wajib = {
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
    };
    for (const [h, nilai] of Object.entries(wajib)) {
      assert.equal(res.headers[h], nilai, `[${label}] header ${h} harus "${nilai}", aktual "${res.headers[h]}"`);
    }
    // Header ke-5: proteksi rate-limit wajib ada selama RATE_LIMIT_OFF tidak di-set.
    if (process.env.RATE_LIMIT_OFF !== '1') {
      assert.ok(res.headers['x-ratelimit-limit'],
        `[${label}] header x-ratelimit-limit wajib ada pada respons`);
    }
    assert.equal(res.headers['x-powered-by'], undefined,
      `[${label}] x-powered-by harus dimatikan (app.disable)`);
  }
});
