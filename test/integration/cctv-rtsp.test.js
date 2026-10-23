'use strict';
/**
 * Kamera CCTV tipe 'rtsp' (EZVIZ H8C dkk.) — frame diambil server lewat ffmpeg.
 * ffmpeg diganti skrip palsu (CCTV_FFMPEG) agar tes tidak butuh kamera: URL berisi 'gagal' → keluar 1,
 * selain itu menulis JPEG kecil dan mencatat jumlah pemanggilan. Kamera uji dihapus lagi (net-zero).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const { startServer, adminToken, craftToken, bearer } = require('./_server');
const { q } = require('../../src/db');

const tokenPetani = () => bearer(craftToken({ sub: 3, username: 'petani', level: 'petani', demo: false }, { expiresIn: '1h' }));
const tokenDemo = () => bearer(craftToken({ sub: 2, username: 'demo', level: 'user', demo: true }, { expiresIn: '1h' }));

const KODE = 'ABCDEF';
const URL_RTSP = `rtsp://admin:${KODE}@192.168.1.60:554/ch1/main`;
let srv; let auth; let dir; let catatan;
const dibuat = [];

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cctv-uji-'));
  catatan = path.join(dir, 'panggilan.log');
  const palsu = path.join(dir, 'ffmpeg-palsu.js');
  fs.writeFileSync(palsu, `#!/usr/bin/env node
const fs = require('fs');
const url = process.argv[process.argv.indexOf('-i') + 1];
fs.appendFileSync(${JSON.stringify(catatan)}, url + '\\n');
if (url.includes('gagal')) { process.stderr.write('Connection refused ' + url + '\\n'); process.exit(1); }
process.stdout.write(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]));
`);
  fs.chmodSync(palsu, 0o755);
  process.env.CCTV_FFMPEG = palsu;
  srv = await startServer();
  auth = bearer(await adminToken(srv.base));
});

after(async () => {
  if (dibuat.length) await q('DELETE FROM cctv_kameras WHERE id = ANY($1::bigint[])', [dibuat]);
  await srv.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

const tambah = async (body) => {
  const r = await request(srv.base).post('/cctv').set(auth).send({ nama: 'Uji RTSP', tipe: 'rtsp', url: URL_RTSP, interval_detik: 5, ...body });
  if (r.status === 201) dibuat.push(r.body.data.id);
  return r;
};
const panggilan = () => (fs.existsSync(catatan) ? fs.readFileSync(catatan, 'utf8').trim().split('\n').filter(Boolean).length : 0);

test('rtsp: URL harus cocok dengan tipe', async () => {
  assert.equal((await tambah({ url: 'http://192.168.1.60/capture' })).status, 422);
  const r = await request(srv.base).post('/cctv').set(auth).send({ nama: 'X', tipe: 'snapshot', url: URL_RTSP });
  assert.equal(r.status, 422);
  assert.ok(r.body.errors.url);
  assert.equal((await tambah({ url: 'rtsp://' })).status, 422);
});

test('rtsp: sandi kamera tidak pernah dikirim ke browser', async () => {
  const c = await tambah({});
  assert.equal(c.status, 201, c.text);
  assert.equal(c.body.data.url, 'rtsp://admin:***@192.168.1.60:554/ch1/main');
  const id = String(c.body.data.id);
  const admin = (await request(srv.base).get('/cctv').set(auth)).body.list.find((k) => String(k.id) === id);
  assert.equal(admin.url, 'rtsp://admin:***@192.168.1.60:554/ch1/main');
  for (const t of [tokenPetani(), tokenDemo()]) {
    const r = await request(srv.base).get('/cctv').set(t);
    assert.ok(!r.text.includes(KODE), 'kode verifikasi bocor ke non-admin');
    assert.equal(r.body.list.find((k) => String(k.id) === id).url, null);
  }
});

test('rtsp: form ubah mengirim *** → sandi tersimpan dipertahankan; sandi baru menggantikan', async () => {
  const id = (await tambah({})).body.data.id;
  const u = await request(srv.base).put(`/cctv/${id}`).set(auth).send({ url: 'rtsp://admin:***@192.168.1.61:554/ch1/sub' });
  assert.equal(u.status, 200, u.text);
  assert.equal((await q('SELECT url FROM cctv_kameras WHERE id = $1', [id]))[0].url, `rtsp://admin:${KODE}@192.168.1.61:554/ch1/sub`);
  await request(srv.base).put(`/cctv/${id}`).set(auth).send({ url: 'rtsp://admin:ZZZZZZ@192.168.1.61:554/ch1/sub' });
  assert.equal((await q('SELECT url FROM cctv_kameras WHERE id = $1', [id]))[0].url, 'rtsp://admin:ZZZZZZ@192.168.1.61:554/ch1/sub');
  // ganti tipe ke snapshot tanpa URL http → ditolak
  assert.equal((await request(srv.base).put(`/cctv/${id}`).set(auth).send({ tipe: 'snapshot' })).status, 422);
});

test('rtsp: GET /cctv/:id/gambar → JPEG untuk semua peran yang login, dengan cache', async () => {
  const id = (await tambah({ url: 'rtsp://admin:ABCDEF@192.168.1.70:554/ch1/main' })).body.data.id;
  assert.equal((await request(srv.base).get(`/cctv/${id}/gambar`)).status, 401);
  const sebelum = panggilan();
  const r = await request(srv.base).get(`/cctv/${id}/gambar`).set(tokenPetani()).buffer(true).parse((res, cb) => {
    const k = []; res.on('data', (d) => k.push(d)); res.on('end', () => cb(null, Buffer.concat(k)));
  });
  assert.equal(r.status, 200, String(r.body));
  assert.equal(r.headers['content-type'], 'image/jpeg');
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.deepEqual([...r.body.subarray(0, 2)], [0xff, 0xd8]);
  assert.equal((await request(srv.base).get(`/cctv/${id}/gambar`).set(tokenDemo())).status, 200);
  assert.equal(panggilan() - sebelum, 1, 'penonton berikutnya harus memakai frame dari cache');
});

test('rtsp: kamera mati → 502 tanpa membocorkan URL/sandi; tipe lain 404; nonaktif 409', async () => {
  const mati = (await tambah({ url: 'rtsp://admin:RAHASIA@192.168.1.99:554/gagal' })).body.data.id;
  const r = await request(srv.base).get(`/cctv/${mati}/gambar`).set(auth);
  assert.equal(r.status, 502);
  assert.ok(!r.text.includes('RAHASIA') && !r.text.includes('192.168.1.99'));
  const http = await request(srv.base).post('/cctv').set(auth).send({ nama: 'ESP32-CAM', tipe: 'snapshot', url: 'http://192.168.1.50/capture' });
  dibuat.push(http.body.data.id);
  assert.equal((await request(srv.base).get(`/cctv/${http.body.data.id}/gambar`).set(auth)).status, 404);
  const off = (await tambah({ aktif: false })).body.data.id;
  assert.equal((await request(srv.base).get(`/cctv/${off}/gambar`).set(auth)).status, 409);
  assert.equal((await request(srv.base).get('/cctv/abc/gambar').set(auth)).status, 404);
});
