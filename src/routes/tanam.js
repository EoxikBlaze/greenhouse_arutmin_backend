'use strict';
/** Tanam Saya — daftar tanam aktif, mulai tanam, selesai per tahap, hapus. */
const express = require('express');
const { pool, q, one } = require('../db');
const { demoGuard, demoExpiry, json } = require('../auth');
const { idValid, notFound } = require('./_id');
const { fkErrors, FK_TARGETS } = require('./_crud');
const { isDateString } = require('./_validate');
const { sinkronDiam } = require('../presetDosing');

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

/* ── Alur petani: hanya MEMILIH tanaman/meja, mengetik jumlah, dan MENGISI JUMLAH BERHASIL ──
 * Tanggal, durasi tahap, hari ke-berapa, jumlah gagal, dan tahap berikutnya dihitung server:
 *   semai ─(berhasil)→ peremajaan ─(berhasil)→ pendewasaan ─(panen: berhasil/gagal)→ panens
 * Durasi tiap tahap dari tabel sikluses (nama_siklus Semai/Peremajaan/Pendewasaan per tanaman). */
const TAHAP = {
  semai: {
    table: 'semais', pk: 'id_semai', awal: 'tgl_awal_semai', akhir: 'tgl_akhir_semai', jumlah: 'jumlah_benih',
    ok: 'benih_berhasil', gagal: 'benih_gagal', lanjut: 'peremajaan',
  },
  peremajaan: {
    table: 'peremajaans', pk: 'id_peremajaan', awal: 'tgl_awal_peremajaan', akhir: 'tgl_akhir_peremajaan', jumlah: 'jumlah_masuk',
    ok: 'benih_berhasil', gagal: 'benih_gagal', lanjut: 'pendewasaan',
  },
  pendewasaan: {
    table: 'pendewasaans', pk: 'id_pendewasaan', awal: 'tgl_awal_pendewasaan', akhir: 'tgl_akhir_pendewasaan', jumlah: 'jumlah_masuk',
    ok: 'tanaman_berhasil', gagal: 'tanaman_gagal', lanjut: 'panen',
  },
};

// durasi (hari) tahap $tipe untuk tanaman t.id_tanaman; NULL bila siklusnya belum diisi admin
const DURASI = (tipe) => `(SELECT k.waktu_siklus FROM sikluses k
   WHERE k.id_tanaman = t.id_tanaman AND lower(k.nama_siklus) = '${tipe}' ORDER BY k.id_siklus LIMIT 1)`;

router.get('/', async (_req, res, next) => {
  try {
    const [semai, peremajaan, pendewasaan] = await Promise.all([
      q(`SELECT s.id_semai AS id, 'semai' AS tipe, s.status, s.tgl_awal_semai AS mulai,
                t.nama_tanaman AS varietas, m.meja, s.id_meja, s.jumlah_benih, s.jumlah_benih AS jumlah,
                ${DURASI('semai')} AS durasi_hari
         FROM semais s LEFT JOIN tanamen t ON t.id_tanaman = s.id_tanaman
         LEFT JOIN mejas m ON m.id_meja = s.id_meja
         WHERE s.status = 'proses' ORDER BY s.id_semai DESC`),
      q(`SELECT p.id_peremajaan AS id, 'peremajaan' AS tipe, p.status, p.tgl_awal_peremajaan AS mulai,
                t.nama_tanaman AS varietas, m.meja, p.id_meja, p.jumlah_masuk, p.jumlah_masuk AS jumlah,
                ${DURASI('peremajaan')} AS durasi_hari
         FROM peremajaans p LEFT JOIN semais s ON s.id_semai = p.id_semai
         LEFT JOIN tanamen t ON t.id_tanaman = s.id_tanaman
         LEFT JOIN mejas m ON m.id_meja = p.id_meja
         WHERE p.status = 'proses' ORDER BY p.id_peremajaan DESC`),
      q(`SELECT d.id_pendewasaan AS id, 'pendewasaan' AS tipe, d.status, d.tgl_awal_pendewasaan AS mulai,
                t.nama_tanaman AS varietas, m.meja, d.id_meja, d.jumlah_masuk, d.jumlah_masuk AS jumlah,
                ${DURASI('pendewasaan')} AS durasi_hari
         FROM pendewasaans d LEFT JOIN peremajaans p ON p.id_peremajaan = d.id_peremajaan
         LEFT JOIN semais s ON s.id_semai = p.id_semai
         LEFT JOIN tanamen t ON t.id_tanaman = s.id_tanaman
         LEFT JOIN mejas m ON m.id_meja = d.id_meja
         WHERE d.status = 'proses' ORDER BY d.id_pendewasaan DESC`),
    ]);
    const hariIni = await one('SELECT current_date AS d');
    const list = [...semai, ...peremajaan, ...pendewasaan].map((r) => {
      const hari = Math.max(1, Math.round((new Date(hariIni.d) - new Date(r.mulai)) / 86_400_000) + 1);
      const durasi = r.durasi_hari == null ? null : Number(r.durasi_hari);
      return { ...r, durasi_hari: durasi, hari_ke: hari, siap: durasi != null && hari >= durasi, tahap_berikut: TAHAP[r.tipe].lanjut };
    });
    res.json({ page: 'tanam', list });
  } catch (e) { next(e); }
});

