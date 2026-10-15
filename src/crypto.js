'use strict';
/**
 * Enkripsi data at-rest — TINGKAT TINGGI.
 * - ENKRIPSI BARU: AES-256-GCM (authenticated encryption, IV acak per nilai)
 *   format: "gcm." + base64(iv | auth-tag | ciphertext)
 * - DEKRIPSI: mendukung format GCM baru DAN format lama kompatibel Laravel
 *   (AES-256-CBC + HMAC-SHA256) supaya data existing tetap terbaca.
 * Kunci: base64 APP_KEY (prefix "base64:" dibuang) — turunan SHA-256 bila kosong.
 */
const crypto = require('crypto');
const config = require('./config');

function key() {
  // APP_KEY Laravel berformat "base64:XXXX" — buang prefix-nya sebelum decode.
  const raw = Buffer.from(String(config.appKey || '').replace(/^base64:/, ''), 'base64');
  if (raw.length !== 32) {
    return crypto.createHash('sha256').update(config.jwtSecret).digest();
  }
  return raw;
}

/* ── format baru: AES-256-GCM (AEAD) ───────────────────────────────── */
function encrypt(plaintext) {
  const iv = crypto.randomBytes(12); // 96-bit IV standar GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag(); // 16 byte
  return 'gcm.' + Buffer.concat([iv, tag, ct]).toString('base64');
}

function decryptGcm(payload) {
  const buf = Buffer.from(payload.slice(4), 'base64');
  if (buf.length < 12 + 16 + 1) return null;
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  // tag salah / data dimanipulasi → melempar exception → ditangkap decrypt()
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/* ── format lama kompatibel Laravel (AES-256-CBC + HMAC) ───────────── */
function mac(ivB64, valueB64) {
  return crypto.createHmac('sha256', key()).update(ivB64 + valueB64).digest('hex');
}

function decryptLegacy(payload) {
  const json = JSON.parse(Buffer.from(String(payload), 'base64').toString('utf8'));
  const { iv, value, mac: tag } = json;
  const expected = mac(iv, value);
  const a = Buffer.from(tag, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const decipher = crypto.createDecipheriv('aes-256-cbc', key(), Buffer.from(iv, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(value, 'base64')), decipher.final()]).toString('utf8');
}

/** Dekripsi — otomatis deteksi format (GCM baru / CBC lama). */
function decrypt(payload) {
  if (!payload) return null;
  const s = String(payload);
  try {
    return s.startsWith('gcm.') ? decryptGcm(s) : decryptLegacy(s);
  } catch {
    return null;
  }
}

module.exports = { encrypt, decrypt };
