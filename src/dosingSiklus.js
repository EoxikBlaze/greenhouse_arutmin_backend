'use strict';
/**
 * ALUR PERSETUJUAN DOSING (Fase 3C) — state machine docs/DESAIN_FASE2.md §2.2 / §3.B di atas tabel 3A
 * (dosing_events = siklus dosing, persetujuan_dosing, dosing_rounds = percobaan) + dosing_transisi (migrasi 06).
 *
 * Prinsip:
 *  - Setiap operasi tulis = SATU transaksi: kunci penampung_states → dosing_events (urutan tetap, §4.4) →
 *    cek jalur → ubah → satu baris dosing_transisi berkunci idempotensi → audit di transaksi yang sama.
 *  - Persetujuan per siklus dosing, cakupan beku (trigger persetujuan_dosing_beku), hanya bisa dicabut.
 *  - Cakupan tidak boleh melebihi batas global (konfigurasi_dosis, wajib SIAP) & sisa jatah harian.
 *    Parameter yang belum SIAP (mis. maks_masa_persetujuan_menit NULL) → operasi ditolak, tanpa angka bawaan.
 *  - EKSEKUSI TETAP DIBLOKIR: jalankan() selalu berhenti di gerbang dosis (EKSEKUSI_DIIZINKAN = false).
 *    Tidak ada jalur di modul ini yang mengantre perintah DOSIS. Satu-satunya perintah aktuator adalah STOP
 *    saat siklus RUNNING dicabut (menghentikan, bukan menjalankan).
 *  - FAULT: 4 percobaan gagal berturut (maks_gagal_berturut), hasil KELEBIHAN, atau gerbang wajib_lock →
 *    siklus FAULT + kunciPenampung (transaksi terpisah setelah commit, seperti aktuator.js).
 */
const crypto = require('crypto');
const { pool, q } = require('./db');
const { wajibSiap, nilaiBilaSiap } = require('./parameter');
const { wajibDitugaskan } = require('./penugasan');
const { gerbangSiklus } = require('./gerbangDosis');
const aktuator = require('./aktuator');
const { hashPermintaan } = require('./siklusBudidaya');

/** Jalur sah: JALUR[dari][ke] = aktor yang boleh. */
const JALUR = {
  WAITING_APPROVAL: { APPROVED: ['user'], REJECTED: ['user'], EXPIRED: ['system'], CANCELLED: ['user', 'system'] },
  APPROVED: { RUNNING: ['system'], EXPIRED: ['system'], CANCELLED: ['user', 'system'], FAULT: ['system'] },
  RUNNING: { MIXING: ['system'], FAULT: ['system'], CANCELLED: ['user', 'system'] },
  MIXING: { VERIFYING: ['system'], FAULT: ['system'], CANCELLED: ['user', 'system'] },
  VERIFYING: { SUCCESS: ['system'], APPROVED: ['system'], EXHAUSTED: ['system'], FAULT: ['system'], CANCELLED: ['user', 'system'] },
  SUCCESS: {}, EXHAUSTED: {}, REJECTED: {}, EXPIRED: {}, CANCELLED: {}, FAULT: {},
};
const AKTIF = ['WAITING_APPROVAL', 'APPROVED', 'RUNNING', 'MIXING', 'VERIFYING'];
const BERJALAN = ['RUNNING', 'MIXING', 'VERIFYING'];
/** dosing_events.hasil (kolom lama, NOT NULL) diselaraskan saat siklus berakhir. */
const HASIL_LAMA = { SUCCESS: 'sukses', EXHAUSTED: 'gagal', FAULT: 'lock', REJECTED: 'dibatalkan', EXPIRED: 'dibatalkan', CANCELLED: 'dibatalkan' };
/** Siklus budidaya yang boleh punya siklus dosing (DRAFT belum menyetel target; akhir = tidak). */
const SIKLUS_BOLEH = new Set(['TANK_PREPARATION', 'WAITING_TANK_CONFIRMATION', 'SEEDING',
  'WAITING_REJUVENATION_CONFIRMATION', 'WAITING_SEED_COUNT_CONFIRMATION', 'GROWTH']);
/** Disimpan apa adanya di persetujuan (B.6) agar terlacak. */
const KONDISI_HENTI = ['bacaan_mustahil', 'sensor_basi', 'di_luar_batas_operasi', 'laporan_gagal_abnormal', 'timeout_tanpa_laporan',
  'perintah_ditolak', 'estop', 'aktuator_hilang', 'hasil_kelebihan', 'gagal_berturut_maks'];
const LARUTAN = aktuator.LARUTAN;
const HARI_WITA = "(now() AT TIME ZONE 'Asia/Makassar')::date";
const SISTEM = { tipe: 'system' };

