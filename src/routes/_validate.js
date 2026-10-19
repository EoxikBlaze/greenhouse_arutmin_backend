'use strict';
/**
 * Validasi body input dengan Zod — dipakai rute CRUD generik (src/routes/_crud.js).
 *
 * Latar (bug yang ditemukan agen debugger): tanpa validasi tipe, input tak terduga
 * membuat PostgreSQL melempar error → [500], dan objek justru TERSIMPAN sembarangan
 * ({"meja":{"a":1}} pernah menjadi string '{"a":1}' di kolom meja). Dengan Zod semua
 * input tak terduga — objek, array, null, NaN, string kosong, teks > maxLen, angka di
 * luar rentang int4 — kini ditolak 422 TERSTRUKTUR sesuai kontrak
 * (docs/KONTRAK_API.md §2), sama gaya dengan 422 login:
 *     422 {"message":"Data tidak valid.","errors":{"<field>":["pesan"]}}
 *
 * Prinsip:
 *  - CREATE : field ber-flag `requiredCreate` wajib ada dan valid; sisanya opsional.
 *  - UPDATE : SEMUA field opsional, tetapi tipe & panjang tetap divalidasi bila dikirim.
 *  - Validasi berjalan SEBELUM query (lihat _crud.js) → data tak pernah tersentuh saat
 *    request ditolak; path param :id tetap divalidasi oleh ./_id (validId) SEBELUM
 *    validasi body, sehingga 404 identik tidak berubah.
 *  - Field di luar whitelist TIDAK divalidasi di sini (Zod membuangnya dari hasil
 *    parse) — handler tetap membuangnya lewat mekanisme console.warn yang sudah ada.
 *  - Tabel tanpa spec eksplisit memakai inferensi longgar (string 1..500 / integer
 *    int4 / id_ → bigint) supaya SEMUA tabel ikut terlindungi tanpa menebak-nebak
 *    nilai yang boleh (tidak ada asumsi enum yang tidak terdokumentasi).
 *
 * Pilihan Zod (bukan ajv/Joi) mengacu RISET_PENGEMBANGAN_GARAP.md: nol dependensi
 * inti, ringan, dan skema bisa dipakai ulang untuk dokumentasi OpenAPI.
 */
const { z } = require('zod');

/** Batas integer (int4) Postgres — kolom integer mentah. */
const INT4_MIN = -2147483648;
const INT4_MAX = 2147483647;
/** Panjang teks default untuk kolom varchar tanpa spec eksplisit. */
const DEFAULT_STR_MAX = 500;
/** Pesan seragam untuk body yang bukan objek JSON (null/array/angka/teks). */
const MSG_BODY = 'Body harus berupa objek JSON.';

/**
 * Spec eksplisit per tabel. Key = nama kolom, value:
 *   tipe           : 'string' | 'integer' | 'number' | 'enum'
 *   requiredCreate : wajib saat CREATE (POST); UPDATE selalu opsional
 *   minLen/maxLen  : batas panjang teks (default string: 1..500)
 *   min/max        : batas angka (integer = bilangan bulat, number = desimal)
 *   enum           : daftar nilai yang diizinkan
 * Batas mengikuti docs/DB_SCHEMA.md — mejas.meja varchar(200), mejas.jumlah_lubang
 * integer dengan rentang 1..1000000 (sesuai mandat perbaikan).
 */
const TABLE_SPECS = {
  mejas: {
    meja: { tipe: 'string', requiredCreate: true, minLen: 1, maxLen: 200 },
    jumlah_lubang: { tipe: 'integer', requiredCreate: true, min: 1, max: 1000000 },
  },
  sensor_thresholds: {
    // Daftar nilai tertutup sesuai docs/DB_SCHEMA.md (feed ESP32).
    sensor: { tipe: 'enum', enum: ['waterTemp', 'ph', 'tds', 'airTemp', 'humidity'] },
    min: { tipe: 'number' },
    max: { tipe: 'number' },
  },
};

/** Nama kolom bertipe desimal (bukan bulat). */
const FLOAT_COLUMNS = new Set(['min', 'max']);
/**
 * Pola nama kolom bertipe integer di luar id_: jumlah_* (jumlah_benih, jumlah_masuk),
 * waktu_* (waktu_siklus), dan *_berhasil / *_gagal (benih/tanaman/panen).
 * id_* adalah FK bigint → integer tanpa batas int4 (aman untuk Number.isSafeInteger).
 */
const INTEGER_NAME = /^(id_|jumlah_|waktu_)|_(berhasil|gagal)$/;

/**
 * Inferensi tipe longgar untuk kolom tanpa spec eksplisit.
 * @param {string} col nama kolom
 * @returns {{tipe: string, minLen?: number, maxLen?: number, min?: number, max?: number}}
 */
function inferSpec(col) {
  if (FLOAT_COLUMNS.has(col)) return { tipe: 'number' };
  if (INTEGER_NAME.test(col)) {
    // Kolom integer non-FK di DB bertipe int4 → batas int4 mencegah 'integer out of
    // range' (22003) yang dulu bocor jadi 500. id_* adalah bigint → cukup batas
    // safe-integer bawaan z.number().int().
    return /^id_/.test(col) ? { tipe: 'integer' } : { tipe: 'integer', min: INT4_MIN, max: INT4_MAX };
  }
  return { tipe: 'string', minLen: 1, maxLen: DEFAULT_STR_MAX };
}

