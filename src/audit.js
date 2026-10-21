'use strict';
/**
 * AUDIT TRAIL — pencatat aksi tulis penting ke tabel `audit_logs`
 * (tabel sudah ada di DB, sebelumnya 0 baris dan belum punya endpoint).
 *
 * Desain:
 *  1. SATU titik perekam: middleware `auditTrail` dipasang di src/index.js untuk
 *     SEMUA request. Ia HANYA menempel `res.on('finish')` — tidak pernah
 *     mengubah status maupun isi balasan, sehingga kontrak pesan tidak mungkin
 *     berubah karena fitur ini.
 *  2. Rute yang paham konteksnya menyiapkan `req.audit =
 *     { aksi, tabel, row_id, before, after, actor? }` (lihat routes/_crud.js,
 *     routes/user.js, routes/auth.js). Bila rute tidak menyiapkan apa pun,
 *     middleware memakai peta segmen-URL → tabel di bawah (upaya terbaik)
 *     supaya aksi tulis lain tetap meninggalkan jejak.
 *  3. Hanya dicatat bila SUKSES (2xx) dan metode tulis (POST/PUT/PATCH/DELETE).
 *     Pembacaan (termasuk GET /audit-logs sendiri) tidak pernah masuk log.
 *  4. Kegagalan pencatatan TIDAK PERNAH merusak request: seluruh galat
 *     ditangkap dan hanya masuk ke log server.
 *  5. Field rahasia TIDAK PERNAH ikut: password/hash/token/secret dihapus dari
 *     before_data & after_data (lihat RAHASIA) — nilai kata sandi tidak pernah
 *     tersimpan di log maupun terkirim ke klien.
 *  6. before/after diringkas (maksimal 40 kunci, teks dipotong 300 karakter)
 *     supaya jsonb kecil dan layar riwayat tetap terbaca.
 */
const crypto = require('crypto');
const net = require('net');
const { q } = require('./db');

/** Metode tulis yang dicatat. */
const TULIS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/**
 * Terjemahan metode → label aksi. NILAI HARUS huruf kecil: kolom
 * `aksi` di audit_logs punya CHECK enum huruf kecil
 * (create, update, delete, login, logout, login_failed, …) — lihat
 * audit_logs_aksi_check di PostgreSQL. Layar riwayat mengubahnya menjadi
 * label besar (CREATE/UPDATE/…) di sisi klien.
 */
const AKSI_METODE = { POST: 'create', PUT: 'update', PATCH: 'update', DELETE: 'delete' };

/**
 * Kunci data yang TIDAK BOLEH masuk log (dicocokkan terhadap nama kunci):
 * password, password_hash, *_hash, token, secret, api_key, credential, otp.
 * Kuncinya DIHAPUS dari salinan (bukan disembunyikan nilainya) —
 * "field rahasia tak ikut" harfiah.
 */
const RAHASIA = /(password|passwd|_hash$|^hash$|token|secret|api[_-]?key|credential|otp)/i;

const MAX_KUNCI = 40;
const MAX_TEKS = 300;
const MAX_ARRAY = 20;
const MAX_KEDALAMAN = 4;

/**
 * Peta segmen pertama URL → tabel asli (dipakai bila rute tidak menyiapkan
 * req.audit). Sumber: docs/DB_SCHEMA.md + information_schema live.
 * Sengaja TIDAK memuat rute berfrekuensi tinggi (monitoring/, api/ milik ESP32)
 * supaya log tidak banjir oleh telemetri sensor, dan TIDAK memuat rute yang
 * sudah menyiapkan req.audit sendiri (mis. /profil — aksinya 'update', bukan
 * 'create' sebagaimana ditebak dari metode POST).
 */
const PATH_KE_TABEL = {
  meja: 'mejas',
  tanaman: 'tanamen',
  siklus: 'sikluses',
  ambang: 'sensor_thresholds',
  semai: 'semais',
  peremajaan: 'peremajaans',
  pendewasaan: 'pendewasaans',
  panen: 'panens',
  user: 'users',
  'konfigurasi-dosis': 'konfigurasi_dosis',
  'timing-operasi': 'timing_operasi',
  'aturan-fail-safe': 'aturan_fail_safe',
  'jadwal-perawatan': 'jadwal_perawatan',
  'kalibrasi-sensor': 'kalibrasi_sensor',
  'mapping-channel': 'mapping_channel_esp32',
  'target-nutrisi': 'target_nutrisi',
  'penampung-states': 'penampung_states',
};

