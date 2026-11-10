'use strict';
/** Token "Ingat saya" (10 tahun) harus gugur bila akun hilang, level berubah, atau sandi diganti. */
const test = require('node:test');
const assert = require('node:assert');
const bcrypt = require('bcryptjs');
const { startServer, stopChild, craftToken, bearer } = require('./_server');
const { q, one } = require('../../src/db');
const { lewati } = require('./_isolasi');

const OPSI = { skip: lewati || false };

let srv; let id;
const NAMA = 'uji-token-panjang';
const SANDI = 'Sandi-Uji-1!';

test.before(async () => {
  if (lewati) return;
  srv = await startServer();
  await q('DELETE FROM users WHERE username = $1', [NAMA]);
  const r = await one(
    `INSERT INTO users (username, email, password, level, is_demo, created_at, updated_at)
     VALUES ($1, $2, $3, 'admin', false, now(), now()) RETURNING id`,
    [NAMA, `${NAMA}@uji.local`, await bcrypt.hash(SANDI, 4)],
  );
  id = r.id;
});

test.after(async () => {
  if (lewati) return;
  await q('DELETE FROM users WHERE username = $1', [NAMA]);
  await stopChild(srv.child);
});

const cek = (token) => fetch(`${srv.base}/api/ai/status`, { headers: bearer(token) }).then((r) => r.status);
const login = async () => {
  const r = await fetch(`${srv.base}/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: NAMA, password: SANDI }),
  });
  const j = await r.json();
  assert.ok(j.token, `login gagal: ${r.status} ${JSON.stringify(j)}`);
  return j.token;
};

test('token panjang hasil login diterima', OPSI, async () => {
  assert.notStrictEqual(await cek(await login()), 401);
});

test('token panjang tanpa sidik sandi / akun tidak ada / level palsu ditolak', OPSI, async () => {
  const dasar = { username: NAMA, level: 'admin', demo: false };
  assert.strictEqual(await cek(craftToken({ sub: id, ...dasar }, { expiresIn: '3650d' })), 401);
  assert.strictEqual(await cek(craftToken({ sub: 99999999, ...dasar, pv: 'x' }, { expiresIn: '3650d' })), 401);
});

test('token pendek tetap stateless', OPSI, async () => {
  assert.notStrictEqual(await cek(craftToken({ sub: id, username: NAMA, level: 'admin', demo: false }, { expiresIn: '10m' })), 401);
});

test('ganti sandi lewat API menggugurkan token panjang lama seketika', OPSI, async () => {
  const token = await login();
  const r = await fetch(`${srv.base}/user/${id}`, {
    method: 'PUT', headers: { ...bearer(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'Sandi-Baru-2!' }),
  });
  assert.strictEqual(r.status, 200, await r.text());
  assert.strictEqual(await cek(token), 401);
});