class DosingGalat extends Error {
  constructor(status, pesan, ekstra = {}) {
    super(pesan);
    this.status = status;
    Object.assign(this, ekstra);
  }
}
const tidakSah = (errors) => new DosingGalat(422, 'Data tidak valid.', { errors });
const runner = (c) => (t, p) => c.query(t, p);

/* ── transaksi & idempotensi ─────────────────────────────────────────── */

async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

async function cariIdem(key, hash) {
  const r = (await q('SELECT id_kejadian, permintaan_hash FROM dosing_transisi WHERE idempotency_key = $1', [key]))[0];
  if (!r) return null;
  if (r.permintaan_hash !== hash) throw new DosingGalat(422, 'Idempotency-Key sudah dipakai untuk permintaan lain.', { kode: 'idempotency_bentrok' });
  return { id_kejadian: Number(r.id_kejadian), replay: true };
}

/**
 * Replay idempotensi → transaksi → (balapan kunci sama) replay.
 * fn(c) mengembalikan { id_kejadian, galat?, kunci? }: perubahan status di-commit DULU, lalu kunci penampung
 * diterapkan dan galat dilempar (mis. persetujuan kedaluwarsa → EXPIRED tersimpan, balasan 410).
 */
async function operasi(idem, hash, fn) {
  const ada = await cariIdem(idem, hash);
  if (ada) return ada;
  let r;
  try {
    r = await tx(fn);
  } catch (e) {
    if (e.code === '23505' || e instanceof DosingGalat) {
      const ulang = await cariIdem(idem, hash);
      if (ulang) return ulang;
    }
    if (e.code === '23505' && e.constraint === 'dosing_events_aktif_unik') {
      throw new DosingGalat(409, 'Penampung ini sudah punya siklus dosing aktif.', { kode: 'dosing_aktif_ada' });
    }
    throw e;
  }
  if (r.kunci) await aktuator.kunciPenampung(r.kunci.id_meja, r.kunci);
  if (r.galat) throw r.galat;
  return r;
}

async function auditTx(c, aktor, { aksi, row_id, before = null, after = null, meta = {} }) {
  const user = aktor.tipe === 'user';
  await c.query(
    `INSERT INTO audit_logs (actor_user_id, actor_tipe, actor_label, aksi, tabel, row_id, before_data, after_data, ip, user_agent, request_id, meta)
     VALUES ($1,$2,$3,$4,'dosing_events',$5,$6,$7,$8,$9,$10,$11)`,
    [user ? aktor.user.sub : null, aktor.tipe, user ? aktor.user.username ?? null : 'alur-dosing', aksi, String(row_id),
      before, after, aktor.ip ?? null, aktor.ua ?? null, crypto.randomUUID(), { ...meta, ...(aktor.user?.level ? { level: aktor.user.level } : {}) }]);
}

async function notif(c, { severity = 'info', judul, isi, id, dedup }) {
  await c.query(
    `INSERT INTO notifikasi (jenis, severity, judul, isi, tautan, dedup_key) VALUES ('dosing', $1, $2, $3, $4, $5)
     ON CONFLICT (dedup_key) DO NOTHING`, [severity, judul.slice(0, 150), isi, { tipe: 'dosing', id }, dedup ?? null]);
}

const AKSI = { APPROVED: 'approve', REJECTED: 'reject' };

/** Ubah status siklus dosing yang SUDAH dikunci + transisi (+ idempotensi) + audit. */
async function ubah(c, ev, ke, aktor, { alasan = null, data = null, idem = null, hash = null, gagal = null } = {}) {
  if (!JALUR[ev.status]?.[ke]?.includes(aktor.tipe)) {
    throw new DosingGalat(409, `Transisi ${ev.status} → ${ke} tidak sah.`, { kode: 'transisi_tidak_sah', status_sekarang: ev.status });
  }
  const akhir = HASIL_LAMA[ke] ?? null;
  const baru = (await c.query(
    `UPDATE dosing_events SET status = $2::text, updated_at = now(), gagal_berturut = coalesce($3::int, gagal_berturut),
            hasil = coalesce($4::text, hasil), selesai_pada = CASE WHEN $4::text IS NULL THEN selesai_pada ELSE now() END,
            alasan_akhir = CASE WHEN $4::text IS NULL THEN alasan_akhir ELSE $5 END, lock_terpicu = lock_terpicu OR $2::text = 'FAULT'
      WHERE id = $1 RETURNING *`, [ev.id, ke, gagal, akhir, alasan])).rows[0];
  await c.query(
    `INSERT INTO dosing_transisi (id_kejadian, dari, ke, aktor_tipe, aktor_user_id, alasan, data, idempotency_key, permintaan_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [ev.id, ev.status, ke, aktor.tipe, aktor.tipe === 'user' ? aktor.user.sub : null, alasan, data, idem, hash]);
  await auditTx(c, aktor, {
    aksi: AKSI[ke] ?? (ke === 'CANCELLED' && aktor.tipe === 'user' ? 'revoke' : 'transition'),
    row_id: ev.id, before: { status: ev.status }, after: { status: ke }, meta: { alasan, ...(data || {}) },
  });
  if (ke === 'FAULT') {
    await notif(c, { severity: 'critical', judul: 'Dosing FAULT — penampung dikunci', isi: `Siklus dosing #${ev.id} (penampung ${ev.id_meja}): ${alasan}. Pemeriksaan admin diperlukan.`, id: Number(ev.id), dedup: `dosing-fault:${ev.id}` });
  }
  return baru;
}