/** Potong teks panjang agar jsonb tetap ringkas. */
function potongTeks(v) {
  return v.length > MAX_TEKS ? `${v.slice(0, MAX_TEKS)}…` : v;
}

/**
 * Salin objek/array untuk disimpan sebagai jsonb: kunci rahasia DIHAPUS,
 * maksimal 40 kunci, teks dipotong 300 karakter, kedalaman maksimal 4.
 * @param {unknown} nilai data apa pun (bisa null/undefined/berkas mentah)
 * @param {number} dalam kedalaman rekursi saat ini
 * @returns {unknown|null} nilai siap-jsonb (null bila tidak ada isi)
 */
function ringkas(nilai, dalam = 0) {
  if (nilai === null || nilai === undefined) return null;
  // Date (created_at dsb.) — WAJIB di sini: tanpa cabang ini objek Date punya
  // 0 kunci enumerable sehingga jatuh ke `null` (chip "Created at: —").
  if (nilai instanceof Date) return Number.isNaN(nilai.getTime()) ? null : nilai.toISOString();
  const t = typeof nilai;
  if (t === 'string') return potongTeks(nilai);
  if (t === 'number' || t === 'boolean') return nilai;
  if (t !== 'object') return String(nilai);
  if (dalam >= MAX_KEDALAMAN) return '[terlalu dalam]';
  if (Array.isArray(nilai)) {
    const arr = nilai.slice(0, MAX_ARRAY).map((v) => ringkas(v, dalam + 1));
    if (nilai.length > MAX_ARRAY) arr.push(`…+${nilai.length - MAX_ARRAY} lagi`);
    return arr;
  }
  const keluar = {};
  let n = 0;
  for (const [k, v] of Object.entries(nilai)) {
    if (RAHASIA.test(k)) continue;             // field rahasia tak ikut
    if (n >= MAX_KUNCI) { keluar['…'] = `${MAX_KUNCI}+ kunci lain`; break; }
    keluar[k] = ringkas(v, dalam + 1);
    n += 1;
  }
  return n === 0 ? null : keluar;
}

/**
 * URL asli tanpa query. WAJIB memakai `originalUrl`: pada saat event `finish`,
 * `req.url`/`req.path` sudah tersisa potongan TERAKHIR yang di-strip sub-router
 * (POST /meja tampak sebagai '/'), sehingga rute & pemetaan tabel harus
 * dibaca dari originalUrl.
 */
function ruteAsli(req) {
  const u = typeof req.originalUrl === 'string' ? req.originalUrl : String(req.url || '/');
  const i = u.indexOf('?');
  return i === -1 ? u : u.slice(0, i);
}

/** IP aman untuk kolom inet (bila tidak valid → null, request tetap dicatat). */
function ipAman(ip) {
  const v = typeof ip === 'string' ? ip.trim() : '';
  return v && net.isIP(v) ? v : null;
}