/** Pilihan untuk form "Mulai tanam" — petani tidak punya akses ke /tanaman & /meja (khusus admin). */
router.get('/pilihan', async (_req, res, next) => {
  try {
    const [tanaman, meja] = await Promise.all([
      q(`SELECT t.id_tanaman AS id, t.nama_tanaman AS nama, t.id_meja,
                ${DURASI('semai')} AS semai, ${DURASI('peremajaan')} AS peremajaan, ${DURASI('pendewasaan')} AS pendewasaan
           FROM tanamen t ORDER BY t.nama_tanaman`),
      q('SELECT id_meja AS id, meja AS nama FROM mejas ORDER BY meja'),
    ]);
    res.json({ tanaman, meja });
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
    // siklus Semai tanaman ini diisi otomatis bila klien tidak mengirim id_siklus
    const idSiklus = b.id_siklus ?? (b.id_tanaman == null ? null : (await one(
      "SELECT id_siklus FROM sikluses WHERE id_tanaman = $1 AND lower(nama_siklus) = 'semai' ORDER BY id_siklus LIMIT 1",
      [b.id_tanaman]))?.id_siklus ?? null);
    const row = await one(
      // G10 — tgl_akhir_semai NOT NULL tanpa default: dahulu kolom ini TIDAK ikut
      // INSERT → 23502 → 500 → fitur Mulai Tanam MATI TOTAL (seluruh payload lolos
      // validasi tetap 500). Diisi = tgl_awal (penanda 'belum ditutup'); penutupan
      // asli terjadi di handler /:tipe/:id/selesai via CASE (lihat bawah).
      `INSERT INTO semais (id_tanaman, id_siklus, id_meja, jumlah_benih, tgl_awal_semai, tgl_akhir_semai, status, keterangan, benih_berhasil, benih_gagal, expires_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4, coalesce($5::date, now()::date), coalesce($5::date, now()::date), 'proses', $6, 0, 0, $7, now(), now())
       RETURNING *`,
      [b.id_tanaman ?? null, idSiklus, b.id_meja ?? null, b.jumlah_benih ?? 0, b.tgl_awal_semai ?? null, b.keterangan ?? null, exp],
    );
    sinkronDiam(); // target penampung otomatis ikut batch baru
    res.status(201).json({ status: true, message: 'Tanam baru dimulai.', data: row });
  } catch (e) { next(e); }
});

/** Bilangan bulat ≥ 0 dari angka / teks angka; selain itu null. */
const bulat = (v) => {
  const n = typeof v === 'number' ? v : (/^\d+$/.test(String(v ?? '').trim()) ? Number(String(v).trim()) : NaN);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};

/**
 * Selesaikan tahap.
 * - Body { berhasil } (aplikasi HP): petani hanya mengisi jumlah yang berhasil. Server menghitung
 *   gagal = jumlah masuk − berhasil, menutup tahap hari ini, lalu OTOMATIS membuat tahap berikutnya
 *   berisi tanaman yang berhasil (pendewasaan → catatan panen). Berhasil 0 → status 'gagal'.
 * - Tanpa body (perilaku lama web): hanya menandai selesai, tanpa tahap berikutnya.
 */
