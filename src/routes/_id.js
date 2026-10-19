'use strict';
/**
 * Validasi path param :id — SATU sumber kebenaran.
 *
 * Sebelumnya konstanta dan helper ini diduplikasi di 4 file (routes/_crud.js,
 * routes/tahap.js, routes/tanam.js, routes/user.js) sehingga rentan drift:
 * satu file diubah, yang lain tertinggal. Semua definisi lokal kini dihapus dan
 * di-require dari sini — perilaku keluaran TIDAK berubah (predikat dan body 404
 * persis sama seperti definisi lama di tiap file).
 *
 * Catatan kontrak (lihat docs/KONTRAK_API.md):
 *  - Id non-angka ATAU melebihi rentang bigint Postgres menjawab 404 PERSIS
 *    sama dengan id yang tidak ada (anti-enumeration), dicek di DEPAN query
 *    supaya tidak pernah menyentuh DB (dulu → 500 SQLSTATE 22003 / "invalid
 *    input syntax for bigint").
 *  - Pola /^[0-9]+$/ dipertahankan (bukan {1,19}) supaya id valid ber-nol-depan
 *    (mis. "007") tetap diterima seperti sebelumnya.
 */

/** Batas maksimum bigint signed Postgres (int8). */
const BIGINT_MAX = 9223372036854775807n;

/**
 * Predikat untuk sebuah string id: hanya digit dan masih dalam rentang bigint.
 * @param {unknown} str kandidat id (dipakai persis seperti definisi lama:
 *   RegExp#test meng-ToString argumennya, sehingga perilaku identik).
 * @returns {boolean}
 */
function idValidValue(str) {
  return /^[0-9]+$/.test(str) && BigInt(str) <= BIGINT_MAX;
}

/** Predikat validasi id dari path param: idValid(req). */
const idValid = (req) => idValidValue(req && req.params ? req.params.id : undefined);

/** Balasan 404 seragam untuk id tidak valid maupun data yang tidak ada. */
const notFound = (res) => res.status(404).json({ message: 'Data tidak ditemukan.', errors: {} });

module.exports = { BIGINT_MAX, idValid, idValidValue, notFound };
