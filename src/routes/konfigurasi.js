'use strict';
/**
 * Endpoint tabel konfigurasi & acuan SKEMA V2 (migrasi 2026-10-19) —
 * rujukan: docs/RANCANGAN_DB_V2.md §11.2, docs/ANALISIS_DB_PERANCANGAN.md §e,
 * kontrak & gaya respons: docs/KONTRAK_API.md §2/§5.
 *
 *   GET  /konfigurasi-dosis   (19 baris)   PUT /konfigurasi-dosis/:param  (admin)
 *   GET  /timing-operasi      (16 baris)   PUT /timing-operasi/:param     (admin)
 *   GET  /aturan-fail-safe    (20 baris)
 *   GET  /jadwal-perawatan    (5 baris)
 *   GET  /kalibrasi-sensor    (8 baris)
 *   GET  /mapping-channel     (15 baris)
 *   GET  /target-nutrisi      (3 baris)    PUT /target-nutrisi/:id        (admin)
 *   GET  /penampung-states    (5 baris)    (+ ?id_meja= — satu-satunya sumber
 *                                                yang punya kolom id_meja)
 *
 * Guard disamakan dengan endpoint admin yang sudah ada (master.js):
 *   baca → requireAuth + requireRole(['admin','demo']) — sama seperti /meja, /ambang;
 *          petani menerima 403 kontrak PetaniGuard, tanpa token → 401.
 *   tulis → admin only: requireRole(['admin']) loloskan token demo secara bawaan
 *          (auth.js: `demo || level === 'admin'`) sehingga demo ditahan demoGuard,
 *          persis pola tulis di master.js; petani → 403.
 *
 * Kenapa TIDAK memakai crudRouter generik (routes/_crud.js):
 *  1. PK 5 dari 8 tabel bertipe VARCHAR (param/kode/sensor) — validId (angka saja)
 *     membuat semua baris 404 pada GET /:id;
 *  2. UPDATE crudRouter selalu menulis `updated_at = now()` — konfigurasi_dosis/
 *     timing_operasi tidak punya kolom itu (punya `diubah_pada`), dan stempel waktu
 *     pada tabel V2 sengaja TIDAK disentuh saat PUT supaya perubahan hanya menyentuh
 *     kolom yang diminta klien (uji net-zero: SELECT sebelum == sesudah PUT bolak-balik).
 *
 * Prinsip yang dipertahankan dari rute lama:
 *  - path param divalidasi SEBELUM query → 404 seragam anti-enumeration
 *    `{"message":"Data tidak ditemukan.","errors":{}}` (kontrak §2b);
 *  - body divalidasi Zod SEBELUM query → 422 terstruktur
 *    `{"message":"Data tidak valid.","errors":{"<field>":["pesan"]}}` (kontrak §2);
 *  - CHECK/FK database diantisipasi di aplikasi (enum, rentang ec/ph/umur, FK
 *    id_tanaman) supaya input yang sah secara tipe tidak berujung 500;
 *  - respons daftar = array baris mentah (sama dengan GET rute CRUD lama),
 *    respons PUT = `{"status":true,"message":"Data berhasil diperbarui.","data":{...}}`.
 */
const express = require('express');
const { q, one } = require('../db');
const { requireAuth, requireRole, demoGuard } = require('../auth');
const { idValidValue, notFound, queryParam } = require('./_id');
const { validateBody } = require('./_validate');
const { tafsir, ATURAN } = require('../parameter');

const router = express.Router();

const readGuard = [requireAuth, requireRole(['admin', 'demo'])];
const writeGuard = [requireAuth, requireRole(['admin']), demoGuard('konfigurasi.update')];

/**
 * Satu sumber data V2.
 *   path     : segmen URL kebab-case (usulan RANCANGAN_DB_V2 §11.2)
 *   table/pk : tabel & primary key (bigint → idValid, varchar → panjang ≤ 64)
 *   columns  : kolom SELECT lengkap (termasuk PK)
 *   tulis    : kolom yang boleh diubah PUT — PK & stempel waktu tidak pernah
 *   cekRentang / cekFkTanaman : antisipasi CHECK target_nutrisi (→ 422, bukan 500)
 */