/** Kunci penampung → siklus dosing (urutan §4.4) + persetujuan. Status `lewat` dihitung di DB (jam server). */
async function kunci(c, id) {
  const m = (await c.query('SELECT id_meja FROM dosing_events WHERE id = $1 AND status IS NOT NULL', [id])).rows[0];
  if (!m) throw new DosingGalat(404, 'Data tidak ditemukan.', { errors: {} });
  await c.query('INSERT INTO penampung_states (id_meja) VALUES ($1) ON CONFLICT (id_meja) DO NOTHING', [m.id_meja]);
  const st = (await c.query('SELECT status_lock, lock_alasan FROM penampung_states WHERE id_meja = $1 FOR UPDATE', [m.id_meja])).rows[0];
  const ev = (await c.query('SELECT *, coalesce(berlaku_sampai <= now(), false) AS lewat FROM dosing_events WHERE id = $1 FOR UPDATE', [id])).rows[0];
  const p = (await c.query('SELECT *, coalesce(berlaku_sampai <= now(), false) AS lewat FROM persetujuan_dosing WHERE id_kejadian = $1', [id])).rows[0] ?? null;
  return { ev, st, p };
}

async function wajibTidakTerkunci(c, st) {
  if (st.status_lock) throw new DosingGalat(423, `Penampung terkunci${st.lock_alasan ? ` (${st.lock_alasan})` : ''}.`, { kode: 'penampung_terkunci' });
  const estop = (await c.query("SELECT nilai FROM aktuator_state WHERE kunci = 'estop'")).rows[0]?.nilai === '1';
  if (estop) throw new DosingGalat(423, 'E-STOP aktif.', { kode: 'estop' });
}

const obj = (b) => (b && typeof b === 'object' && !Array.isArray(b) ? b : {});
function teks(v, field, { min = 0, max = 500 } = {}, errors) {
  if (v === undefined || v === null) {
    if (min > 0) errors[field] = [`${field} wajib diisi (minimal ${min} karakter).`];
    return null;
  }
  const t = typeof v === 'string' ? v.trim() : '';
  if (typeof v !== 'string' || t.length < min || t.length > max) errors[field] = [`${field} harus teks ${min}–${max} karakter.`];
  return t || null;
}

/* ── ajukan ──────────────────────────────────────────────────────────── */

/** Petani/admin menyusun permintaan dosing MANUAL untuk penampung semai siklus budidaya. */
async function ajukan(body, aktor, idem) {
  const b = obj(body);
  const errors = {};
  const idS = b.id_siklus_budidaya;
  if (!Number.isInteger(idS) || idS < 1) errors.id_siklus_budidaya = ['id_siklus_budidaya wajib bilangan bulat ≥ 1.'];
  const alasan = teks(b.alasan, 'alasan', {}, errors);
  if (Object.keys(errors).length) throw tidakSah(errors);
  const hash = hashPermintaan('dosing.ajukan', null, b);
  return operasi(idem, hash, async (c) => {
    const s = (await c.query('SELECT id, status, perlu_tinjau, id_meja_semai FROM siklus_budidaya WHERE id = $1 FOR SHARE', [idS])).rows[0];
    if (!s) throw tidakSah({ id_siklus_budidaya: ['Siklus budidaya tidak ditemukan.'] });
    if (s.perlu_tinjau) throw new DosingGalat(409, 'Siklus hasil migrasi ini perlu ditinjau dulu.', { kode: 'perlu_tinjau' });
    if (!SIKLUS_BOLEH.has(s.status) || s.id_meja_semai == null) {
      throw new DosingGalat(409, `Siklus budidaya berstatus ${s.status}; dosing tidak bisa diajukan.`, { kode: 'siklus_tidak_aktif', status_sekarang: s.status });
    }
    await wajibDitugaskan(c, aktor.user, [s.id_meja_semai]);
    const { maks_masa_persetujuan_menit: menit } = await wajibSiap({ konfigurasi_dosis: ['maks_masa_persetujuan_menit'] }, runner(c));
    await c.query('INSERT INTO penampung_states (id_meja) VALUES ($1) ON CONFLICT (id_meja) DO NOTHING', [s.id_meja_semai]);
    const st = (await c.query('SELECT status_lock, lock_alasan FROM penampung_states WHERE id_meja = $1 FOR UPDATE', [s.id_meja_semai])).rows[0];
    await wajibTidakTerkunci(c, st);
    const ev = (await c.query(
      `INSERT INTO dosing_events (id_meja, hari, pemicu, aktor_tipe, dipicu_oleh, alasan, status, mode, id_siklus_budidaya, berlaku_sampai)
       VALUES ($1, ${HARI_WITA}, 'USER_MANUAL', 'user', $2, $3, 'WAITING_APPROVAL', 'MANUAL', $4, now() + make_interval(mins => $5::int))
       RETURNING *`, [s.id_meja_semai, aktor.user.sub, alasan, s.id, menit])).rows[0];
    await c.query(
      `INSERT INTO dosing_transisi (id_kejadian, dari, ke, aktor_tipe, aktor_user_id, alasan, idempotency_key, permintaan_hash)
       VALUES ($1, NULL, 'WAITING_APPROVAL', 'user', $2, $3, $4, $5)`, [ev.id, aktor.user.sub, alasan, idem, hash]);
    await auditTx(c, aktor, { aksi: 'create', row_id: ev.id, after: { status: 'WAITING_APPROVAL', id_meja: Number(ev.id_meja), id_siklus_budidaya: idS } });
    await notif(c, { judul: 'Dosing menunggu persetujuan', isi: `Siklus dosing #${ev.id} untuk penampung ${ev.id_meja} menunggu persetujuan.`, id: Number(ev.id), dedup: `dosing-ajukan:${ev.id}` });
    return { id_kejadian: Number(ev.id), baru: true };
  });
}

