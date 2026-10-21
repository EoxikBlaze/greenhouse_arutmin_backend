'use strict';
/**
 * CRUD generik — menggantikan Route::resource() Laravel (path 1:1, JSON-only).
 *   GET /x           → daftar (opsional ?q= search sederhana)
 *   POST /x          → tambah (roleName.store)
 *   GET /x/:id       → detail
 *   PUT|PATCH /x/:id → ubah (roleName.update)
 *   DELETE /x/:id    → hapus (roleName.destroy)
 * Sebelum query tulis: validasi body Zod (422) → cek keberadaan FK (422 per-field,
 * lihat fkErrors) → query. Relasi yang tak ada tidak pernah sampai ke PostgreSQL.
 */
const express = require('express');
const { q, one } = require('../db');
const { demoExpiry } = require('../auth');
const { idValid, notFound } = require('./_id');
const { validateBody } = require('./_validate');

/**
 * Peta kolom FK → tabel rujukannya (kunci: nama kolom; dipakai bersama oleh
 * crudRouter dan routes/tanam.js). Sumber: constraint FK live di PostgreSQL
 * (information_schema.table_constraints) untuk SEMUA tabel yang ditulis lewat
 * rute tulis: tanamen.id_meja → mejas, sikluses.id_tanaman → tanamen,
 * semais.{id_tanaman,id_siklus,id_meja}, peremajaans.{id_semai,id_meja},
 * pendewasaans.{id_peremajaan,id_meja}, panens.id_pendewasaan → pendewasaans.
 * Nama kolom lain (id_panen dsb.) sengaja TIDAK dimasukkan tanpa bukti constraint.
 */
const FK_TARGETS = {
  id_meja: { table: 'mejas', pk: 'id_meja' },
  id_tanaman: { table: 'tanamen', pk: 'id_tanaman' },
  id_siklus: { table: 'sikluses', pk: 'id_siklus' },
  id_semai: { table: 'semais', pk: 'id_semai' },
  id_peremajaan: { table: 'peremajaans', pk: 'id_peremajaan' },
  id_pendewasaan: { table: 'pendewasaans', pk: 'id_pendewasaan' },
};

/**
 * V5 — cek keberadaan relasi (FK) SEBELUM query tulis.
 * Dulu nilai FK berbentuk benar tetapi TIDAK ADA di tabel induk lolos validasi
 * (angka bulat) lalu dibuang PostgreSQL dengan FK violation 23503 → 500 generik
 * (mis. POST /tanaman {"id_meja":999999}). Kini tiap kolom FK yang dikirim dicek
 * dulu lewat SELECT ringan dan dijawab 422 kontrak per-field:
 *     422 {"message":"Data tidak valid.","errors":{"id_meja":["id_meja tidak terdaftar."]}}
 * (format identik dengan cek FK di routes/konfigurasi.js).
 * @param {string[]} cols kolom FK pada body (intersect dengan FK_TARGETS)
 * @param {object} body  body hasil validasi Zod
 * @returns {Promise<Record<string, string[]>>} errors per-field (kosong = lolos)
 */
async function fkErrors(cols, body) {
  const errors = {};
  for (const col of cols) {
    const ref = FK_TARGETS[col];
    if (!ref) continue;
    const raw = body[col];
    if (raw === null || raw === undefined) continue; // kolom nullable → biarkan DB
    const num = typeof raw === 'number' ? raw : (/^-?\d+$/.test(String(raw).trim()) ? Number(String(raw).trim()) : NaN);
    if (Number.isNaN(num)) {
      errors[col] = [`Kolom ${col} harus berupa bilangan bulat.`];
      continue;
    }
    if (!Number.isSafeInteger(num)) {
      // di luar rentang bigint → mustahil ada (dulu SQLSTATE 22003 → 500)
      errors[col] = [`${col} tidak terdaftar.`];
      continue;
    }
    const ada = await one(`SELECT 1 AS ada FROM ${ref.table} WHERE ${ref.pk} = $1`, [num]);
    if (!ada) errors[col] = [`${col} tidak terdaftar.`];
  }
  return errors;
}