const SUMBERS = [
  {
    path: 'konfigurasi-dosis', table: 'konfigurasi_dosis', pk: 'param', tipePk: 'teks',
    columns: ['param', 'nilai', 'satuan', 'keterangan', 'sumber', 'diubah_pada'],
    tulis: ['nilai', 'satuan', 'keterangan', 'sumber'],
  },
  {
    path: 'timing-operasi', table: 'timing_operasi', pk: 'param', tipePk: 'teks',
    columns: ['param', 'nilai', 'satuan', 'keterangan', 'sumber', 'diubah_pada'],
    tulis: ['nilai', 'satuan', 'keterangan', 'sumber'],
  },
  {
    path: 'aturan-fail-safe', table: 'aturan_fail_safe', pk: 'kode', tipePk: 'teks',
    columns: ['kode', 'kondisi', 'aksi', 'ambang', 'satuan', 'aktif', 'sumber'],
  },
  {
    path: 'jadwal-perawatan', table: 'jadwal_perawatan', pk: 'kode', tipePk: 'teks',
    columns: ['kode', 'periode', 'periode_hari', 'kegiatan', 'lama_menit', 'sumber'],
  },
  {
    path: 'kalibrasi-sensor', table: 'kalibrasi_sensor', pk: 'sensor', tipePk: 'teks',
    columns: [
      'sensor', 'metode', 'larutan_ref', 'nilai_ref', 'satuan', 'periode_hari_min',
      'periode_hari_max', 'penyimpanan', 'hasil_ukur', 'terakhir_dikalibrasi', 'keterangan', 'sumber',
    ],
  },
  {
    path: 'mapping-channel', table: 'mapping_channel_esp32', pk: 'kode', tipePk: 'teks',
    columns: ['kode', 'kategori', 'nama', 'jumlah_channel', 'pin_gpio', 'keterangan', 'sumber'],
  },
  {
    path: 'target-nutrisi', table: 'target_nutrisi', pk: 'id', tipePk: 'angka',
    columns: [
      'id', 'id_tanaman', 'tahap', 'umur_min_hari', 'umur_max_hari', 'ec_min_ppm',
      'ec_max_ppm', 'ph_min', 'ph_max', 'status', 'keterangan', 'sumber', 'updated_at',
    ],
    tulis: [
      'id_tanaman', 'tahap', 'umur_min_hari', 'umur_max_hari', 'ec_min_ppm',
      'ec_max_ppm', 'ph_min', 'ph_max', 'status', 'keterangan', 'sumber',
    ],
    cekRentang: true, cekFkTanaman: true,
  },
  {
    path: 'penampung-states', table: 'penampung_states', pk: 'id_meja', tipePk: 'angka',
    columns: [
      'id_meja', 'status_lock', 'lock_alasan', 'lock_sejak', 'mode_pemeliharaan',
      'kejadian_dosis_hari', 'volume_ab_hari_ml', 'volume_ph_hari_ml', 'target_ec_ppm',
      'target_ph', 'reset_harian_pada', 'updated_at',
    ],
  },
];

/** Validasi path param SEBELUM menyentuh DB (404 seragam bila tidak valid). */
function idOk(s, id) {
  if (typeof id !== 'string' || id.length === 0) return false;
  if (s.tipePk === 'angka') return idValidValue(id);       // bigint: pola §2b
  // G10 — %00 (NUL) lolos cek panjang lalu membuat PostgreSQL melempar
  // 'invalid byte sequence for encoding UTF8' → 500. NUL ditolak → 404 seragam
  // (KEPUTUSAN: konsisten dgn pola id angka cacat yang menjawab 404, bukan 422).
  if (id.includes('\u0000')) return false;
  return id.length <= 64;                                  // varchar(64) terpanjang (param)
}

/** Kolom baca (SELECT) sebuah sumber. */
const selectOf = (s) => `SELECT ${s.columns.join(', ')} FROM ${s.table}`;

/** GET /<path> — daftar; ?id_meja= hanya dijalankan pada tabel yang punya kolom itu. */
function daftar(s) {
  return async (req, res, next) => {
    try {
      const params = [];
      let where = '';
      // queryParam: ?ID_MEJA=3 dikenali spt ?id_meja=3 (normalisasi case — lihat
      // _id.js). Tanpa ini filter case-variant diabaikan senyap → klien terima
      // data TANPA filter. Sumber tanpa kolom id_meja tetap mengabaikan param
      // (dokumentasi di KONTRAK_API).
      const idMeja = queryParam(req.query, 'id_meja');
      if (idMeja !== undefined && s.columns.includes('id_meja')) {
        // id_meja bukan angka / array (?id_meja[]=2) → 422 terstruktur, bukan 500.
        if (!idValidValue(idMeja)) {
          return res.status(422).json({
            message: 'Data tidak valid.',
            errors: { id_meja: ['Filter id_meja harus berupa angka yang valid.'] },
          });
        }
        where = ` WHERE ${s.table}.id_meja = $1`;
        params.push(idMeja);
      }
      res.json(await q(`${selectOf(s)}${where} ORDER BY ${s.table}.${s.pk}`, params));
    } catch (e) { next(e); }
  };
}

/** GET /<path>/:id — detail; id salah format & id tak ada → 404 identik. */
function detail(s) {
  return async (req, res, next) => {
    try {
      if (!idOk(s, req.params.id)) return notFound(res);
      const row = await one(`${selectOf(s)} WHERE ${s.table}.${s.pk} = $1`, [req.params.id]);
      if (!row) return notFound(res);
      res.json(row);
    } catch (e) { next(e); }
  };
}

