'use strict';
/**
 * Bukti isolasi DB untuk tes integrasi yang menulis ke database (Fase 3F).
 * Tes hanya jalan bila DATABASE_URL menunjuk database bernama `garap_uji*` DAN host loopback (mesin ini).
 * Nama saja tidak cukup: DB bernama garap_uji* di host lain (mis. Raspberry Pi) ditolak.
 * Mengembalikan `lewati` = false (boleh jalan) atau teks alasan (dilewati).
 */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function periksa(env = process.env) {
  let url;
  try { url = new URL(env.DATABASE_URL || ''); } catch { return { namaDb: '', lewati: 'DATABASE_URL tidak diisi atau tidak sah' }; }
  const namaDb = url.pathname.slice(1);
  if (!namaDb.startsWith('garap_uji')) return { namaDb, lewati: `hanya untuk DB uji garap_uji* (sekarang: ${namaDb || 'dari .env'})` };
  if (!LOOPBACK.has(url.hostname)) return { namaDb, lewati: `host DB bukan loopback (${url.hostname}); tes DB hanya di mesin lokal` };
  return { namaDb, lewati: false };
}

module.exports = { ...periksa(), periksa };