/* ── setujui / tolak / cabut ─────────────────────────────────────────── */

/** Validasi bentuk cakupan (tanpa DB). Batas global & sisa harian dicek di setujui(). */
function validasiCakupan(cakupan) {
  const k = obj(cakupan);
  const errors = {};
  const pompa = k.pompa_diizinkan;
  if (!Array.isArray(pompa) || pompa.length === 0 || new Set(pompa).size !== pompa.length || !pompa.every((x) => LARUTAN.includes(x))) {
    errors.pompa_diizinkan = [`pompa_diizinkan wajib daftar unik dari ${LARUTAN.join(', ')}.`];
  }
  const pos = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
  if (!pos(k.maks_ml_per_percobaan)) errors.maks_ml_per_percobaan = ['maks_ml_per_percobaan wajib angka > 0.'];
  if (!pos(k.maks_ml_total)) errors.maks_ml_total = ['maks_ml_total wajib angka > 0.'];
  else if (pos(k.maks_ml_per_percobaan) && k.maks_ml_total < k.maks_ml_per_percobaan) errors.maks_ml_total = ['maks_ml_total tidak boleh < maks_ml_per_percobaan.'];
  if (!Number.isInteger(k.maks_percobaan) || k.maks_percobaan < 1) errors.maks_percobaan = ['maks_percobaan wajib bilangan bulat ≥ 1.'];
  if (!Number.isInteger(k.berlaku_menit) || k.berlaku_menit < 1) errors.berlaku_menit = ['berlaku_menit wajib bilangan bulat ≥ 1.'];
  return { errors, cakupan: k };
}