/** Pola warnUnknown di _crud.js: kolom di luar whitelist dicatat, jangan hilang diam-diam. */
function warnUnknown(req, s) {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const unknown = Object.keys(body).filter((k) => !s.tulis.includes(k));
  if (unknown.length) {
    console.warn(
      `[konfigurasi] ${req.method} ${req.originalUrl} — kolom di luar whitelist DIBUANG: ${unknown.join(', ')}`
      + ` (whitelist ${s.table}: ${s.tulis.join(', ')})`,
    );
  }
}

/**
 * CHECK target_nutrisi_rentang (ec_min≤ec_max, ph_min≤ph_max, umur_min≤umur_max):
 * divalidasi terhadap gabungan baris LAMA + nilai kiriman (bukan hanya pasangan yang
 * dikirim) karena klien boleh mengubah satu sisi rentang saja → 422, bukan 500.
 * Angka dari pg bertipe numeric dikembalikan sebagai string → Number() dulu.
 */
function rentangErrors(efektif, errors) {
  for (const [lo, hi] of [['ec_min_ppm', 'ec_max_ppm'], ['ph_min', 'ph_max'], ['umur_min_hari', 'umur_max_hari']]) {
    if (efektif[lo] == null || efektif[hi] == null) continue;
    if (Number(efektif[lo]) > Number(efektif[hi])) {
      errors[lo] = [`Nilai ${lo} tidak boleh lebih besar dari ${hi}.`];
    }
  }
}

/**
 * PUT /<path>/:id — urutan sama dengan crudRouter: (1) validasi path (404 seragam),
 * (2) warnUnknown + validasi body Zod (422), (3) baca baris lama (404 bila tak ada
 * + dasar cek silang), (4) cek CHECK/FK (422), (5) UPDATE parameterisasi.
 * Kolom stempel waktu TIDAK ikut SET — hanya kolom yang diminta klien yang berubah
 * (net-zero: SELECT baris identik sebelum & sesudah PUT bolak-balik).
 */
function ubah(s) {
  const validate = validateBody({ table: s.table, columns: s.tulis, mode: 'update' });
  return [
    (req, res, next) => (idOk(s, req.params.id) ? next() : notFound(res)),
    (req, res, next) => { warnUnknown(req, s); validate(req, res, next); },
    async (req, res, next) => {
      try {
        const body = req.body || {};
        const fields = s.tulis.filter((c) => c in body);
        if (fields.length === 0) {
          return res.status(422).json({ message: 'Tidak ada data yang dikirim.', errors: {} });
        }
        const lama = await one(`${selectOf(s)} WHERE ${s.table}.${s.pk} = $1`, [req.params.id]);
        if (!lama) return notFound(res);
        const efektif = { ...lama, ...Object.fromEntries(fields.map((c) => [c, body[c]])) };
        const errors = {};
        if (s.cekRentang) rentangErrors(efektif, errors);
        // parameter keselamatan: nilai wajib angka sah (NULL/kosong/negatif/di luar rentang tipe ditolak) —
        // pembaca lama memakai Number(): NULL → 0 diam-diam
        if ((s.table === 'konfigurasi_dosis' || s.table === 'timing_operasi') && fields.includes('nilai')) {
          const t = tafsir(body.nilai, ATURAN[s.table][req.params.id]);
          if (t.status !== 'SAH') errors.nilai = [`Nilai tidak sah: ${t.alasan}.`];
        }
        if (s.cekFkTanaman && fields.includes('id_tanaman')) {
          const ada = await one('SELECT 1 AS ada FROM tanamen WHERE id_tanaman = $1', [body.id_tanaman]);
          if (!ada) errors.id_tanaman = ['id_tanaman tidak terdaftar.'];
        }
        if (Object.keys(errors).length) {
          return res.status(422).json({ message: 'Data tidak valid.', errors });
        }
        const values = fields.map((c) => body[c]);
        const sets = fields.map((c, i) => `${c} = $${i + 1}`);
        values.push(req.params.id);
        const row = await one(
          `UPDATE ${s.table} SET ${sets.join(', ')} WHERE ${s.pk} = $${values.length} RETURNING *`,
          values,
        );
        if (!row) return notFound(res);
        // Audit trail — perubahan konfigurasi V2 (before/after dari snapshot `lama`).
        req.audit = { aksi: 'update', tabel: s.table, row_id: String(row[s.pk]), before: lama, after: row };
        res.json({ status: true, message: 'Data berhasil diperbarui.', data: row });
      } catch (e) { next(e); }
    },
  ];
}

for (const s of SUMBERS) {
  router.get(`/${s.path}`, ...readGuard, daftar(s));
  router.get(`/${s.path}/:id`, ...readGuard, detail(s));
  if (s.tulis) router.put(`/${s.path}/:id`, ...writeGuard, ...ubah(s));
}

module.exports = router;