/** Balasan 422 seragam untuk hasil cek FK. */
const fkReject = (res, errors) => res.status(422).json({ message: 'Data tidak valid.', errors });

function crudRouter({ table, pk, columns, readColumns, name, orderBy, withJoins }) {
  const router = express.Router();
  // V5 — kolom tulis yang merupakan FK (otomatis dari whitelist `columns` ∩ FK_TARGETS):
  // tanaman.id_meja · siklus.id_tanaman · semai.{id_tanaman,id_siklus,id_meja} ·
  // peremajaan.{id_semai,id_meja} · pendewasaan.{id_peremajaan,id_meja} ·
  // panen.id_pendewasaan. /meja & /ambang tanpa FK → jalur tulis TIDAK berubah sama sekali.
  const fkCols = columns.filter((c) => c in FK_TARGETS);
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
      // V5 — FK dicek SEBELUM INSERT: relasi tak ada → 422 per-field (dulu 23503 → 500).
      if (fkCols.length) {
        const fks = fkCols.filter((c) => fields.includes(c));
        if (fks.length) {
          const errors = await fkErrors(fks, req.body);
          if (Object.keys(errors).length) return fkReject(res, errors);
        }
      }
      const exp = demoExpiry(req.user);
      const allFields = exp ? [...fields, 'expires_at'] : fields;
      const values = fields.map((c) => req.body[c]);
      const ph = fields.map((_, i) => `$${i + 1}`);
      if (exp) { values.push(exp); ph.push(`$${values.length}`); }
      const row = await one(
        `INSERT INTO ${table} (${allFields.join(', ')}) VALUES (${ph.join(', ')}) RETURNING *`,
        values,
      );
      // Audit trail — siapkan entri; dicatat oleh middleware auditTrail (index.js).
      req.audit = { aksi: 'create', tabel: table, row_id: String(row[pk]), before: null, after: row };
      res.status(201).json({ status: true, message: 'Data berhasil ditambahkan.', data: row });
    } catch (e) { next(e); }
  });

  const update = async (req, res, next) => {
    try {
      const fields = columns.filter((c) => c in req.body);
      if (fields.length === 0) return res.status(422).json({ message: 'Tidak ada data yang dikirim.', errors: {} });
      // V5 — urutan UPDATE dipertahankan persis seperti dulu: baris LAMA dibaca dulu
      // (id tak ada → 404 IDENTIK, tanpa menyentuh FK), BARU relasi dicek (422, dulu
      // 23503 → 500), baru UPDATE. Tanpa pembacaan awal ini, id tak-ada + FK tak-ada
      // akan berubah 404 → 422 (regresi kontrak 404 lama).
      // Snapshot penuh (bukan `SELECT 1`) dipakai ganda: cek 404 di atas + before_data
      // untuk audit trail (src/audit.js) — satu query, tidak menambah biaya baca.
      const before = await one(`SELECT * FROM ${table} WHERE ${pk} = $1`, [req.params.id]);
      if (!before) return notFound(res);
      if (fkCols.length) {
        const fks = fkCols.filter((c) => fields.includes(c));
        if (fks.length) {
          const errors = await fkErrors(fks, req.body);
          if (Object.keys(errors).length) return fkReject(res, errors);
        }
      }
      const sets = fields.map((c, i) => `${c} = $${i + 1}`);
      const values = fields.map((c) => req.body[c]);
      values.push(req.params.id);
      const row = await one(
        `UPDATE ${table} SET ${sets.join(', ')}, updated_at = now() WHERE ${pk} = $${values.length} RETURNING *`,
        values,
      );
      if (!row) return notFound(res);
      // Audit trail — before/after dipakai halaman riwayat (lihat src/audit.js).
      req.audit = { aksi: 'update', tabel: table, row_id: String(row[pk]), before, after: row };
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
      // Audit trail — baris terakhir ikut direkam sebagai before_data.
      req.audit = { aksi: 'delete', tabel: table, row_id: String(req.params.id), before: row, after: null };
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

module.exports = { crudRouter, fkErrors, FK_TARGETS };