async function setujui(id, body, aktor, idem) {
  const b = obj(body);
  const { errors, cakupan: k } = validasiCakupan(b.cakupan);
  const alasan = teks(b.alasan, 'alasan', {}, errors);
  if (Object.keys(errors).length) throw tidakSah(errors);
  const hash = hashPermintaan('dosing.setujui', id, b);
  return operasi(idem, hash, async (c) => {
    const { ev, st, p } = await kunci(c, id);
    if (ev.status !== 'WAITING_APPROVAL' || p) {
      throw new DosingGalat(409, `Siklus dosing berstatus ${ev.status}; hanya WAITING_APPROVAL yang bisa disetujui.`, { kode: 'transisi_tidak_sah', status_sekarang: ev.status });
    }
    await wajibDitugaskan(c, aktor.user, [ev.id_meja]);
    if (ev.lewat) {
      await ubah(c, ev, 'EXPIRED', SISTEM, { alasan: 'permintaan tidak dijawab sebelum batas' });
      return { id_kejadian: Number(ev.id), galat: new DosingGalat(410, 'Permintaan dosing sudah kedaluwarsa.', { kode: 'kedaluwarsa' }) };
    }
    await wajibTidakTerkunci(c, st);

    const ab = k.pompa_diizinkan.includes('AB');
    const ph = k.pompa_diizinkan.some((x) => x !== 'AB');
    const param = ['maks_gagal_berturut', 'maks_masa_persetujuan_menit',
      ...(ab ? ['maks_ml_per_suntikan', 'maks_volume_ab_hari_ml'] : []), ...(ph ? ['maks_ml_ph_per_suntikan', 'maks_volume_ph_hari_ml'] : [])];
    const cfg = await wajibSiap({ konfigurasi_dosis: param }, runner(c));
    const pakai = (await c.query(
      `SELECT CASE WHEN baru THEN 0 ELSE volume_ab_hari_ml END AS ab, CASE WHEN baru THEN 0 ELSE volume_ph_hari_ml END AS ph
         FROM (SELECT *, (reset_harian_pada IS NULL OR reset_harian_pada::date < ${HARI_WITA}) AS baru FROM penampung_states WHERE id_meja = $1) s`,
      [ev.id_meja])).rows[0];
    const batasSuntik = Math.min(ab ? cfg.maks_ml_per_suntikan : Infinity, ph ? cfg.maks_ml_ph_per_suntikan : Infinity);
    const sisa = Math.min(ab ? cfg.maks_volume_ab_hari_ml - Number(pakai.ab) : Infinity, ph ? cfg.maks_volume_ph_hari_ml - Number(pakai.ph) : Infinity);
    const lebih = {};
    if (k.maks_ml_per_percobaan > batasSuntik) lebih.maks_ml_per_percobaan = [`Melebihi batas per suntikan (${batasSuntik} mL).`];
    if (k.maks_ml_total > sisa) lebih.maks_ml_total = [`Melebihi sisa jatah harian (${Math.max(0, sisa)} mL).`];
    if (k.maks_percobaan > cfg.maks_gagal_berturut) lebih.maks_percobaan = [`Maksimal ${cfg.maks_gagal_berturut} percobaan.`];
    if (k.berlaku_menit > cfg.maks_masa_persetujuan_menit) lebih.berlaku_menit = [`Maksimal ${cfg.maks_masa_persetujuan_menit} menit.`];
    if (Object.keys(lebih).length) throw tidakSah(lebih);

    await c.query(
      `INSERT INTO persetujuan_dosing (id_kejadian, keputusan, oleh, pompa_diizinkan, maks_ml_per_percobaan, maks_ml_total, maks_percobaan,
         berlaku_sampai, kondisi_henti, alasan, idempotency_key)
       VALUES ($1, 'SETUJU', $2, $3, $4, $5, $6, now() + make_interval(mins => $7::int), $8, $9, $10)`,
      [ev.id, aktor.user.sub, k.pompa_diizinkan, k.maks_ml_per_percobaan, k.maks_ml_total, k.maks_percobaan, k.berlaku_menit,
        JSON.stringify(KONDISI_HENTI), alasan, idem]);
    await ubah(c, ev, 'APPROVED', aktor, { alasan, data: { cakupan: k }, idem, hash });
    return { id_kejadian: Number(ev.id) };
  });
}

async function tolak(id, body, aktor, idem) {
  const b = obj(body);
  const errors = {};
  const alasan = teks(b.alasan, 'alasan', {}, errors);
  if (Object.keys(errors).length) throw tidakSah(errors);
  const hash = hashPermintaan('dosing.tolak', id, b);
  return operasi(idem, hash, async (c) => {
    const { ev, p } = await kunci(c, id);
    if (ev.status !== 'WAITING_APPROVAL' || p) {
      throw new DosingGalat(409, `Siklus dosing berstatus ${ev.status}; hanya WAITING_APPROVAL yang bisa ditolak.`, { kode: 'transisi_tidak_sah', status_sekarang: ev.status });
    }
    await wajibDitugaskan(c, aktor.user, [ev.id_meja]);
    await c.query(
      `INSERT INTO persetujuan_dosing (id_kejadian, keputusan, oleh, alasan, idempotency_key) VALUES ($1, 'TOLAK', $2, $3, $4)`,
      [ev.id, aktor.user.sub, alasan, idem]);
    await ubah(c, ev, 'REJECTED', aktor, { alasan, idem, hash });
    return { id_kejadian: Number(ev.id) };
  });
}

/** Cabut (siklus aktif mana pun) → CANCELLED, persetujuan dicabut. RUNNING → STOP diantre setelah commit. */
async function cabut(id, body, aktor, idem) {
  const b = obj(body);
  const errors = {};
  const alasan = teks(b.alasan, 'alasan', { min: 5 }, errors);
  if (Object.keys(errors).length) throw tidakSah(errors);
  const hash = hashPermintaan('dosing.cabut', id, b);
  let stop = false;
  const r = await operasi(idem, hash, async (c) => {
    const { ev, p } = await kunci(c, id);
    await wajibDitugaskan(c, aktor.user, [ev.id_meja]);
    if (p?.keputusan === 'SETUJU' && !p.dicabut_pada) {
      await c.query('UPDATE persetujuan_dosing SET dicabut_pada = now(), dicabut_oleh = $2, alasan_cabut = $3 WHERE id = $1', [p.id, aktor.user.sub, alasan]);
    }
    stop = ev.status === 'RUNNING';
    await ubah(c, ev, 'CANCELLED', aktor, { alasan, idem, hash });
    return { id_kejadian: Number(ev.id) };
  });
  if (stop) {
    // STOP menghentikan output; firmware juga mematikan pompa sendiri saat durasi habis
    r.stop = await aktuator.buatPerintah({ tipe: 'STOP', parameter: {}, sumber: 'pengguna', userId: aktor.user.sub, alasan: `cabut dosing #${r.id_kejadian}` })
      .then((x) => ({ id_perintah: Number(x.id) }))
      .catch((e) => ({ galat: e.message }));
  }
  return r;
}