/** Angka aman untuk kolom bigint actor_user_id (bila tidak ada → null). */
function idAman(pengguna) {
  const raw = pengguna?.sub ?? pengguna?.id;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Tulis SATU baris audit. Tidak pernah melempar galat (semua error ditangkap)
 * sehingga aman dipanggil dari handler `finish` tanpa `await` pun tanpa
 * membuat request gagal.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {{aksi: string, tabel?: string|null, row_id?: string|null,
 *          before?: unknown, after?: unknown, actor?: object|null,
 *          meta?: object|null}} entri
 */
async function tulisAudit(req, res, entri) {
  try {
    const pengguna = entri.actor || req.user || null;
    const actorId = idAman(pengguna);
    const aksi = String(entri.aksi);
    const tabel = entri.tabel ? String(entri.tabel) : null;
    const rowId = entri.row_id === null || entri.row_id === undefined ? null : String(entri.row_id);
    // CHECK audit_logs_target_check: create/update/delete WAJIB membawa tabel +
    // row_id. Tanpa keduanya baris mustahil disimpan — lewati (bukan error).
    if ((aksi === 'create' || aksi === 'update' || aksi === 'delete') && (!tabel || rowId === null)) return;
    // CHECK audit_logs_actor_tipe_check: hanya 'user' | 'system' | 'esp32' |
    // 'api_key' | 'anonymous'. Peran (admin/petani/demo) TIDAK muat di kolom ini
    // sehingga disimpan di meta.level.
    // CHECK audit_logs_user_check: actor_tipe 'user' wajib punya actor_user_id.
    const actorTipe = actorId ? 'user' : 'anonymous';
    const actorLabel = entri.actor?.label ?? req.user?.username ?? null;
    const level = entri.actor?.level ?? req.user?.level ?? null;
    const ua = typeof req.headers['user-agent'] === 'string'
      ? potongTeks(req.headers['user-agent']) : null;
    const meta = {
      rute: `${req.method} ${ruteAsli(req)}`,
      status: res.statusCode,
      ...(level ? { level } : {}),
      ...(entri.meta && typeof entri.meta === 'object' ? entri.meta : {}),
    };
    await q(
      `INSERT INTO audit_logs
         (actor_user_id, actor_tipe, actor_label, aksi, tabel, row_id,
          before_data, after_data, ip, user_agent, request_id, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        actorId,
        actorTipe,
        actorLabel,
        aksi,
        tabel,
        rowId,
        ringkas(entri.before),
        ringkas(entri.after),
        ipAman(req.ip),
        ua,
        crypto.randomUUID(),
        meta,
      ],
    );
  } catch (e) {
    // Pencatatan audit tidak boleh menggagalkan request apa pun.
    console.warn(`[audit] gagal mencatat ${req.method} ${ruteAsli(req)}: ${e.message}`);
  }
}

/**
 * Entri cadangan bila rute tidak menyiapkan `req.audit`: petakan segmen
 * pertama URL ke tabel + terjemahkan metode ke aksi. Mengembalikan null bila
 * segmen tidak dikenal (mis. rute ESP32/monitoring) → tidak dicatat.
 */
function entriDariRute(req) {
  const seg = ruteAsli(req).split('/').filter(Boolean)[0] || '';
  const tabel = PATH_KE_TABEL[seg];
  const aksi = AKSI_METODE[req.method];
  if (!tabel || !aksi) return null;
  const p = req.params || {};
  // row_id: param rute (:id/:param/:kode/:sensor); rute tulis tanpa param
  // memakai baris milik pemakai yang sedang login (baris dirinya sendiri).
  const rowId = p.id ?? p.param ?? p.kode ?? p.sensor
    ?? (req.user && req.user.sub !== undefined && req.user.sub !== null ? String(req.user.sub) : null);
  const badan = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
  const after = aksi === 'delete' ? null : ringkas(badan);
  // Tanpa isi perubahan yang bisa direkam → jangan membuat baris kosong yang
  // menyesatkan (kunci rahasia seperti password memang selalu dibuang).
  if (aksi !== 'delete' && after === null) return null;
  return {
    aksi,
    tabel,
    row_id: rowId === null || rowId === undefined ? null : String(rowId),
    before: null,
    after,
    meta: { sumber: 'peta-rute' },
  };
}

/**
 * Middleware pencatat audit — pasang SATU KALI di src/index.js.
 * Menempelkan listener `finish`: request tulis yang berakhir 2xx dicatat ke
 * audit_logs; sisanya dilewati. Balasan tidak pernah disentuh.
 */
function auditTrail(req, res, next) {
  if (!TULIS.has(req.method)) return next();
  res.on('finish', () => {
    if (res.statusCode < 200 || res.statusCode >= 300) return;
    const entri = req.audit || entriDariRute(req);
    if (!entri || !entri.aksi) return;
    void tulisAudit(req, res, entri);
  });
  next();
}

module.exports = { auditTrail, tulisAudit, ringkas, PATH_KE_TABEL };
