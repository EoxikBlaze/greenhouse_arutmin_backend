'use strict';
/**
 * Riwayat audit — GET /audit-logs (khusus admin; guard dipasang di index.js
 * memakai requireAuth + requireRole(['admin'])).
 *
 * Kontrak balasan (dipakai halaman /audit di react-web-app):
 *   { data: AuditLog[], total: number, page: number, per_page: number }
 * Filter: ?tabel=mejas & ?aksi=CREATE — keduanya opsional (kosong = semua).
 * Pagination: ?page=1 (min 1) & ?per_page=20 (1..100).
 * Param cacat → 422 terstruktur kontrak {message, errors:{field:[pesan]}}.
 * Urutan: terjadi_pada DESC (aktivitas terbaru di atas).
 */
const express = require('express');
const { q, one } = require('../db');
const { json } = require('../auth');

const router = express.Router();

const DEFAULT_PER_PAGE = 20;
const MAX_PER_PAGE = 100;
/** Filter hanya menerima token sederhana (nama tabel/aksi) — tanpa karakter aneh. */
const FILTER_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * Angka query positif dengan batas. Mengisi `errors[key]` bila cacat dan
 * mengembalikan nilai default (pemanggil membalas 422 bila errors terisi).
 */
function angkaQuery(raw, def, { min, max, key, errors }) {
  if (raw === undefined || raw === '') return def;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) {
    errors[key] = [`Parameter ${key} harus berupa bilangan bulat.`];
    return def;
  }
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    errors[key] = [`Parameter ${key} harus antara ${min} dan ${max}.`];
    return def;
  }
  return n;
}

/** Teks query opsional (filter) — kosong/cacat ditangani di sini. */
function teksQuery(raw, key, errors) {
  if (raw === undefined || raw === '') return '';
  if (typeof raw !== 'string') {
    errors[key] = [`Parameter ${key} harus berupa teks.`];
    return '';
  }
  const s = raw.trim();
  if (!FILTER_RE.test(s)) {
    errors[key] = [`Parameter ${key} hanya boleh berisi huruf, angka, titik, strip, atau garis bawah (maks 64 karakter).`];
    return '';
  }
  return s;
}

router.get('/', async (req, res, next) => {
  try {
    const errors = {};
    const page = angkaQuery(req.query.page, 1, { min: 1, max: 1_000_000, key: 'page', errors });
    const perPage = angkaQuery(req.query.per_page, DEFAULT_PER_PAGE, {
      min: 1, max: MAX_PER_PAGE, key: 'per_page', errors,
    });
    const tabel = teksQuery(req.query.tabel, 'tabel', errors);
    const aksi = teksQuery(req.query.aksi, 'aksi', errors);
    if (Object.keys(errors).length) {
      return json(res, 422, { message: 'Data tidak valid.', errors });
    }

    // Filter disuntik sebagai PARAMETER ($n) — tidak pernah string-interpolasi.
    // `lower()` di kedua sisi supaya ?aksi=CREATE dan ?aksi=create sama-sama
    // cocok (nilai tersimpan huruf kecil sesuai CHECK enum kolom aksi).
    const where = [];
    const args = [];
    if (tabel) { args.push(tabel.toLowerCase()); where.push(`lower(tabel) = $${args.length}`); }
    if (aksi) { args.push(aksi.toLowerCase()); where.push(`lower(aksi) = $${args.length}`); }
    const kondisi = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const totalRow = await one(`SELECT count(*)::int AS total FROM audit_logs ${kondisi}`, args);
    const total = totalRow ? Number(totalRow.total) : 0;

    args.push(perPage, (page - 1) * perPage);
    const data = await q(
      `SELECT id, terjadi_pada, actor_user_id, actor_tipe, actor_label, aksi, tabel,
              row_id, before_data, after_data, ip, user_agent, meta
         FROM audit_logs ${kondisi}
        ORDER BY terjadi_pada DESC, id DESC
        LIMIT $${args.length - 1} OFFSET $${args.length}`,
      args,
    );

    return json(res, 200, { data, total, page, per_page: perPage });
  } catch (e) { next(e); }
});

module.exports = router;
