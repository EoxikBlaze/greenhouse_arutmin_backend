'use strict';
/**
 * Foto profil per akun: validasi murni (tanpa DB) supaya mudah dites.
 * Tipe ditentukan dari BYTE AWAL berkas (magic bytes), bukan dari header
 * Content-Type kiriman klien. SVG dan GIF sengaja ditolak (SVG bisa memuat skrip).
 */

/** Batas ukuran berkas (byte). Klien wajib mengecilkan gambar sebelum unggah. */
const BATAS_BYTE = 512 * 1024;

const TIPE_DIIZINKAN = ['image/png', 'image/jpeg', 'image/webp'];

/** @param {Buffer} b @returns {'image/png'|'image/jpeg'|'image/webp'|null} */
function deteksiTipe(b) {
  if (!Buffer.isBuffer(b) || b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
      && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/**
 * Hasil validasi unggahan.
 * @returns {{ok:true, tipe:string} | {ok:false, status:number, message:string}}
 */
function periksaUnggahan(body) {
  if (!Buffer.isBuffer(body) || body.length === 0) {
    return { ok: false, status: 415, message: 'Kirim berkas gambar PNG, JPEG, atau WebP sebagai isi permintaan.' };
  }
  if (body.length > BATAS_BYTE) {
    return { ok: false, status: 413, message: `Foto terlalu besar (maks ${BATAS_BYTE / 1024} KB). Kecilkan dulu.` };
  }
  const tipe = deteksiTipe(body);
  if (!tipe) {
    return { ok: false, status: 422, message: 'Berkas bukan gambar PNG, JPEG, atau WebP yang valid.' };
  }
  return { ok: true, tipe };
}

module.exports = { BATAS_BYTE, TIPE_DIIZINKAN, deteksiTipe, periksaUnggahan };
