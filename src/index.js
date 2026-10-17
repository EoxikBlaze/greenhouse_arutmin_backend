'use strict';
/**
 * GARAP — Backend API (Node.js/Express).
 * Aturan:
 *  1. JSON-ONLY — tidak pernah mengirim HTML/teks mentah; error JSON generik TANPA stack trace.
 *  2. Tidak ada print/log data sensitif ke output web (rahasia hanya di .env & DB ter-enskripsi).
 *  3. Bind 127.0.0.1 — backend tidak terjangkau dari luar (diakses via proxy frontend).
 *  4. HTTPS opsional (self-signed) — jalankan dengan HTTPS=1.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { demoPurge, requireAuth, requireRole } = require('./auth');
const { rateLimit } = require('./rateLimit');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: true })); // kompatibel form POST (seperti Laravel)

// Header keamanan minimal (tanpa dependensi)
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// BACKEND TANPA TAMPILAN SAMA SEKALI: request navigasi browser
// (dibuka langsung dari address bar) dibalas KOSONG (204) — tidak ada
// HTML, tidak ada JSON, tidak ada apa pun yang tercetak di browser.
// API client (fetch/axios/ESP32, Accept: json / Sec-Fetch-Mode: cors) tetap normal.
app.use((req, res, next) => {
  if (req.method === 'GET' && req.get('sec-fetch-mode') === 'navigate') {
    return res.status(204).end();
  }
  next();
});

// ── PEMBATAS ANTI-SPAM (per IP) ────────────────────────────────────────
// Nilai bisa dioverride via env (RATE_LIMIT_VIEW/WRITE/LOGIN) atau dimatikan
// untuk benchmark (RATE_LIMIT_OFF=1 — mensimulasikan 1000 IP berbeda).
if (process.env.RATE_LIMIT_OFF !== '1') {
  const rlView = Number(process.env.RATE_LIMIT_VIEW || 300);
  const rlWrite = Number(process.env.RATE_LIMIT_WRITE || 60);
  const rlLogin = Number(process.env.RATE_LIMIT_LOGIN || 10);
  app.use(rateLimit({ name: 'view', max: rlView, methods: ['GET', 'HEAD'] }));         // GET / view: 300/menit
  app.use('/login', rateLimit({ name: 'login', max: rlLogin, methods: ['POST'] }));    // anti brute-force: 10/menit
  app.use(rateLimit({ name: 'write', max: rlWrite, methods: ['POST', 'PUT', 'PATCH', 'DELETE'] })); // tulis: 60/menit
}

// Purge data demo otomatis (ringan, 1×/menit)
app.use((_req, _res, next) => { demoPurge(); next(); });

/* ── routing (path 1:1 dengan kontrak Laravel — lihat docs/BACKEND_ANALYSIS.md) ── */
const authRouter = require('./routes/auth');
const dashboard = require('./routes/dashboard');
const monitoring = require('./routes/monitoring');
const watercontrol = require('./routes/watercontrol');
const tanam = require('./routes/tanam');
const master = require('./routes/master');
const tahap = require('./routes/tahap');
const laporan = require('./routes/laporan');
const profil = require('./routes/profil');
const user = require('./routes/user');
const notifWa = require('./routes/notifWa');

app.use('/', authRouter);                              // publik: /, /login, /logout
app.use('/api', monitoring.api);                       // ESP32 (guard X-API-KEY per route)
app.use('/monitoring', monitoring.router);             // campur publik/terproteksi (per route)

const semuaRole = [requireAuth, requireRole('all')];
const adminDemo = [requireAuth, requireRole(['admin', 'demo'])];

app.use('/dashboard', ...semuaRole, dashboard);
app.use('/tanam', ...semuaRole, tanam);
app.use('/profil', ...semuaRole, profil);
app.use('/watercontrol', ...adminDemo, watercontrol);
app.use('/laporan', ...adminDemo, laporan);
app.use('/notifikasi-wa', ...adminDemo, notifWa);
app.use('/user', ...adminDemo, user);
// Guard role sudah ada di dalam modul master/tahap (per sub-router) — tanpa
// wrapper di sini agar rute tak dikenal tetap 404 JSON (bukan 401).
app.use('/', master);                                  // /meja, /tanaman, /siklus, /ambang
app.use('/', tahap);                                   // /semai, /peremajaan, /pendewasaan, /panen

/* ── 404 & error handler — JSON generik, TANPA stack trace ─────────── */
app.use((req, res) => {
  res.status(404).json({ message: `The route ${req.path} could not be found.` });
});

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  // Jangan pernah mencetak/merespons detail internal (stack, SQL, env).
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ message: 'Format JSON tidak valid.' });
  }
  res.status(err.status || 500).json({ message: 'Terjadi kesalahan pada server.' });
});

/* ── server (HTTP + HTTPS opsional) ────────────────────────────────── */
const http = require('http');
const httpServer = http.createServer(app);
// Tuning koneksi beban tinggi — cegah reset saat churn keep-alive 1000 user.
httpServer.keepAliveTimeout = 65_000;
httpServer.headersTimeout = 70_000;
httpServer.requestTimeout = 30_000;
httpServer.maxRequestsPerSocket = 0;
httpServer.listen(config.port, config.host, () => {
  // hanya satu baris konfirmasi — tanpa data sensitif
  console.log(`GARAP API (HTTP)  : http://${config.host}:${config.port}`);
});

if (config.https) {
  const https = require('https');
  const certDir = path.join(__dirname, '..', 'certs');
  const keyPath = path.join(certDir, 'selfsigned.key');
  const certPath = path.join(certDir, 'selfsigned.crt');
  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    console.log('HTTPS diminta tapi cert belum ada — generate dengan:');
    console.log(`  mkdir -p ${certDir} && openssl req -x509 -newkey rsa:2048 -nodes -keyout ${keyPath} -out ${certPath} -days 365 -subj "/CN=localhost"`);
  } else {
    https.createServer({
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    }, app).listen(config.port + 443, config.host, () => {
      console.log(`GARAP API (HTTPS) : https://${config.host}:${config.port + 443}`);
    });
  }
}
