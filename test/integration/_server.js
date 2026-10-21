'use strict';
/**
 * Helper suite INTEGRASI API GARAP — buka/tutup server sungguhan untuk tiap file tes.
 *
 * Kebijakan (lihat mandat: JANGAN sentuh src/):
 *  1. src/index.js TIDAK mengekspor `app` (dia langsung listen saat dimuat), jadi tiap
 *     file tes men-spawn proses `node src/index.js` sendiri di PORT BEBAS hasil
 *     pilih-port-acak. Server live :8000 (proses lain) tidak pernah disentuh, sehingga
 *     tas rate-limit (per IP, in-memory) juga terpisah — 3 run beruntun tidak pernah
 *     saling mengunci.
 *  2. Kredensial admin dibaca dari .env (repo root) dan TIDAK PERNAH dicetak/disimpan
 *     ke mana pun selain variabel proses.
 *  3. Login DIBATASI: adminToken() hanya melakukan POST /login SEKALI per server
 *     (hasilnya di-cache sebagai Promise), sehingga jauh di bawah limit login bawaan
 *     (10/menit/IP) — dan tetap aman walau suite dijalankan berulang.
 *  4. Token untuk uji role (petani/demo) dan JWT cacat (tanpa exp / kedaluwarsa)
 *     ditandatangani SENDIRI dengan JWT_SECRET yang sama → nol login tambahan.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const request = require('supertest');

const ROOT = path.join(__dirname, '..', '..');
const START_TIMEOUT_MS = 30_000;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Port kosong — supaya 4 file tes bisa berjalan paralel tanpa bentrok EADDRINUSE. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Hati-hati mematikan anak proses: SIGTERM dulu, SIGKILL bila bandel. */
async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const t = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
    child.once('exit', () => { clearTimeout(t); resolve(); });
  });
}

/**
 * Spawn server GARAP di port bebas, tunggu sampai benar-benar menjawab.
 * @returns {Promise<{base:string, port:number, child:import('node:child_process').ChildProcess, log:()=>string, stop:()=>Promise<void>}>}
 */
async function startServer() {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1' };
  // Jangan warisi konteks test-runner ke server (dan jangan bawa flag --test).
  delete env.NODE_TEST_CONTEXT;
  if (/\B--test\b/.test(env.NODE_OPTIONS || '')) delete env.NODE_OPTIONS;

  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'index.js')], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let log = '';
  const cap = (chunk) => { log = (log + chunk.toString()).slice(-4000); };
  child.stdout.on('data', cap);
  child.stderr.on('data', cap);

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server keluar lebih awal (exit ${child.exitCode})\n${log}`);
    }
    let ok = false;
    try {
      const res = await request(base).get('/login');
      ok = res.status === 200;
    } catch { /* belum siap — coba lagi */ }
    if (ok) break;
    if (Date.now() > deadline) {
      await stopChild(child);
      throw new Error(`server tidak siap dalam ${START_TIMEOUT_MS}ms\n${log}`);
    }
    await delay(150);
  }

  return { base, port, child, log: () => log, stop: () => stopChild(child) };
}

/** Baca .env (parsing sama dengan src/config.js) — nilai TIDAK pernah dicetak. */
function readEnv() {
  const file = path.join(ROOT, '.env');
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const loginCache = new Map(); // base -> Promise<string(token)>

/**
 * Token admin ASLI lewat POST /login — dijalankan maksimal 1× per server (di-cache),
 * memakai kredensial .env tanpa pernah mencetaknya.
 */
function adminToken(base) {
  if (!loginCache.has(base)) {
    loginCache.set(base, (async () => {
      const env = readEnv();
      if (!env.ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD tidak ada di .env');
      const res = await request(base).post('/login')
        .send({ username: 'garap', password: env.ADMIN_PASSWORD });
      if (res.status !== 200 || !res.body.token) {
        throw new Error(`login admin gagal (status ${res.status})`);
      }
      return res.body.token;
    })());
  }
  return loginCache.get(base);
}

/** Tandatangani JWT sendiri (nol login) untuk uji role & token cacat. */
function craftToken(payload, opts = {}) {
  const { jwtSecret } = require('../../src/config');
  return jwt.sign(payload, jwtSecret, { algorithm: 'HS256', ...opts });
}

/** Header Authorization untuk supertest: .set(bearer(tok)). */
const bearer = (token) => ({ Authorization: `Bearer ${token}` });

module.exports = { ROOT, startServer, stopChild, readEnv, adminToken, craftToken, bearer, delay };
