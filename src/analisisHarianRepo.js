'use strict';
/**
 * Penyimpanan analisis AI harian (tabel ai_analisis_harian) + notifikasi in-app.
 * Bukan berkas AI: hanya modul ini (dan penjadwal) yang menulis ke DB untuk fitur analisis harian.
 */
const { pool, q, one } = require('./db');

const KOLOM = 'id, tanggal::text AS tanggal, pemicu, dijalankan_oleh, isi, dibuat_pada, diperbarui_pada';

/**
 * Upsert laporan per tanggal + notifikasi (sekali per tanggal, dedup) dalam satu transaksi.
 * @param {{tanggal:string, pemicu:'jadwal'|'manual', oleh?:number|null, isi:object}} a
 */
async function simpan({ tanggal, pemicu, oleh = null, isi }) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    // (SELECT id FROM users ...) → NULL bila pengguna tidak ada, bukan galat FK
    const { rows: [baris] } = await c.query(
      `INSERT INTO ai_analisis_harian (tanggal, pemicu, dijalankan_oleh, isi)
       VALUES ($1::date, $2, (SELECT id FROM users WHERE id = $3::bigint), $4::jsonb)
       ON CONFLICT (tanggal) DO UPDATE
         SET pemicu = EXCLUDED.pemicu, dijalankan_oleh = EXCLUDED.dijalankan_oleh,
             isi = EXCLUDED.isi, diperbarui_pada = now()
       RETURNING ${KOLOM}`,
      [tanggal, pemicu, oleh, JSON.stringify(isi)]);
    await c.query(
      `INSERT INTO notifikasi (jenis, severity, judul, isi, tautan, dedup_key) VALUES ('ai_harian', $1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (dedup_key) DO NOTHING`,
      [isi.prioritas === 'tinggi' ? 'warning' : 'info', String(isi.judul || `Analisis harian ${tanggal}`).slice(0, 150),
        String(isi.ringkasan_utama || ''), JSON.stringify({ halaman: 'asisten', tab: 'analisis-harian', tanggal }),
        `ai-harian:${tanggal}`]);
    await c.query('COMMIT');
    return baris;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

const terbaru = () => one(`SELECT ${KOLOM} FROM ai_analisis_harian ORDER BY tanggal DESC LIMIT 1`);
const perTanggal = (tanggal) => one(`SELECT ${KOLOM} FROM ai_analisis_harian WHERE tanggal = $1::date`, [tanggal]);
const daftar = (batas = 30) => q(
  `SELECT id, tanggal::text AS tanggal, pemicu, isi->>'judul' AS judul, isi->>'prioritas' AS prioritas,
          isi->>'ringkasan_utama' AS ringkasan_utama, dibuat_pada, diperbarui_pada
     FROM ai_analisis_harian ORDER BY tanggal DESC LIMIT $1`, [batas]);
const adaUntuk = async (tanggal) => !!(await one('SELECT 1 FROM ai_analisis_harian WHERE tanggal = $1::date', [tanggal]));

module.exports = { simpan, terbaru, daftar, perTanggal, adaUntuk };