/* ── jalankan (DIBLOKIR) ─────────────────────────────────────────────── */

/**
 * Percobaan berikut untuk siklus APPROVED. Fase ini: SELALU berhenti di gerbang dosis.
 *  - gerbang wajib_lock (3 bacaan mustahil) → FAULT + LOCK (syarat gerbang 3C);
 *  - gerbang menolak (selalu, EKSEKUSI_DIIZINKAN = false) → 423 eksekusi_diblokir, status tidak berubah.
 */
async function jalankan(id, aktor, idem) {
  const hash = hashPermintaan('dosing.jalankan', id, {});
  return operasi(idem, hash, async (c) => {
    const { ev, st, p } = await kunci(c, id);
    if (ev.status !== 'APPROVED' || p?.keputusan !== 'SETUJU' || p.dicabut_pada) {
      throw new DosingGalat(409, `Siklus dosing berstatus ${ev.status}; hanya APPROVED yang bisa dijalankan.`, { kode: 'transisi_tidak_sah', status_sekarang: ev.status });
    }
    await wajibDitugaskan(c, aktor.user, [ev.id_meja]);
    if (p.lewat) {
      await ubah(c, ev, 'EXPIRED', SISTEM, { alasan: 'masa berlaku persetujuan habis' });
      return { id_kejadian: Number(ev.id), galat: new DosingGalat(410, 'Persetujuan dosing sudah kedaluwarsa.', { kode: 'kedaluwarsa' }) };
    }
    await wajibTidakTerkunci(c, st);
    const g = await gerbangSiklus(ev.id_siklus_budidaya);
    if (g?.wajib_lock) {
      const alasan = `gerbang dosis: ${g.alasan.join(', ')}`;
      await ubah(c, ev, 'FAULT', SISTEM, { alasan, data: { gerbang: g.alasan } });
      return {
        id_kejadian: Number(ev.id),
        kunci: { id_meja: Number(ev.id_meja), alasan: 'Sensor dicurigai rusak (3 bacaan mustahil)', type: 'sensor_rusak', value: `dosing #${ev.id}` },
        galat: new DosingGalat(423, 'Sensor dicurigai rusak — siklus FAULT dan penampung dikunci.', { kode: 'sensor_rusak', alasan: g.alasan }),
      };
    }
    if (!g?.boleh) {
      throw new DosingGalat(423, 'Eksekusi dosis diblokir oleh gerbang dosis.', { kode: 'eksekusi_diblokir', alasan: g ? g.alasan : ['siklus_budidaya_tidak_ada'] });
    }
    // Sampai di sini hanya bila EKSEKUSI_DIIZINKAN diubah. Jalur buatPerintah ber-transaksi pemanggil (§4.4c),
    // pengukuran sensor sebelum, dan rumus delta harapan belum ada → tolak keras, jangan diam-diam lanjut.
    throw new DosingGalat(501, 'Jalur eksekusi dosis belum diimplementasikan.', { kode: 'eksekusi_belum_ada' });
  });
}

/* ── evaluasi percobaan ──────────────────────────────────────────────── */

/**
 * Evaluasi murni satu percobaan (§B.4). nilai = TDS (ppm) untuk AB, pH untuk PH_UP/PH_DOWN.
 * pita {min,max} = target; delta = perubahan yang diharapkan dari rumus (tanda = arah).
 * Lampauan ≤ maksLampauPersen dianggap OK (dosis berhenti, tidak menambah); > → KELEBIHAN (FAULT).
 * @returns {{evaluasi:'OK'|'KURANG'|'GAGAL'|'KELEBIHAN', progres:number|null}}
 */
