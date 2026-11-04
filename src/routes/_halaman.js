'use strict';
/**
 * Paginasi daftar: ?limit (bawaan 200, 1..1000) dan ?offset (≥ 0).
 * Nilai ngawur (huruf, negatif, pecahan, 0) → bawaan, BUKAN 4xx, supaya klien lama tetap jalan.
 * Dipakai crudRouter({ paginasi: true }), GET /semai/selesai, dan GET /tanam.
 */
const { queryParam } = require('./_id');

const BAWAAN = 200;
const MAKS = 1000;
const MAKS_OFFSET = 1_000_000_000; // di atas ini OFFSET meluber bigint → 22003 → 500

const bulat = (v) => (/^\d{1,12}$/.test(String(v ?? '')) ? Number(v) : null);

/** @returns {{limit: number, offset: number}} */
function halaman(query, bawaan = BAWAAN) {
  const l = bulat(queryParam(query, 'limit'));
  const o = bulat(queryParam(query, 'offset'));
  return { limit: l >= 1 ? Math.min(l, MAKS) : bawaan, offset: Math.min(o ?? 0, MAKS_OFFSET) };
}

module.exports = { halaman, BAWAAN, MAKS };
