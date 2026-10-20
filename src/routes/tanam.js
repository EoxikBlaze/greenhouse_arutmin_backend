'use strict';
/** Tanam Saya — daftar tanam aktif, mulai tanam, selesai per tahap, hapus. */
const express = require('express');
const { q, one } = require('../db');
const { demoGuard, demoExpiry, json } = require('../auth');
const { idValid, notFound } = require('./_id');
const { fkErrors, FK_TARGETS } = require('./_crud');
const { isDateString } = require('./_validate');

const router = express.Router();

/* ── V5 — validasi input SEBELUM INSERT /mulai ─────────────────────────
 * Dulu body /tanam/mulai langsung dibungkus ke query parameterisasi tanpa
 * validasi apa pun, sehingga dua kelas input rusak membuat PostgreSQL
 * melempar error → 500 generik:
 *   (a) FK berbentuk benar tetapi tidak ada ({"id_meja":999999}) → SQLSTATE 23503;
 *   (b) tanggal salah format ({"tgl_awal_semai":"bukan-tanggal"}) → SQLSTATE 22007
 *       "invalid input syntax for type date";
 *   (c) jumlah_benih bukan integer ({"jumlah_benih":"abc"}) → SQLSTATE 22002.
 * Kini ketiganya dijawab 422 kontrak {message, errors:{field:[pesan]}} SEBELUM
 * query — data tidak pernah tersentuh. Nilai null/tidak dikirim TIDAK dicek:
 * perilaku lama (FK null → kolom null, tanggal null → coalesce(now()::date),
 * jumlah_benih tidak ada → 0) dipertahankan persis.
 */
const MULAI_FKS = ['id_tanaman', 'id_siklus', 'id_meja'].filter((c) => c in FK_TARGETS);
const MULAI_TGL = ['tgl_awal_semai'];
const MULAI_INT = ['jumlah_benih'];

/**
 * Kumpulkan error 422 /mulai: FK (422 'tidak terdaftar'), tanggal (pola
 * YYYY-MM-DD), integer (pesan seragam tipe _validate.js).
 * @returns {Promise<Record<string, string[]>>}
 */
async function mulaiErrors(b) {
  const errors = {};
  Object.assign(errors, await fkErrors(MULAI_FKS, b));
  for (const col of MULAI_TGL) {
    const v = b[col];
    if (v === undefined || v === null) continue;
    if (!isDateString(v)) {
      errors[col] = [typeof v === 'string'
        ? `Kolom ${col} harus berformat YYYY-MM-DD.`
        : `Kolom ${col} harus berupa teks.`];
    }
  }
  for (const col of MULAI_INT) {
    const v = b[col];
    if (v === undefined || v === null) continue;
    const num = typeof v === 'number' ? v : (/^-?\d+$/.test(String(v).trim()) ? Number(String(v).trim()) : NaN);
    if (Number.isNaN(num) || !Number.isSafeInteger(num)) {
      errors[col] = [`Kolom ${col} harus berupa bilangan bulat.`];
    }
  }
  return errors;
}

// V2 — validasi path param :id (lihat _crud.js validId): non-angka ATAU melebihi
// rentang bigint Postgres → 404 PERSIS sama dengan id yang tidak ada (anti-enumeration),
// dicek di depan query supaya tidak pernah menyentuh DB (dulu → 500 SQLSTATE 22003).
// Definisi bersama (BIGINT_MAX / idValid / notFound) kini ada di ./_id.

router.get('/', async (_req, res, next) => {
  try {
    const [semai, peremajaan, pendewasaan] = await Promise.all([
      q(`SELECT s.id_semai AS id, 'semai' AS tipe, s.status, s.tgl_awal_semai AS mulai,
                t.nama_tanaman AS varietas, m.meja, s.jumlah_benih
         FROM semais s LEFT JOIN tanamen t ON t.id_tanaman = s.id_tanaman
         LEFT JOIN mejas m ON m.id_meja = s.id_meja
         WHERE s.status IS DISTINCT FROM 'selesai' ORDER BY s.id_semai DESC`),
      q(`SELECT p.id_peremajaan AS id, 'peremajaan' AS tipe, 'aktif' AS status, p.tgl_awal_peremajaan AS mulai,
                t.nama_tanaman AS varietas, m.meja, p.jumlah_masuk
         FROM peremajaans p LEFT JOIN semais s ON s.id_semai = p.id_semai
         LEFT JOIN tanamen t ON t.id_tanaman = s.id_tanaman
         LEFT JOIN mejas m ON m.id_meja = p.id_meja
         ORDER BY p.id_peremajaan DESC`),
      q(`SELECT d.id_pendewasaan AS id, 'pendewasaan' AS tipe, 'aktif' AS status, d.tgl_awal_pendewasaan AS mulai,
                t.nama_tanaman AS varietas, m.meja, d.jumlah_masuk
         FROM pendewasaans d LEFT JOIN peremajaans p ON p.id_peremajaan = d.id_peremajaan
         LEFT JOIN semais s ON s.id_semai = p.id_semai
         LEFT JOIN tanamen t ON t.id_tanaman = s.id_tanaman
         LEFT JOIN mejas m ON m.id_meja = d.id_meja
         ORDER BY d.id_pendewasaan DESC`),
    ]);
    res.json({ page: 'tanam', list: [...semai, ...peremajaan, ...pendewasaan] });
  } catch (e) { next(e); }
});