function evaluasiPercobaan({ sebelum, sesudah, delta, pita, minProgresPersen, maksLampauPersen }) {
  const ok = (...v) => v.every((x) => typeof x === 'number' && Number.isFinite(x));
  if (!ok(sebelum, sesudah, delta, pita?.min, pita?.max, minProgresPersen, maksLampauPersen) || delta === 0 || pita.min > pita.max) {
    throw new Error('evaluasiPercobaan: masukan tidak lengkap/tidak sah');
  }
  const progres = (sesudah - sebelum) / delta;
  const lampau = delta > 0 ? sesudah - pita.max : pita.min - sesudah;
  const acuan = delta > 0 ? pita.max : pita.min;
  if (lampau > 0) return { evaluasi: (lampau / acuan) * 100 > maksLampauPersen ? 'KELEBIHAN' : 'OK', progres };
  if (sesudah >= pita.min && sesudah <= pita.max) return { evaluasi: 'OK', progres };
  return { evaluasi: progres * 100 >= minProgresPersen ? 'KURANG' : 'GAGAL', progres };
}

/**
 * Terapkan hasil evaluasi percobaan pada siklus VERIFYING (dipanggil langkah eksekusi setelah MIXING —
 * belum tersambung karena eksekusi diblokir). GAGAL ke-maks_gagal_berturut / KELEBIHAN → FAULT + LOCK.
 */
async function terapkanEvaluasi(idKejadian, idPercobaan, evaluasi) {
  if (!['OK', 'KURANG', 'GAGAL', 'KELEBIHAN'].includes(evaluasi)) throw new Error(`evaluasi tidak dikenal: ${evaluasi}`);
  let kunciLagi = null;
  const r = await tx(async (c) => {
    const { ev, p } = await kunci(c, idKejadian);
    if (ev.status !== 'VERIFYING') throw new DosingGalat(409, `Siklus dosing berstatus ${ev.status}; evaluasi hanya saat VERIFYING.`, { kode: 'transisi_tidak_sah', status_sekarang: ev.status });
    const rd = (await c.query(
      "UPDATE dosing_rounds SET evaluasi = $3, status = 'SELESAI', selesai_pada = now() WHERE id = $2 AND id_kejadian = $1 AND status IS DISTINCT FROM 'SELESAI' RETURNING id",
      [ev.id, idPercobaan, evaluasi])).rows[0];
    if (!rd) throw new DosingGalat(409, 'Percobaan tidak ditemukan atau sudah dievaluasi.', { kode: 'percobaan_tidak_sah' });
    const data = { id_percobaan: Number(idPercobaan), evaluasi };
    const fault = async (alasan, type) => {
      await ubah(c, ev, 'FAULT', SISTEM, { alasan, data, gagal: evaluasi === 'GAGAL' ? ev.gagal_berturut + 1 : null });
      kunciLagi = { id_meja: Number(ev.id_meja), alasan, type, value: `dosing #${ev.id}` };
      return { id_kejadian: Number(ev.id), status: 'FAULT' };
    };
    if (evaluasi === 'OK') return { id_kejadian: Number((await ubah(c, ev, 'SUCCESS', SISTEM, { alasan: 'target tercapai', data })).id), status: 'SUCCESS' };
    if (evaluasi === 'KELEBIHAN') return fault('hasil melampaui target di atas batas lampau', 'dosis_kelebihan');
    const gagal = evaluasi === 'GAGAL' ? ev.gagal_berturut + 1 : 0;
    const { maks_gagal_berturut: maks } = await nilaiBilaSiap({ konfigurasi_dosis: ['maks_gagal_berturut'] }, runner(c));
    // parameter hilang/tidak sah saat dosis sudah berjalan → tidak bisa membuktikan aman → FAULT
    if (evaluasi === 'GAGAL' && (maks == null || gagal >= maks)) return fault(`${gagal} percobaan gagal berturut`, 'retry_habis');
    const pakai = (await c.query('SELECT count(*)::int n, coalesce(sum(volume_ml), 0) ml FROM dosing_rounds WHERE id_kejadian = $1', [ev.id])).rows[0];
    let ke = 'APPROVED';
    let alasan = `percobaan ${evaluasi}`;
    if (!p || p.dicabut_pada) { ke = 'CANCELLED'; alasan = 'persetujuan tidak berlaku'; }
    else if (p.lewat) { ke = 'CANCELLED'; alasan = 'masa berlaku persetujuan habis'; }
    else if (pakai.n >= p.maks_percobaan || Number(pakai.ml) + Number(p.maks_ml_per_percobaan) > Number(p.maks_ml_total)) { ke = 'EXHAUSTED'; alasan = 'cakupan persetujuan habis'; }
    await ubah(c, ev, ke, SISTEM, { alasan, data, gagal });
    return { id_kejadian: Number(ev.id), status: ke };
  });
  if (kunciLagi) await aktuator.kunciPenampung(kunciLagi.id_meja, kunciLagi);
  return r;
}

/* ── penjadwal & pembatalan dari siklus budidaya ─────────────────────── */

