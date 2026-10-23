'use strict';
/**
 * API key per perangkat / per klien — hanya HASH (SHA-256) yang disimpan di DB.
 *
 * Format kunci : vsf_<prefix 8 hex>_<rahasia 48 hex>   (≈ 192 bit entropi)
 *   - prefix   : penanda publik untuk mencari baris (bukan rahasia, aman di log)
 *   - rahasia  : acak kuat → SHA-256 cukup (bukan password manusia, tak perlu bcrypt)
 * Verifikasi  : cari by prefix → bandingkan hash dgn timingSafeEqual.
 * Scope       : sensor:tulis · aktuator:perintah · data:baca
 * Keamanan    : kunci tampil SEKALI saat dibuat; dicabut/kedaluwarsa/nonaktif → 403;
 *               respons gagal selalu SAMA (tidak membocorkan kunci ada/tidaknya).
 */
const crypto = require('crypto');
const { q, one } = require('./db');

const SCOPE_VALID = ['sensor:tulis', 'aktuator:perintah', 'data:baca'];
const POLA_KUNCI = /^vsf_([0-9a-f]{8})_([0-9a-f]{48})$/;
const SCOPE_PERAN = {
  sensor: ['sensor:tulis', 'data:baca'],
  aktuator: ['aktuator:perintah'],
};

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/** Buat kunci baru (belum disimpan). */
function bangkitkanKunci() {
  const prefix = crypto.randomBytes(4).toString('hex');
  const rahasia = crypto.randomBytes(24).toString('hex');
  const kunci = `vsf_${prefix}_${rahasia}`;
  return { kunci, prefix, hash: sha256(kunci) };
}

/** Simpan kunci baru; mengembalikan {id, kunci, ...} — `kunci` hanya ada di sini. */
async function buatKunci({ nama, scope, perangkatKode = null, hariBerlaku = null }) {
  const salah = (scope || []).filter((s) => !SCOPE_VALID.includes(s));
  if (!scope?.length || salah.length) throw new Error(`scope tidak valid: ${salah.join(',') || '(kosong)'}`);
  const { kunci, prefix, hash } = bangkitkanKunci();
  const kedaluwarsa = hariBerlaku ? new Date(Date.now() + hariBerlaku * 86_400_000) : null;
  const row = await one(
    `INSERT INTO api_keys (nama, prefix, hash, scope, perangkat_kode, kedaluwarsa_pada)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, nama, prefix, scope, perangkat_kode, kedaluwarsa_pada, dibuat_pada`,
    [nama, prefix, hash, scope, perangkatKode, kedaluwarsa],
  );
  return { ...row, kunci };
}

/** Cek kunci mentah → baris api_keys (tanpa hash) atau null. Tidak melempar. */
async function cekKunci(mentah) {
  const m = POLA_KUNCI.exec(String(mentah ?? ''));
  if (!m) return null;
  const row = await one(
    `SELECT k.id, k.nama, k.prefix, k.hash, k.scope, k.perangkat_kode, k.aktif, k.kedaluwarsa_pada, k.dicabut_pada,
            COALESCE(p.aktif, true) AS perangkat_aktif
       FROM api_keys k LEFT JOIN perangkat p ON p.kode = k.perangkat_kode WHERE k.prefix = $1`,
    [m[1]],
  );
  // hitung hash walau baris tak ada → waktu respons seragam
  const hitung = Buffer.from(sha256(mentah), 'hex');
  const simpan = Buffer.from(row?.hash || '0'.repeat(64), 'hex');
  const cocok = crypto.timingSafeEqual(hitung, simpan) && !!row;
  if (!cocok || !row.aktif || !row.perangkat_aktif || row.dicabut_pada) return null;
  if (row.kedaluwarsa_pada && new Date(row.kedaluwarsa_pada).getTime() <= Date.now()) return null;
  delete row.hash;
  return row;
}

const TOLAK = { status: false, msg: 'Unauthorized' };

/**
 * Middleware: wajib header `X-API-KEY` berkunci perangkat/klien dengan scope tertentu.
 * Mengisi req.kunci ({id,nama,scope,perangkat_kode}). Gagal → 403 seragam.
 */
function requireKunci(scope) {
  return async (req, res, next) => {
    try {
      const mentah = req.headers['x-api-key'];
      const k = await cekKunci(mentah);
      if (!k || !k.scope.includes(scope)) return res.status(403).json(TOLAK);
      req.kunci = k;
      // catat pemakaian terakhir (tak menggagalkan request; ≤1×/30 dtk per kunci)
      const sekarang = Date.now();
      if (!requireKunci._terakhir) requireKunci._terakhir = new Map();
      if (sekarang - (requireKunci._terakhir.get(k.id) || 0) > 30_000) {
        requireKunci._terakhir.set(k.id, sekarang);
        q('UPDATE api_keys SET terakhir_dipakai = now(), ip_terakhir = $2 WHERE id = $1', [k.id, String(req.ip || '').slice(0, 45)])
          .catch(() => {});
      }
      return next();
    } catch (e) { return next(e); }
  };
}

module.exports = { SCOPE_VALID, SCOPE_PERAN, sha256, bangkitkanKunci, buatKunci, cekKunci, requireKunci };
