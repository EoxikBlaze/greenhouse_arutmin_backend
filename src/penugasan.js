'use strict';
/**
 * PENUGASAN PETANI ↔ PENAMPUNG (Fase 3B.1) — dasar otorisasi tulis petani.
 *
 * Admin (bukan demo): semua penampung. Petani (bukan demo): HANYA penampung dengan penugasan aktif,
 * dicek di DB (level user di tabel users juga harus masih 'petani' — token lama setelah role diubah
 * tidak cukup). Lainnya (demo, 'user'): ditolak. Cek dilakukan DI DALAM transaksi operasi dengan
 * FOR SHARE, sehingga pencabutan yang sedang berjalan menunggu operasi selesai atau operasi melihat
 * pencabutan — tidak pernah lolos memakai penugasan yang sudah dicabut dan di-commit.
 */
const crypto = require('crypto');
const { pool, q } = require('./db');

class AksesDitolak extends Error {
  constructor(pesan, ekstra = {}) {
    super(pesan);
    this.status = 403;
    this.kode = 'tidak_ditugaskan';
    Object.assign(this, ekstra);
  }
}

const adalahAdmin = (u) => u?.level === 'admin' && !u.demo;
const adalahPetani = (u) => u?.level === 'petani' && !u.demo;

/**
 * Pastikan user boleh menulis untuk semua penampung di `idMeja` (null/undefined diabaikan HANYA untuk
 * admin; petani + meja kosong = ditolak, karena tidak ada penugasan yang bisa dibuktikan).
 * @param {import('pg').PoolClient} c client transaksi pemanggil
 */
async function wajibDitugaskan(c, user, idMeja) {
  if (adalahAdmin(user)) return;
  if (!adalahPetani(user)) throw new AksesDitolak('Akun ini tidak punya hak mengubah siklus.', { kode: 'akses_ditolak' });
  const daftar = idMeja.map((x) => (x == null ? null : Number(x)));
  if (daftar.some((x) => x == null)) throw new AksesDitolak('Penampung siklus ini tidak tercatat; hanya admin yang bisa mengubahnya.');
  const unik = [...new Set(daftar)];
  const ada = (await c.query(
    `SELECT p.id_meja FROM penugasan_penampung p JOIN users u ON u.id = p.id_user
      WHERE p.id_user = $1 AND p.aktif AND p.id_meja = ANY($2::bigint[])
        AND u.level = 'petani' AND NOT coalesce(u.is_demo, false)
      FOR SHARE OF p`, [user.sub, unik])).rows.map((r) => Number(r.id_meja));
  const kurang = unik.filter((m) => !ada.includes(m));
  if (kurang.length) throw new AksesDitolak(`Anda tidak ditugaskan ke penampung ${kurang.join(', ')}.`, { id_meja: kurang });
}

async function audit(c, user, aksi, rowId, before, after) {
  await c.query(
    `INSERT INTO audit_logs (actor_user_id, actor_tipe, actor_label, aksi, tabel, row_id, before_data, after_data, request_id, meta)
     VALUES ($1, 'user', $2, $3, 'penugasan_penampung', $4, $5, $6, $7, $8)`,
    [user.sub, user.username ?? null, aksi, String(rowId), before, after, crypto.randomUUID(), { level: user.level }]);
}

class PenugasanGalat extends Error {
  constructor(status, pesan, ekstra = {}) { super(pesan); this.status = status; Object.assign(this, ekstra); }
}

async function tugaskan({ id_user: idUser, id_meja: idMeja }, admin) {
  const errors = {};
  if (!Number.isInteger(idUser) || idUser < 1) errors.id_user = ['id_user wajib bilangan bulat ≥ 1.'];
  if (!Number.isInteger(idMeja) || idMeja < 1) errors.id_meja = ['id_meja wajib bilangan bulat ≥ 1.'];
  if (Object.keys(errors).length) throw new PenugasanGalat(422, 'Data tidak valid.', { errors });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const u = (await c.query('SELECT level, coalesce(is_demo, false) AS demo FROM users WHERE id = $1', [idUser])).rows[0];
    if (!u) errors.id_user = ['Pengguna tidak terdaftar.'];
    else if (u.level !== 'petani' || u.demo) errors.id_user = ['Penugasan hanya untuk akun petani (bukan demo).'];
    if (!(await c.query('SELECT 1 FROM mejas WHERE id_meja = $1', [idMeja])).rows[0]) errors.id_meja = ['Penampung tidak terdaftar.'];
    if (Object.keys(errors).length) throw new PenugasanGalat(422, 'Data tidak valid.', { errors });
    const r = (await c.query(
      'INSERT INTO penugasan_penampung (id_user, id_meja, dibuat_oleh) VALUES ($1, $2, $3) RETURNING *', [idUser, idMeja, admin.sub])).rows[0];
    await audit(c, admin, 'create', r.id, null, { id_user: idUser, id_meja: idMeja });
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    if (e.code === '23505' && e.constraint === 'penugasan_aktif_unik') throw new PenugasanGalat(409, 'Penugasan aktif sudah ada.', { kode: 'sudah_ditugaskan' });
    throw e;
  } finally { c.release(); }
}

async function cabut(id, alasan, admin) {
  const a = typeof alasan === 'string' ? alasan.trim() : '';
  if (a.length < 5 || a.length > 500) throw new PenugasanGalat(422, 'Data tidak valid.', { errors: { alasan: ['Alasan 5–500 karakter.'] } });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const lama = (await c.query('SELECT * FROM penugasan_penampung WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!lama) throw new PenugasanGalat(404, 'Data tidak ditemukan.', { errors: {} });
    if (!lama.aktif) throw new PenugasanGalat(409, 'Penugasan sudah dicabut.', { kode: 'sudah_dicabut' });
    const r = (await c.query(
      `UPDATE penugasan_penampung SET aktif = false, dicabut_pada = now(), dicabut_oleh = $2, alasan_cabut = $3 WHERE id = $1 RETURNING *`,
      [id, admin.sub, a])).rows[0];
    await audit(c, admin, 'update', id, { aktif: true }, { aktif: false, alasan_cabut: a });
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
}

/** Admin: semua (filter opsional); petani: hanya miliknya. */
async function daftar(user, { aktif } = {}) {
  const w = [];
  const p = [];
  if (!adalahAdmin(user)) { p.push(user.sub); w.push(`p.id_user = $${p.length}`); }
  if (aktif !== undefined) { p.push(aktif); w.push(`p.aktif = $${p.length}`); }
  return q(`SELECT p.*, u.username, m.meja FROM penugasan_penampung p JOIN users u ON u.id = p.id_user
              JOIN mejas m ON m.id_meja = p.id_meja ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY p.id DESC LIMIT 500`, p);
}

module.exports = { AksesDitolak, PenugasanGalat, wajibDitugaskan, tugaskan, cabut, daftar, adalahAdmin, adalahPetani };