/** Gabungkan spec eksplisit tabel dengan inferensi untuk kolom yang belum tercantum. */
function specsFor(table, columns) {
  const explicit = TABLE_SPECS[table] || {};
  const specs = {};
  for (const col of columns) specs[col] = explicit[col] || inferSpec(col);
  return specs;
}

/** Susun skema Zod untuk satu mode. */
function schemaFor(specs, columns, mode) {
  const shape = {};
  for (const col of columns) {
    const spec = specs[col];
    let s;
    switch (spec.tipe) {
      case 'integer': {
        s = z.number().int();
        if (spec.min !== undefined) s = s.min(spec.min);
        if (spec.max !== undefined) s = s.max(spec.max);
        break;
      }
      case 'number': {
        s = z.number();
        if (spec.min !== undefined) s = s.min(spec.min);
        if (spec.max !== undefined) s = s.max(spec.max);
        break;
      }
      case 'enum':
        s = z.enum(spec.enum);
        break;
      case 'string':
      default:
        s = z.string().min(spec.minLen ?? 1).max(spec.maxLen ?? DEFAULT_STR_MAX);
        break;
    }
    // UPDATE: semua opsional (tipe/panjang tetap dicek bila dikirim).
    shape[col] = mode === 'create' && spec.requiredCreate ? s : s.optional();
  }
  // Object non-strict: field di luar whitelist di-strip dari hasil parse TANPA error —
  // pembuangannya tetap urusan console.warn di handler (perilaku lama dipertahankan).
  return z.object(shape);
}

/** Pesan Indonesia per issue — tidak pernah membocorkan pesan bawaan Zod (Inggris). */
function messageFor(issue, spec, field, value) {
  if (value === undefined) return `Kolom ${field} wajib diisi.`;
  if (value === null) return `Kolom ${field} tidak boleh null.`;
  switch (spec.tipe) {
    case 'string':
      if (issue.code === 'too_big') return `Kolom ${field} maksimal ${spec.maxLen ?? DEFAULT_STR_MAX} karakter.`;
      if (issue.code === 'too_small') {
        return (spec.minLen ?? 1) > 1
          ? `Kolom ${field} minimal ${spec.minLen} karakter.`
          : `Kolom ${field} wajib diisi.`;
      }
      return `Kolom ${field} harus berupa teks.`;
    case 'integer':
      if (issue.code === 'too_small' || issue.code === 'too_big') {
        return `Kolom ${field} harus antara ${spec.min ?? '-∞'} dan ${spec.max ?? '∞'}.`;
      }
      return `Kolom ${field} harus berupa bilangan bulat.`;
    case 'number':
      if (issue.code === 'too_small' || issue.code === 'too_big') {
        return `Kolom ${field} harus antara ${spec.min ?? '-∞'} dan ${spec.max ?? '∞'}.`;
      }
      return `Kolom ${field} harus berupa angka.`;
    case 'enum':
      return `Kolom ${field} harus salah satu dari: ${spec.enum.join(', ')}.`;
    default:
      return `Kolom ${field} tidak valid.`;
  }
}

/**
 * Susun {field: [pesan]} dari issue Zod — format 422 kontrak.
 * Path kosong = body sendiri bukan objek (null/array/teks/angka) → kunci 'body'.
 */
function formatErrors(issues, data, specs) {
  const errors = {};
  for (const issue of issues) {
    const field = issue.path.length ? String(issue.path[0]) : 'body';
    let msg;
    if (!issue.path.length) {
      msg = MSG_BODY;
    } else {
      const spec = specs[field] || inferSpec(field);
      const value = data && typeof data === 'object' && !Array.isArray(data) ? data[field] : undefined;
      msg = messageFor(issue, spec, field, value);
    }
    const list = errors[field] || (errors[field] = []);
    if (!list.includes(msg)) list.push(msg);
  }
  return errors;
}

/**
 * Balasan 422 seragam untuk body yang bukan objek JSON.
 * Dipakai bersama oleh middleware validasi dan penanganan error body-parser di
 * src/index.js (body JSON berupa skalar), supaya bentuknya selalu sama.
 */
const invalidBody = (res) => res.status(422).json({ message: 'Data tidak valid.', errors: { body: [MSG_BODY] } });

/**
 * Middleware validasi body untuk satu rute CRUD.
 * @param {{table: string, columns: string[], mode: 'create'|'update'}} opts
 * @returns {(req: import('express').Request, res: import('express').Response, next: Function) => void}
 */
function validateBody({ table, columns, mode }) {
  const specs = specsFor(table, columns);
  const schema = schemaFor(specs, columns, mode);
  return function validate(req, res, next) {
    // body bisa undefined (tanpa content-type) → perlakukan sebagai objek kosong;
    // null/array/teks/angka tetap ditolak lewat issue path kosong ('body').
    const body = req.body === undefined ? {} : req.body;
    const result = schema.safeParse(body);
    if (result.success) return next();
    return res.status(422).json({ message: 'Data tidak valid.', errors: formatErrors(result.error.issues, body, specs) });
  };
}

module.exports = { validateBody, invalidBody, inferSpec, specsFor, TABLE_SPECS, MSG_BODY, INT4_MIN, INT4_MAX };
