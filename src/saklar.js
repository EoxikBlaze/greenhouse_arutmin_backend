'use strict';
/**
 * Saklar izin per aktuator (tabel saklar_aktuator).
 * OFF = otomasi (preset/jadwal/AI) TIDAK boleh menyalakan aktuator itu. Dosing manual tetap boleh (override).
 * Baris/tabel hilang = OFF (aman).
 */
const { q } = require('./db');

const KODE = ['nutrisi_ab', 'ph_up', 'ph_down', 'pengenceran', 'isi_air'];
/** larutan di perintah aktuator → kode saklar */
const SAKLAR_LARUTAN = { AB: 'nutrisi_ab', PH_UP: 'ph_up', PH_DOWN: 'ph_down' };

async function daftar(runner = q) {
  const rows = await runner(
    `SELECT s.kode, s.nama, s.aktif, s.diubah_pada, u.username AS diubah_oleh
       FROM saklar_aktuator s LEFT JOIN users u ON u.id = s.diubah_oleh ORDER BY s.kode`, []).catch(() => []);
  return rows.rows ?? rows;
}

/** true bila otomasi boleh menyalakan aktuator `kode`. */
async function otomasiBoleh(kode, runner = q) {
  const r = await runner('SELECT aktif FROM saklar_aktuator WHERE kode = $1', [kode]).catch(() => []);
  return (r.rows ?? r)[0]?.aktif === true;
}

/** Ubah satu saklar. Mengembalikan {sebelum, sesudah} (baris) atau null bila kode tak dikenal. */
async function ubah(kode, aktif, userId, runner = q) {
  if (!KODE.includes(kode)) return null;
  const lama = (await runner('SELECT kode, nama, aktif FROM saklar_aktuator WHERE kode = $1', [kode]).then((r) => r.rows ?? r))[0];
  if (!lama) return null;
  const baru = (await runner(
    `UPDATE saklar_aktuator SET aktif = $2, diubah_oleh = $3, diubah_pada = CURRENT_TIMESTAMP
      WHERE kode = $1 RETURNING kode, nama, aktif`, [kode, Boolean(aktif), userId]).then((r) => r.rows ?? r))[0];
  return { sebelum: lama, sesudah: baru };
}

module.exports = { KODE, SAKLAR_LARUTAN, daftar, otomasiBoleh, ubah };
