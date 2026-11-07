'use strict';
/**
 * Sesi web lewat cookie HttpOnly + perlindungan CSRF (double-submit).
 * Bearer tetap dipakai Flutter/alat; cookie hanya untuk browser (login dengan sesi:'cookie').
 * Tanpa dependensi cookie-parser: kita hanya membaca dua cookie bernama tetap.
 */
const crypto = require('crypto');

const NAMA_SESI = 'vsf_sesi';
const NAMA_CSRF = 'vsf_csrf';
const MASA_DETIK = 12 * 60 * 60; // masa default (12 jam)
const MASA_INGAT_DETIK = 3650 * 24 * 60 * 60; // masa "Ingatkan saya" (10 tahun)
const METODE_AMAN = new Set(['GET', 'HEAD', 'OPTIONS']);

function bacaCookie(req, nama) {
  const raw = req.headers.cookie || '';
  for (const bagian of raw.split(';')) {
    const i = bagian.indexOf('=');
    if (i > 0 && bagian.slice(0, i).trim() === nama) {
      try { return decodeURIComponent(bagian.slice(i + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

function lewatTls(req) {
  return req.secure === true || req.get('x-forwarded-proto') === 'https';
}

function atribut(req, httpOnly, maxAge) {
  return `Path=/; Max-Age=${maxAge}; SameSite=Strict${httpOnly ? '; HttpOnly' : ''}${lewatTls(req) ? '; Secure' : ''}`;
}

/** Pasang cookie sesi (HttpOnly) + cookie CSRF (terbaca JS agar bisa dikirim balik sebagai header). */
function pasangSesi(req, res, token, remember = false) {
  const masa = remember ? MASA_INGAT_DETIK : MASA_DETIK;
  const csrf = crypto.randomBytes(24).toString('base64url');
  res.append('Set-Cookie', `${NAMA_SESI}=${encodeURIComponent(token)}; ${atribut(req, true, masa)}`);
  res.append('Set-Cookie', `${NAMA_CSRF}=${csrf}; ${atribut(req, false, masa)}`);
}

function hapusSesi(req, res) {
  res.append('Set-Cookie', `${NAMA_SESI}=; ${atribut(req, true, 0)}`);
  res.append('Set-Cookie', `${NAMA_CSRF}=; ${atribut(req, false, 0)}`);
}

function samaAman(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Header X-CSRF-Token wajib sama dengan cookie vsf_csrf untuk metode yang mengubah data. */
function csrfCocok(req) {
  if (METODE_AMAN.has(req.method.toUpperCase())) return true;
  return samaAman(req.get('x-csrf-token'), bacaCookie(req, NAMA_CSRF));
}

module.exports = { NAMA_SESI, NAMA_CSRF, bacaCookie, pasangSesi, hapusSesi, csrfCocok };
