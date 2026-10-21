'use strict';
/**
 * Autentikasi & otorisasi — JWT (HS256) + bcrypt (kompatibel hash Laravel).
 * Guard meniru Laravel: PetaniGuard, DemoGuard, X-API-KEY untuk ESP32.
 */
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('./config');
const { q, one } = require('./db');

/* ── JWT_SECRET — wajib eksplisit (S10: gagal-loud, bukan fallback) ── *
 * fallback historis 'dev-secret-ganti' (dan nilai 'dev-secret-ganti' apa pun
 * yang sengaja/tidak terisi di .env) DITOLAK: secret publik = siapa pun bisa
 * menandatangani token admin. KEPUTUSAN: THROW saat start (fail-fast), BUKAN
 * secret acak proses — alasan: (a) secret acak membatalkan semua token di
 * SETIAP restart (pengguna keluar tiap deploy/restart — saat peresmian itu
 * terlihat sebagai bug), (b) proses kedua (worker/uji eksternal) tidak akan
 * pernah bisa memverifikasi token yang sama, (c) kegagalan konfigurasi harus
 * terdengar keras sekali di log, bukan disembunyikan oleh "kerja tapi aneh".
 * Nilai .env yang ada TIDAK berubah perilaku: dipakai persis apa adanya
 * (tanpa trim) sehingga token yang ditandatangani pihak lain — mis. craftToken
 * di test/integration/_server.js — tetap cocok.
 */
const FALLBACK_JWT_SECRET = 'dev-secret-ganti';

function resolveJwtSecret() {
  const raw = typeof config.jwtSecret === 'string' ? config.jwtSecret : '';
  const nilai = raw.trim();
  if (!nilai || nilai === FALLBACK_JWT_SECRET) {
    throw new Error(
      'JWT_SECRET tidak diatur — server MENOLAK start (fallback \'dev-secret-ganti\' sudah tidak dipakai, '
      + 'karena secret publik membolehkan siapa pun menandatangani token admin). '
      + 'Isi JWT_SECRET (≥32 karakter acak) di .env, lalu restart. Contoh pembuat nilai: '
      + 'node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))" '
      + 'Catatan: token lama yang ditandatangani fallback TIDAK akan sah setelah secret baru diisi.',
    );
  }
  if (nilai.length < 32) {
    // Peringatan saja (tidak menggagalkan) — secret lama yang valid jangan
    // sampai mematikan deploy yang sudah jalan.
    console.warn('[SECURITY] JWT_SECRET <32 karakter — disarankan ≥32 karakter acak (mis. randomBytes(48).base64url).');
  }
  return raw; // persis nilai env (tanpa trim) → identik dgn pemakaian luar
}

const JWT_SECRET = resolveJwtSecret();

/* ── token ─────────────────────────────────────────────────────────── */
function signToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username, level: user.level, demo: !!user.is_demo },
    JWT_SECRET,
    { expiresIn: '12h' },
  );
}

function verifyToken(token) {
  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    // Wajib klaim exp: token yang dibuat tanpa masa berlaku DITOLAK (dulu 200),
    // token kedaluwarsa tetap ditolak oleh jsonwebtoken (TokenExpiredError).
    if (!payload || typeof payload.exp !== 'number') return null;
    return payload;
  } catch {
    return null;
  }
}

/* ── middleware ────────────────────────────────────────────────────── */
function json(res, status, body) {
  return res.status(status).json(body);
}

/** Wajib login (Authorization: Bearer). */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = token && verifyToken(token);
  if (!payload) return json(res, 401, { message: 'Tidak terautentikasi.' });
  req.user = payload;
  next();
}

/**
 * Batasi role. allow: 'all' | ['admin','demo'] | ['admin'].
 * Petani selalu diblokir dari menu pengelola (kontrak PetaniGuard).
 */
function requireRole(allow) {
  return (req, res, next) => {
    const { level, demo } = req.user;
    if (allow === 'all') return next();
    if (level === 'petani') {
      return json(res, 403, { message: 'Menu ini untuk pengelola. Silakan gunakan menu "Tanam Saya".' });
    }
    if (demo || level === 'admin') return next();
    return json(res, 403, { message: 'Akses ditolak.' });
  };
}

/**
 * Demo = admin read-only tulis: hanya boleh aksi TERTENTU (lihat analisis §4).
 * Daftar ini berlaku untuk metode TULIS POST — lihat demoGuard().
 */
const DEMO_BOLEH_TAMBAH = new Set([
  'meja.store', 'tanaman.store', 'siklus.store', 'semai.store',
  'peremajaan.store', 'pendewasaan.store', 'panen.store',
  'tanam.mulai', 'tanam.selesai',
]);

/**
 * Demo HANYA boleh menambah (POST). Rute CRUD memasang guard ini lewat
 * router.use('/x', demoGuard('x.store'), crudRouter(...)) sehingga routeName
 * '*.store' IKUT menaungi PUT/PATCH/DELETE — dulu metode ubah/hapus untuk token
 * demo diterima 200 (bug: PUT/PATCH/DELETE /meja demo). Kini metode tulis selain
 * POST selalu 403 kontrak, apa pun routeName-nya; metode baca (GET/HEAD/OPTIONS)
 * tetap lolos. Rute yang routeName-nya tidak ada di DEMO_BOLEH_TAMBAH tetap 403
 * untuk POST seperti sebelumnya (pesan identik, tidak berubah).
 */