// Mulai tanam baru = buat batch semai (data demo dapat expires_at +1 jam)
router.post('/mulai', demoGuard('tanam.mulai'), async (req, res, next) => {
  try {
    const b = req.body || {};
    // V5 — validasi FK/tanggal/integer SEBELUM INSERT (lihat mulaiErrors di atas).
    const errors = await mulaiErrors(b);
    if (Object.keys(errors).length) return json(res, 422, { message: 'Data tidak valid.', errors });
    const exp = demoExpiry(req.user);
    const row = await one(
      // G10 — tgl_akhir_semai NOT NULL tanpa default: dahulu kolom ini TIDAK ikut
      // INSERT → 23502 → 500 → fitur Mulai Tanam MATI TOTAL (seluruh payload lolos
      // validasi tetap 500). Diisi = tgl_awal (penanda 'belum ditutup'); penutupan
      // asli terjadi di handler /:tipe/:id/selesai via CASE (lihat bawah).
      `INSERT INTO semais (id_tanaman, id_siklus, id_meja, jumlah_benih, tgl_awal_semai, tgl_akhir_semai, status, keterangan, benih_berhasil, benih_gagal, expires_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4, coalesce($5::date, now()::date), coalesce($5::date, now()::date), 'proses', $6, 0, 0, $7, now(), now())
       RETURNING *`,
      [b.id_tanaman ?? null, b.id_siklus ?? null, b.id_meja ?? null, b.jumlah_benih ?? 0, b.tgl_awal_semai ?? null, b.keterangan ?? null, exp],
    );
    res.status(201).json({ status: true, message: 'Tanam baru dimulai.', data: row });
  } catch (e) { next(e); }
});

// Selesai satu tahap → tutup tanggal akhir + status selesai
router.post('/:tipe/:id/selesai', demoGuard('tanam.selesai'), async (req, res, next) => {
  try {
    const map = {
      semai: { table: 'semais', pk: 'id_semai', tgl: 'tgl_akhir_semai' },
      peremajaan: { table: 'peremajaans', pk: 'id_peremajaan', tgl: 'tgl_akhir_peremajaan' },
      pendewasaan: { table: 'pendewasaans', pk: 'id_pendewasaan', tgl: 'tgl_akhir_pendewasaan' },
      panen: { table: 'panens', pk: 'id_panen', tgl: null },
    };
    const t = map[req.params.tipe];
    if (!t) return json(res, 422, { message: 'Tahap tidak dikenal.' });
    // V2 — urutan TETAP: tipe dulu (kontrak lama 422), baru id (404 identik).
    if (!idValid(req)) return notFound(res);
    const sets = ["status = 'selesai'", 'updated_at = now()'];
    // G10 — coalesce lama tak pernah menutup batch baru (tgl_akhir sudah terisi
    // penanda = tgl_awal saat INSERT /mulai). CASE: null ATAU == tgl_awal →
    // tutup dgn hari ini; sudah diisi asli (> awal / tabel tanpa awal) → biarkan
    // (baris 'selesai' existing tak pernah tertimpa).
    if (t.tgl) {
      const awal = t.table === 'semais' ? ' tgl_awal_semai' : '';
      sets.splice(1, 0, awal
        ? `${t.tgl} = CASE WHEN ${t.tgl} IS NULL OR ${t.tgl} = tgl_awal_semai THEN now()::date ELSE ${t.tgl} END`
        : `${t.tgl} = coalesce(${t.tgl}, now()::date)`);
    }
    const row = await one(
      `UPDATE ${t.table} SET ${sets.join(', ')} WHERE ${t.pk} = $1 RETURNING *`, [req.params.id]);
    if (!row) return notFound(res);
    res.json({ status: true, message: `Tahap ${req.params.tipe} diselesaikan.`, data: row });
  } catch (e) { next(e); }
});

// Hapus batch semai (konfirmasi di client)
router.post('/:id/hapus', async (req, res, next) => {
  try {
    // Urutan TETAP seperti sebelumnya: cek demo dulu (403), baru validasi id
    // (404 identik — V2), baru query. Supaya status lama tidak berubah.
    if (req.user.demo) {
      return json(res, 403, { message: 'Mode demo tidak boleh menghapus data.' });
    }
    if (!idValid(req)) return notFound(res);
    const row = await one('DELETE FROM semais WHERE id_semai = $1 RETURNING *', [req.params.id]);
    if (!row) return notFound(res);
    res.json({ status: true, message: 'Data dihapus.' });
  } catch (e) { next(e); }
});

module.exports = router;
