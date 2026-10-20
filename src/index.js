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
const { invalidBody, loadColumnLengths } = require('./routes/_validate');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: true })); // kompatibel form POST (seperti Laravel)

// Body JSON berupa SKALAR (null/angka/teks/boolean) adalah JSON VALID tetapi bukan
// objek — body-parser 'strict' menolaknya dengan entity.parse.failed. Dulu balasannya
// 400 'Format JSON tidak valid.' (dan di sebagian rute menyentuh jalur error lain);
// kini diseragamkan menjadi 422 terstruktur kontrak SEBELUM rute mana pun dijalankan,
// sehingga tidak ada rute yang pernah melihat body non-objek (mencegah 500 turunan).
// JSON yang benar-benar rusak TETAP 400 — error diteruskan ke handler global.
// Posisi: tepat setelah parser, supaya hanya error pembacaan body yang dijangkau.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err?.type === 'entity.parse.failed' && typeof err.body === 'string'
      && /json/i.test(String(req.headers['content-type'] || ''))) {
    try {
      const parsed = JSON.parse(err.body); // lolos JSON.parse → JSON valid (skalar)
      if (parsed === null || typeof parsed !== 'object') return invalidBody(res);
    } catch { /* JSON rusak — jatuh ke alur 400 biasa */ }
  }
  return next(err);
});

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

// ── TRUST PROXY (1 hop) ────────────────────────────────────────────────
// Deploy production menaruh nginx di depan backend (backend hanya bind
// 127.0.0.1). Tanpa pengaturan ini req.ip SELALU 127.0.0.1 sehingga SEMUA
// klien berbagi SATU bucket rate limit (11 login bisa mengunci semua orang
// 60 detik). Dengan 'trust proxy' = 1: akses langsung (tanpa X-Forwarded-For)
// req.ip tetap IP socket; di belakang nginx req.ip jadi entri TERAKHIR
// X-Forwarded-For (hop terdekat setelah hop yang dipercaya) — nginx memakai
// $proxy_add_x_forwarded_for (menambahkan IP klien di ujung kanan), sehingga
// entri terakhir = IP klien asli dan header kiriman klien tidak bisa dipakai
// untuk menyamar (diverifikasi uji: 'A, B' memakai bucket B).
app.set('trust proxy', 1);

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
const konfigurasi = require('./routes/konfigurasi');

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
// Guard tiap sub-rute ada di dalam modul (sama seperti master) — rute tak dikenal
// tetap 404 JSON.
app.use('/', konfigurasi);                             // /konfigurasi-dosis, /timing-operasi, /aturan-fail-safe, /jadwal-perawatan, /kalibrasi-sensor, /mapping-channel, /target-nutrisi, /penampung-states (skema V2)

/* ── 404 & error handler — JSON generik, TANPA stack trace ─────────── */
app.use((req, res) => {
  res.status(404).json({ message: `The route ${req.path} could not be found.` });
});

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  // Jangan pernah mencetak/merespons detail internal (stack, SQL, env) KE CLIENT —
  // stack hanya masuk log server (observabilitas): sebelumnya bug 500 tak pernah
  // muncul di log sehingga sulit ditelusuri; respon ke client tetap generik.
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ message: 'Format JSON tidak valid.' });
  }
  // G9b — jaring pengaman SQLSTATE: NOT NULL (23502) & CHECK (23514) yang masih
  // lolos dari validasi aplikasi (kasus baru/tak terduga) dijawab 422 per-field
  // kontrak §2, bukan 500 generik. Ekstraksi field memakai protokol PostgreSQL:
  // 23502 → err.column / pola 'column "..."' di message; 23514 → err.constraint
  // (mis. semais_status_check) dipotong prefix tabel + suffix _check. Bila gagal
  // diekstrak → jatuh ke jalur 500 lama (perilaku lama dipertahankan utk kasus
  // yang tidak terpetakan — jangan menebak field secara keliru).
  if (err?.code === '23502' || err?.code === '23514') {
    let field = null;
    if (err.code === '23502') {
      field = err.column || (/column "([^"]+)"/.exec(err.message || '') || [])[1] || null;
      if (field) {
        console.warn('[db->422]', err.code, err.table || '', field);
        return res.status(422).json({
          message: 'Data tidak valid.',
          errors: { [field]: [`Kolom ${field} wajib diisi.`] },
        });
      }
    } else if (err.constraint) {
      let f = String(err.constraint).replace(/_check$/, '');
      if (err.table && f.startsWith(`${err.table}_`)) f = f.slice(err.table.length + 1);
      if (f) {
        console.warn('[db->422]', err.code, err.table || '', err.constraint);
        return res.status(422).json({
          message: 'Data tidak valid.',
          errors: { [f]: [`Kolom ${f} tidak memenuhi aturan data.`] },
        });
      }
    }
  }
  const status = err.status || 500;
  // Label '[500]' HANYA untuk kegagalan server sungguhan (tanpa status atau ≥500),
  // supaya grep '[500]' di log selalu berarti 500 sejati. Error HTTP non-500 yang
  // melewati handler ini (mis. 413 PayloadTooLargeError dari express.json limit)
  // dicatat dengan label statusnya sendiri — dulu ikut tercatat sebagai '[500]'
  // sehingga tidak bisa dipercaya. Respon ke client TIDAK berubah.
  if (status >= 500) console.error('[500]', err.stack || err);
  else console.error(`[HTTP ${status}]`, err.stack || err);
  res.status(status).json({ message: 'Terjadi kesalahan pada server.' });
});

/* ── server (HTTP + HTTPS opsional) ────────────────────────────────── */
const http = require('http');
const httpServer = http.createServer(app);
// Tuning koneksi beban tinggi — cegah reset saat churn keep-alive 1000 user.
httpServer.keepAliveTimeout = 65_000;
httpServer.headersTimeout = 70_000;
httpServer.requestTimeout = 30_000;
httpServer.maxRequestsPerSocket = 0;

/**
 * Start listener SETELAH peta panjang kolom dari information_schema terbaca (atau
 * fallback aktif) — menjamin request PERTAMA sudah divalidasi dengan batas panjang
 * yang sinkron dengan DB live (lihat routes/_validate.loadColumnLengths). Query ini
 * hanya SELECT dan tidak pernah menolak startup (gagal → fallback).
 */
function startServers() {
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
}

loadColumnLengths()
  .then((map) => {
    console.log(map
      ? `Batas panjang teks  : ${Object.keys(map).length} kolom varchar dari information_schema`
      : 'Batas panjang teks  : information_schema gagal dibaca — memakai fallback batas spec');
  })
  .catch(() => { /* loadColumnLengths sudah menangkap errornya sendiri */ })
  .finally(startServers);