/** WAITING_APPROVAL lewat batas jawab / APPROVED lewat masa persetujuan → EXPIRED. Idempoten. */
async function kedaluwarsakan() {
  const rows = await q(
    `SELECT d.id FROM dosing_events d LEFT JOIN persetujuan_dosing p ON p.id_kejadian = d.id
      WHERE (d.status = 'WAITING_APPROVAL' AND d.berlaku_sampai <= now()) OR (d.status = 'APPROVED' AND p.berlaku_sampai <= now())
      ORDER BY d.id`);
  let n = 0;
  for (const r of rows) {
    await tx(async (c) => {
      const { ev, p } = await kunci(c, r.id);
      const lewat = (ev.status === 'WAITING_APPROVAL' && ev.lewat) || (ev.status === 'APPROVED' && p?.lewat);
      if (!lewat) return;
      await ubah(c, ev, 'EXPIRED', SISTEM, { alasan: ev.status === 'APPROVED' ? 'masa berlaku persetujuan habis' : 'permintaan tidak dijawab sebelum batas' });
      await notif(c, { severity: 'warning', judul: 'Dosing kedaluwarsa', isi: `Siklus dosing #${ev.id} kedaluwarsa tanpa eksekusi.`, id: Number(ev.id), dedup: `dosing-kedaluwarsa:${ev.id}` });
      n += 1;
    });
  }
  return n;
}

/**
 * Dipanggil DI DALAM transaksi pembatalan siklus budidaya: siklus dosing WAITING/APPROVED ikut CANCELLED.
 * Siklus yang sedang RUNNING/MIXING/VERIFYING → 409 (cabut dulu agar STOP terkirim).
 */
async function batalkanUntukSiklus(c, idSiklus, aktor, alasan) {
  const rows = (await c.query(
    'SELECT * FROM dosing_events WHERE id_siklus_budidaya = $1 AND status = ANY($2::text[]) FOR UPDATE', [idSiklus, AKTIF])).rows;
  const jalan = rows.find((r) => BERJALAN.includes(r.status));
  if (jalan) throw new DosingGalat(409, `Siklus dosing #${jalan.id} sedang ${jalan.status}; cabut dulu lewat /api/dosing.`, { kode: 'dosing_berjalan' });
  for (const ev of rows) {
    await c.query(
      'UPDATE persetujuan_dosing SET dicabut_pada = now(), dicabut_oleh = $2, alasan_cabut = $3 WHERE id_kejadian = $1 AND keputusan = \'SETUJU\' AND dicabut_pada IS NULL',
      [ev.id, aktor.user.sub, alasan]);
    await ubah(c, ev, 'CANCELLED', aktor, { alasan: `siklus budidaya dibatalkan: ${alasan}` });
  }
  return rows.length;
}

/* ── baca ─────────────────────────────────────────────────────────────── */

let tersedia = false;
async function fiturTersedia() {
  if (!tersedia) tersedia = (await q("SELECT to_regclass('dosing_transisi') IS NOT NULL AS ada"))[0].ada;
  return tersedia;
}

async function daftar({ id_meja: meja, status } = {}) {
  return q(
    `SELECT d.id, d.id_meja, d.id_siklus_budidaya, d.status, d.mode, d.gagal_berturut, d.berlaku_sampai, d.alasan, d.alasan_akhir,
            d.mulai_pada, d.selesai_pada, p.keputusan, p.berlaku_sampai AS persetujuan_berlaku_sampai, p.dicabut_pada
       FROM dosing_events d LEFT JOIN persetujuan_dosing p ON p.id_kejadian = d.id
      WHERE d.status IS NOT NULL AND ($1::bigint IS NULL OR d.id_meja = $1) AND ($2::text IS NULL OR d.status = $2)
      ORDER BY d.id DESC LIMIT 200`, [meja ?? null, status ?? null]);
}

async function detail(id) {
  const ev = (await q('SELECT * FROM dosing_events WHERE id = $1 AND status IS NOT NULL', [id]))[0];
  if (!ev) return null;
  const [persetujuan, percobaan, transisi] = await Promise.all([
    q('SELECT * FROM persetujuan_dosing WHERE id_kejadian = $1', [id]),
    q('SELECT * FROM dosing_rounds WHERE id_kejadian = $1 ORDER BY ronde_ke, id', [id]),
    q('SELECT id, dari, ke, aktor_tipe, aktor_user_id, alasan, data, terjadi_pada FROM dosing_transisi WHERE id_kejadian = $1 ORDER BY id', [id]),
  ]);
  return { ...ev, persetujuan: persetujuan[0] ?? null, percobaan, transisi };
}

module.exports = {
  JALUR, AKTIF, KONDISI_HENTI, DosingGalat, validasiCakupan, evaluasiPercobaan,
  ajukan, setujui, tolak, cabut, jalankan, terapkanEvaluasi, kedaluwarsakan, batalkanUntukSiklus,
  fiturTersedia, daftar, detail,
};