function demoGuard(routeName) {
  return (req, res, next) => {
    if (!req.user.demo) return next();
    const method = req.method.toUpperCase();
    const write = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
    if (!write) return next();
    const ok = method === 'POST' && DEMO_BOLEH_TAMBAH.has(routeName);
    if (!ok) {
      return json(res, 403, {
        message: 'Mode demo hanya boleh menambah data sementara (otomatis terhapus ± 1 jam).',
      });
    }
    next();
  };
}

/**
 * API key perangkat ESP32 (header X-API-KEY / field api_key).
 *
 * HARDENING (S3-sejalan): bila key AKTIF kosong ATAU sama dgn fallback
 * historis 'HARVEST123' (nilai default config.js yang tidak boleh dianggap
 * rahasia), guard TIDAK PERNAH menerima — semua permintaan ditolak 403
 * dgn body kontrak yang SAMA persis (tanpa bocor info) + peringatan log.
 * Dulu: key kosong → '' cocok dgn '' (tanpa header pun lolos!), dan
 * 'HARVEST123' diterima siapa pun yang tahu default publik.
 * Perbaikan dilakukan DI SINI (bukan di config.js) agar fallback di config
 * tetap utuh untuk konsumen lain sementara endpoint jadi gagal-loud.
 */
const FALLBACK_ESP32_KEY = 'HARVEST123';
let lastKeyWarn = 0;

function esp32KeyAktifTidakAman() {
  const aktif = typeof config.esp32ApiKey === 'string' ? config.esp32ApiKey.trim() : '';
  return !aktif || aktif === FALLBACK_ESP32_KEY;
}

function warnKeyTidakAman() {
  if (Date.now() - lastKeyWarn < 60_000) return; // jangan banjir log (rate-limit 1/menit)
  lastKeyWarn = Date.now();
  console.warn(
    "[SECURITY] ESP32_API_KEY kosong atau masih memakai fallback 'HARVEST123' — "
    + 'SEMUA permintaan ber-X-API-KEY ditolak 403. Isi ESP32_API_KEY unik di .env lalu restart; '
    + 'kirim ulang key baru ke perangkat ESP32.',
  );
}

function requireApiKey(req, res, next) {
  if (esp32KeyAktifTidakAman()) {
    warnKeyTidakAman();
    return json(res, 403, { status: false, msg: 'Unauthorized' });
  }
  const key = req.headers['x-api-key'] || req.body?.api_key;
  // perbandingan timing-safe (anti timing-attack)
  const a = Buffer.from(String(key ?? ''));
  const b = Buffer.from(String(config.esp32ApiKey ?? ''));
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) {
    return json(res, 403, { status: false, msg: 'Unauthorized' });
  }
  next();
}

/* ── data demo ─────────────────────────────────────────────────────── */
/** Tandai baris data demo agar terhapus otomatis 1 jam (expires_at). */
function demoExpiry(user) {
  return user?.demo ? new Date(Date.now() + 60 * 60 * 1000) : null;
}

let lastPurge = 0;
/** Purge data demo kedaluwarsa (1×/menit, urutan anak → induk). */
async function demoPurge() {
  if (Date.now() - lastPurge < 60_000) return;
  lastPurge = Date.now();
  try {
    for (const t of ['panens', 'pendewasaans', 'peremajaans', 'semais', 'sikluses', 'tanamen', 'mejas']) {
      await q(`DELETE FROM ${t} WHERE expires_at IS NOT NULL AND expires_at <= now()`);
    }
  } catch {
    /* jangan pernah menggagalkan request karena purge */
  }
}

/* ── helper user ───────────────────────────────────────────────────── */
function publicUser(row) {
  if (!row) return null;
  return { id: row.id, username: row.username, email: row.email, level: row.level, is_demo: !!row.is_demo };
}

/**
 * Hash DUMMY tetap (bcrypt cost 12 = cost yang dipakai seluruh baris users di
 * DB) — dibuat SEKALI di modul dari string acak. Dipakai saat user TIDAK ADA
 * supaya waktu verifyLogin kasus "user tak ada" sama dengan kasus "password
 * salah" (menutup enumerasi username lewat timing; dulu 0,8 ms vs 260 ms).
 * Nilai tidak pernah dibandingkan dengan data mana pun, hanya menahan waktu.
 */
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 12);

async function verifyLogin(username, password) {
  const user = await one(
    'SELECT * FROM users WHERE username = lower(trim($1)) LIMIT 1',
    [String(username || '')],
  );
  if (!user) {
    // Jalankan bcrypt.compare terhadap hash dummy dulu → waktu kasus ini
    // ~= kasus password salah, lalu tetap return null (pesan 422 identik).
    await bcrypt.compare(String(password || ''), DUMMY_HASH);
    return null;
  }
  // Hash Laravel memakai prefix $2y$ — bcryptjs mengenali $2b$; normalisasi dulu.
  const hash = String(user.password).replace(/^\$2y\$/, '$2b$');
  const ok = await bcrypt.compare(String(password || ''), hash);
  return ok ? user : null;
}

module.exports = {
  signToken,
  verifyToken,
  requireAuth,
  requireRole,
  demoGuard,
  requireApiKey,
  demoExpiry,
  demoPurge,
  publicUser,
  verifyLogin,
  json,
};