router.post('/:tipe/:id/selesai', demoGuard('tanam.selesai'), async (req, res, next) => {
  const t = TAHAP[req.params.tipe];
  if (!t) return json(res, 422, { message: 'Tahap tidak dikenal.' });
  // V2 — urutan TETAP: tipe dulu (kontrak lama 422), baru id (404 identik).
  if (!idValid(req)) return notFound(res);
  const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};

  if (b.berhasil === undefined || b.berhasil === null) {
    try {
      // G10 — semai: tgl_akhir berisi penanda = tgl_awal sejak INSERT /mulai → tutup dgn hari ini.
      const row = await one(
        `UPDATE ${t.table} SET status = 'selesai', updated_at = now(),
                ${t.akhir} = CASE WHEN ${t.akhir} IS NULL OR ${t.akhir} <= ${t.awal} THEN GREATEST(now()::date, ${t.awal}) ELSE ${t.akhir} END
          WHERE ${t.pk} = $1 RETURNING *`, [req.params.id]);
      if (!row) return notFound(res);
      return res.json({ status: true, message: `Tahap ${req.params.tipe} diselesaikan.`, data: row });
    } catch (e) { return next(e); }
  }

  const berhasil = bulat(b.berhasil);
  if (berhasil == null) {
    return json(res, 422, { message: 'Data tidak valid.', errors: { berhasil: ['Jumlah berhasil harus bilangan bulat ≥ 0.'] } });
  }
  const keterangan = typeof b.keterangan === 'string' && b.keterangan.trim() ? b.keterangan.trim().slice(0, 500) : null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lama = (await client.query(`SELECT * FROM ${t.table} WHERE ${t.pk} = $1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!lama) { await client.query('ROLLBACK'); return notFound(res); }
    if (lama.status !== 'proses') {
      await client.query('ROLLBACK');
      return json(res, 409, { message: 'Tahap ini sudah diselesaikan sebelumnya.' });
    }
    // data lama bisa tanpa jumlah masuk → anggap jumlah = berhasil (gagal 0)
    const jumlah = lama[t.jumlah] == null ? berhasil : Number(lama[t.jumlah]);
    if (berhasil > jumlah) {
      await client.query('ROLLBACK');
      return json(res, 422, { message: 'Data tidak valid.', errors: { berhasil: [`Jumlah berhasil tidak boleh lebih dari ${jumlah}.`] } });
    }
    const gagal = jumlah - berhasil;
    const row = (await client.query(
      `UPDATE ${t.table} SET ${t.ok} = $2, ${t.gagal} = $3, status = $4, ${t.akhir} = GREATEST(now()::date, ${t.awal}),
              keterangan = COALESCE($5, keterangan), updated_at = now()
        WHERE ${t.pk} = $1 RETURNING *`,
      [req.params.id, berhasil, gagal, berhasil > 0 ? 'selesai' : 'gagal', keterangan])).rows[0];

    const exp = demoExpiry(req.user);
    let lanjut = null;
    if (t.lanjut === 'panen') {
      const p = (await client.query(
        `INSERT INTO panens (id_pendewasaan, panen_berhasil, panen_gagal, tgl_panen, keterangan, expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, now()::date, $4, $5, now(), now()) RETURNING id_panen`,
        [req.params.id, berhasil, gagal, keterangan, exp])).rows[0];
      lanjut = { tipe: 'panen', id: p.id_panen };
    } else if (berhasil > 0) {
      const n = TAHAP[t.lanjut];
      const p = (await client.query(
        `INSERT INTO ${n.table} (${t.pk}, id_meja, jumlah_masuk, ${n.ok}, ${n.gagal}, ${n.awal}, ${n.akhir}, status, expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, 0, 0, now()::date, now()::date, 'proses', $4, now(), now()) RETURNING ${n.pk} AS id`,
        [req.params.id, lama.id_meja, berhasil, exp])).rows[0];
      lanjut = { tipe: t.lanjut, id: p.id };
    }
    await client.query('COMMIT');
    sinkronDiam(); // tahap berganti → preset target penampung ikut berganti
    const pesan = lanjut?.tipe === 'panen' ? `Panen dicatat: ${berhasil} berhasil, ${gagal} gagal.`
      : lanjut ? `${berhasil} tanaman pindah ke ${t.lanjut}${gagal ? ` (${gagal} gagal)` : ''}.`
        : `Semua ${jumlah} tanaman gagal — batch ditutup.`;
    res.json({ status: true, message: pesan, data: row, berhasil, gagal, lanjut });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    next(e);
  } finally {
    client.release();
  }
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
