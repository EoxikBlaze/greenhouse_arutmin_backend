'use strict';
/**
 * CRUD generik — menggantikan Route::resource() Laravel (path 1:1, JSON-only).
 *   GET /x           → daftar (opsional ?q= search sederhana)
 *   POST /x          → tambah (roleName.store)
 *   GET /x/:id       → detail
 *   PUT|PATCH /x/:id → ubah (roleName.update)
 *   DELETE /x/:id    → hapus (roleName.destroy)
 */
const express = require('express');
const { q, one } = require('../db');
const { demoExpiry } = require('../auth');
const { idValid, notFound } = require('./_id');
const { validateBody } = require('./_validate');

function crudRouter({ table, pk, columns, readColumns, name, orderBy, withJoins }) {
  const router = express.Router();
  // P1 — daftar SELALU menyertakan primary key (PK tidak seragam antar tabel:
  // users.id, mejas.id_meja, tanamen.id_tanaman, ... ) supaya frontend punya id
  // untuk memanggil PUT/DELETE /:id. PK tidak ikut whitelist kolom tulis.
  const listColumns = columns.includes(pk) ? columns : [pk, ...columns];
  // P5 — readColumns: kolom BACA-SAJA yang ikut SELECT/daftar tetapi TIDAK boleh
  // ditulis (stempel waktu created_at/updated_at/expires_at di mejas). Tanpa opsi
  // ini GET /meja hanya mengembalikan kolom whitelist — kolom waktu tak pernah
  // sampai ke klien; dengan opsi ini pun POST/PUT tetap membuangnya (lihat
  // warnUnknown) sehingga audit trail tidak bisa dipalsukan klien.
  const readCols = (Array.isArray(readColumns) ? readColumns : [])
    .filter((c) => c !== pk && !listColumns.includes(c));
  const allColumns = [...listColumns, ...readCols];
  const cols = allColumns.join(', ');
  const select = withJoins
    ? `SELECT ${allColumns.map((c) => `${table}.${c}`).join(', ')}${withJoins ? ', ' + withJoins : ''} FROM ${table}`
    : `SELECT ${cols} FROM ${table}`;

  // V1 — validasi path param :id. Semua PK yang dipakai crudRouter adalah bigint
  // (mejas.id_meja, pendewasaans.id_pendewasaan, users.id, ...). Id non-angka
  // membuat PostgreSQL gagal parse ("invalid input syntax for bigint") → 500 generik.
  // V2 — id yang lolos regex tapi MELEBIHI rentang bigint (mis. 9223372036854775808
  // atau 99999999999999999999999) tetap membuat PostgreSQL melempar SQLSTATE 22003
  // ("bigint out of range") → 500. Rentang dicek DI SINI dengan BigInt, bukan lewat
  // e.code === '22003' di handler: predikat di DEPAN query menjamin 404 identik tanpa
  // menyentuh DB, berlaku untuk semua metode (GET/PUT/PATCH/DELETE) dan semua tabel
  // dalam SATU titik — sedangkan penanganan 22003 tersebar di tiap handler/catch
  // dan gampang terlewat di endpoint baru. Pola /^[0-9]+$/ dipertahankan (bukan
  // {1,19}) supaya id valid ber-nol-depan tetap diterima seperti sebelumnya.
  // Id tidak valid dijawab 404 PERSIS sama dengan id yang tidak ada
  // (anti-enumeration + konsisten dengan kontrak API). Konstanta + helper kini
  // dipakai bersama lewat ./_id (satu sumber kebenaran, hilangkan duplikasi).
  const validId = (req, res, next) => (idValid(req) ? next() : notFound(res));

  // P3 — kolom di luar whitelist memang TIDAK disimpan (perilaku tidak diubah),
  // tetapi dicatat ke log supaya salah nama kolom dari frontend tidak hilang diam-diam.
  function warnUnknown(req) {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const unknown = Object.keys(body).filter((k) => !columns.includes(k));
    if (unknown.length) {
      console.warn(
        `[crud] ${req.method} ${req.originalUrl} — kolom di luar whitelist DIBUANG: ${unknown.join(', ')}`
        + ` (whitelist ${table}: ${columns.join(', ')})`,
      );
    }
  }

  // V3 — validasi body (Zod, lihat ./_validate) SEBELUM query: input tak terduga
  // (objek/array/null/NaN/kosong/terlalu panjang/angka di luar rentang kolom) kini
  // 422 terstruktur {message, errors:{field:[...]}} — bukan 500 (SQL gagal parse)
  // dan bukan tersimpan sembarangan ({"meja":{"a":1}} dulu menjadi string '{"a":1}').
  // warnUnknown tetap dijalankan PERTAMA untuk setiap request — termasuk yang nanti
  // ditolak 422 — supaya salah nama kolom dari frontend tidak hilang diam-diam.
  const validateCreate = validateBody({ table, columns, mode: 'create' });
  const validateUpdate = validateBody({ table, columns, mode: 'update' });
  const warnThen = (validator) => (req, res, next) => {
    warnUnknown(req);
    validator(req, res, next);
  };

  router.get('/', async (req, res, next) => {
    try {
      res.json(await q(`${select} ORDER BY ${orderBy || pk} DESC`));
    } catch (e) { next(e); }
  });

  router.get('/:id', validId, async (req, res, next) => {
    try {
      const row = await one(`${select} WHERE ${table}.${pk} = $1`, [req.params.id]);
      if (!row) return notFound(res);
      res.json(row);
    } catch (e) { next(e); }
  });

  router.post('/', warnThen(validateCreate), async (req, res, next) => {
    try {
      const fields = columns.filter((c) => c in req.body);
      if (fields.length === 0) return res.status(422).json({ message: 'Tidak ada data yang dikirim.', errors: {} });
      const exp = demoExpiry(req.user);
      const allFields = exp ? [...fields, 'expires_at'] : fields;
      const values = fields.map((c) => req.body[c]);
      const ph = fields.map((_, i) => `$${i + 1}`);
      if (exp) { values.push(exp); ph.push(`$${values.length}`); }
      const row = await one(
        `INSERT INTO ${table} (${allFields.join(', ')}) VALUES (${ph.join(', ')}) RETURNING *`,
        values,
      );
      res.status(201).json({ status: true, message: 'Data berhasil ditambahkan.', data: row });
    } catch (e) { next(e); }
  });

  const update = async (req, res, next) => {
    try {
      const fields = columns.filter((c) => c in req.body);
      if (fields.length === 0) return res.status(422).json({ message: 'Tidak ada data yang dikirim.', errors: {} });
      const sets = fields.map((c, i) => `${c} = $${i + 1}`);
      const values = fields.map((c) => req.body[c]);
      values.push(req.params.id);
      const row = await one(
        `UPDATE ${table} SET ${sets.join(', ')}, updated_at = now() WHERE ${pk} = $${values.length} RETURNING *`,
        values,
      );
      if (!row) return notFound(res);
      res.json({ status: true, message: 'Data berhasil diperbarui.', data: row });
    } catch (e) { next(e); }
  };
  // Urutan TETAP: validId dulu (404 identik, lihat ./_id), baru validasi body (422),
  // baru query — id tidak valid tak pernah menyentuh DB maupun body.
  router.put('/:id', validId, warnThen(validateUpdate), update);
  router.patch('/:id', validId, warnThen(validateUpdate), update);

  router.delete('/:id', validId, async (req, res, next) => {
    try {
      const row = await one(`DELETE FROM ${table} WHERE ${pk} = $1 RETURNING *`, [req.params.id]);
      if (!row) return notFound(res);
      res.json({ status: true, message: 'Data dihapus.' });
    } catch (e) {
      // P4 — FK ON DELETE RESTRICT: data terkait masih ada → jawab 409 yang ramah,
      // bukan 500 mentah.
      if (e && e.code === '23503') {
        // label rute: name bila ada (master.js), selain itu dari baseUrl (tahap.js)
        const label = name || (req.baseUrl && req.baseUrl.replace(/^\//, '')) || table;
        return res.status(409).json({
          message: `Tidak bisa menghapus ${label}: masih ada data terkait yang merujuknya.`,
          errors: {},
        });
      }
      next(e);
    }
  });

  return router;
}

module.exports = { crudRouter };
