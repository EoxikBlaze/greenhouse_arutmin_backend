'use strict';
/** Tanam Saya — daftar tanam aktif, mulai tanam, selesai per tahap, hapus. */
const express = require('express');
const { q, one } = require('../db');
const { demoGuard, demoExpiry, json } = require('../auth');

const router = express.Router();

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
    const exp = demoExpiry(req.user);
    const row = await one(
      `INSERT INTO semais (id_tanaman, id_siklus, id_meja, jumlah_benih, tgl_awal_semai, status, keterangan, benih_berhasil, benih_gagal, expires_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4, coalesce($5::date, now()::date), 'proses', $6, 0, 0, $7, now(), now())
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
    const sets = ["status = 'selesai'", 'updated_at = now()'];
    if (t.tgl) sets.splice(1, 0, `${t.tgl} = coalesce(${t.tgl}, now()::date)`);
    const row = await one(
      `UPDATE ${t.table} SET ${sets.join(', ')} WHERE ${t.pk} = $1 RETURNING *`, [req.params.id]);
    if (!row) return json(res, 404, { message: 'Data tidak ditemukan.' });
    res.json({ status: true, message: `Tahap ${req.params.tipe} diselesaikan.`, data: row });
  } catch (e) { next(e); }
});

// Hapus batch semai (konfirmasi di client)
router.post('/:id/hapus', async (req, res, next) => {
  try {
    if (req.user.demo) {
      return json(res, 403, { message: 'Mode demo tidak boleh menghapus data.' });
    }
    const row = await one('DELETE FROM semais WHERE id_semai = $1 RETURNING *', [req.params.id]);
    if (!row) return json(res, 404, { message: 'Data tidak ditemukan.' });
    res.json({ status: true, message: 'Data dihapus.' });
  } catch (e) { next(e); }
});

module.exports = router;
