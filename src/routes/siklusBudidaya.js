'use strict';
/**
 * API siklus budidaya (Fase 3B, docs/DESAIN_FASE2.md §5.2).
 *
 *   GET  /api/siklus                    daftar (?status=&id_tanaman=&id_meja=&asal=&perlu_tinjau=)   semua login
 *   GET  /api/siklus/parameter          status parameter keselamatan (NULL/TIDAK_VALID/BELUM_TERVALIDASI/SIAP)
 *   GET  /api/siklus/:id                detail + lot + transisi + konfirmasi                          semua login
 *   POST /api/siklus                    buat siklus (DRAFT)                                           ★ admin
 *   POST /api/siklus/:id/transisi       {ke: TANK_PREPARATION|CANCELLED, alasan}                      ★ admin
 *   POST /api/siklus/:id/konfirmasi     minta konfirmasi peremajaan manual (setelah H+4)              ★ admin
 *   POST /api/siklus/:id/benih          {jumlah_benih, berhasil, gagal, id_meja_tujuan}               ★ admin
 *   POST /api/konfirmasi/:id/jawab      {jawaban: SIAP|BELUM_SIAP}                                    ★ admin
 *   POST /api/lot/:id/selesai           {berhasil, gagal, tujuan:[{id_meja, jumlah}]}                 ★ admin
 *   GET  /api/siklus/:id/kestabilan     evaluasi kestabilan tandon (baca saja)
 *   GET  /api/penugasan                 admin: semua; petani: miliknya
 *   POST /api/penugasan                 {id_user, id_meja}                                            admin
 *   POST /api/penugasan/:id/cabut       {alasan}                                                      admin
 *   GET  /api/preset                    preset + versi + kategori (AKTIF_TERVALIDASI / AKTIF_RANCANGAN / TIDAK_AKTIF)
 *   POST /api/preset/:id/versi/:v/validasi  {catatan}                                                 admin
 *   POST /api/preset/:id/versi              {parameter, catatan} → versi baru BELUM_TERVALIDASI        admin
 *   POST /api/preset/:id/versi/:v/aktifkan  jadikan versi aktif (siklus berjalan tetap pada snapshot)  admin
 *   GET  /api/siklus/:id/gerbang-dosis      evaluasi gerbang dosis (selalu menolak eksekusi di fase ini)
 *
 * ★ = wajib header Idempotency-Key (UUID). Kunci sama + isi sama → balasan diulang (replay);
 *     kunci sama + isi beda → 422.
 *
 * OTORISASI TULIS (Fase 3B.1): admin (bukan demo) = semua penampung; petani (bukan demo) = hanya penampung
 * dengan penugasan aktif (src/penugasan.js, dicek di dalam transaksi tiap operasi). Demo/'user' = 403.
 * Konfirmasi manual (/konfirmasi) & penugasan & validasi preset = admin saja. Tidak ada hubungan ke aktuator.
 */
const express = require('express');
const { requireAuth, requireRole, demoGuard, json } = require('../auth');
const { idValidValue } = require('./_id');
const svc = require('../siklusBudidaya');
const { bacaParameter, SEMUA } = require('../parameter');
const penugasan = require('../penugasan');
const { pool, q } = require('../db');
const crypto = require('crypto');
const { validasiBatasOperasi, gerbangSiklus } = require('../gerbangDosis');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const baca = [requireAuth, requireRole('all')];
/** Tulis: admin atau petani (bukan demo); hak per penampung dicek di layanan. */
function adminAtauPetani(req, res, next) {
  const u = req.user;
  if (!u.demo && (u.level === 'admin' || u.level === 'petani')) return next();
  return json(res, 403, { message: 'Akses ditolak.', kode: 'akses_ditolak' });
}
const tulis = [requireAuth, adminAtauPetani];
const khususAdmin = [requireAuth, requireRole(['admin']), demoGuard('siklus_budidaya.admin')];

const tidakDitemukan = (res) => json(res, 404, { message: 'Data tidak ditemukan.', errors: {} });

/** Tabel 3A/3B belum ada di DB ini → 503 jelas, bukan 500. */
async function wajibTersedia(_req, res, next) {
  try {
    if (await svc.fiturTersedia()) return next();
    return json(res, 503, { message: 'Fitur siklus budidaya belum dimigrasi di database ini.', kode: 'belum_dimigrasi' });
  } catch (e) { return next(e); }
}

function kunciIdem(req, res) {
  const k = req.get('Idempotency-Key');
  if (!k || !UUID.test(k)) {
    json(res, 422, { message: 'Data tidak valid.', errors: { 'Idempotency-Key': ['Header Idempotency-Key wajib berupa UUID.'] } });
    return null;
  }
  return k.toLowerCase();
}

const aktorDari = (req) => ({ tipe: 'user', user: req.user, ip: req.ip, ua: req.get('user-agent') || null });

function kirimGalat(res, next, e) {
  // galat terkontrol (layanan/penugasan/parameter) membawa status 4xx; galat lain → handler 500 umum
  if (Number.isInteger(e?.status) && e.status >= 400 && e.status < 500 && !e.code) {
    const { status, message, ...rest } = e;
    const body = { message: e.message };
    for (const [k, v] of Object.entries(rest)) if (v !== undefined && k !== 'stack') body[k] = v;
    return json(res, e.status, body);
  }
  return next(e);
}

/** Pembungkus rute tulis: validasi :id + Idempotency-Key, jalankan, balas detail siklus. */
function rutaTulis(fn, { pakaiId = true } = {}) {
  return async (req, res, next) => {
    if (pakaiId && !idValidValue(req.params.id)) return tidakDitemukan(res);
    const idem = kunciIdem(req, res);
    if (!idem) return undefined;
    try {
      const r = await fn(req, idem);
      const data = await svc.detail(r.id_siklus);
      return json(res, r.baru ? 201 : 200, { status: true, replay: Boolean(r.replay), data });
    } catch (e) { return kirimGalat(res, next, e); }
  };
}

/* ── /api/siklus ──────────────────────────────────────────────────────── */
const siklus = express.Router();
siklus.use(wajibTersedia);

siklus.get('/', ...baca, async (req, res, next) => {
  try {
    const f = {};
    const qy = req.query;
    if (qy.status !== undefined) {
      if (typeof qy.status !== 'string' || !(qy.status in svc.JALUR)) return json(res, 422, { message: 'Data tidak valid.', errors: { status: ['Status tidak dikenal.'] } });
      f.status = qy.status;
    }
    for (const k of ['id_tanaman', 'id_meja']) {
      if (qy[k] === undefined) continue;
      if (!idValidValue(qy[k])) return json(res, 422, { message: 'Data tidak valid.', errors: { [k]: [`${k} harus id angka.`] } });
      f[k] = qy[k];
    }
    if (qy.asal !== undefined) {
      if (!['BARU', 'MIGRASI'].includes(qy.asal)) return json(res, 422, { message: 'Data tidak valid.', errors: { asal: ['asal harus BARU atau MIGRASI.'] } });
      f.asal = qy.asal;
    }
    if (qy.perlu_tinjau !== undefined) {
      if (!['true', 'false'].includes(qy.perlu_tinjau)) return json(res, 422, { message: 'Data tidak valid.', errors: { perlu_tinjau: ['perlu_tinjau harus true/false.'] } });
      f.perlu_tinjau = qy.perlu_tinjau === 'true';
    }
    return res.json(await svc.daftar(f));
  } catch (e) { return next(e); }
});

siklus.get('/parameter', ...baca, async (_req, res, next) => {
  try { return res.json(Object.values(await bacaParameter(SEMUA))); } catch (e) { return next(e); }
});

siklus.get('/:id', ...baca, async (req, res, next) => {
  try {
    if (!idValidValue(req.params.id)) return tidakDitemukan(res);
    const d = await svc.detail(req.params.id);
    return d ? res.json(d) : tidakDitemukan(res);
  } catch (e) { return next(e); }
});

siklus.get('/:id/kestabilan', ...baca, async (req, res, next) => {
  try {
    if (!idValidValue(req.params.id)) return tidakDitemukan(res);
    const k = await svc.kestabilan(req.params.id);
    return k ? res.json(k) : tidakDitemukan(res);
  } catch (e) { return next(e); }
});

siklus.get('/:id/gerbang-dosis', ...baca, async (req, res, next) => {
  try {
    if (!idValidValue(req.params.id)) return tidakDitemukan(res);
    const g = await gerbangSiklus(req.params.id);
    return g ? res.json(g) : tidakDitemukan(res);
  } catch (e) { return next(e); }
});

siklus.post('/', ...tulis, rutaTulis((req, idem) => svc.buatSiklus(req.body, aktorDari(req), idem), { pakaiId: false }));
siklus.post('/:id/transisi', ...tulis, rutaTulis((req, idem) => svc.transisiManual(req.params.id, req.body, aktorDari(req), idem)));
siklus.post('/:id/konfirmasi', ...tulis, rutaTulis((req, idem) => svc.mintaKonfirmasi(req.params.id, aktorDari(req), idem)));
siklus.post('/:id/benih', ...tulis, rutaTulis((req, idem) => svc.konfirmasiBenih(req.params.id, req.body, aktorDari(req), idem)));

/* ── /api/konfirmasi, /api/lot ────────────────────────────────────────── */
const konfirmasi = express.Router();
konfirmasi.use(wajibTersedia);
konfirmasi.post('/:id/jawab', ...tulis, rutaTulis((req, idem) => svc.jawabKonfirmasi(req.params.id, req.body, aktorDari(req), idem)));

const lot = express.Router();
lot.use(wajibTersedia);
lot.post('/:id/selesai', ...tulis, rutaTulis((req, idem) => svc.selesaikanLot(req.params.id, req.body, aktorDari(req), idem)));

/* ── /api/penugasan ───────────────────────────────────────────────────── */
const tugas = express.Router();
tugas.use(wajibTersedia);
tugas.get('/', ...baca, async (req, res, next) => {
  try {
    const { aktif } = req.query;
    if (aktif !== undefined && !['true', 'false'].includes(aktif)) return json(res, 422, { message: 'Data tidak valid.', errors: { aktif: ['aktif harus true/false.'] } });
    return res.json(await penugasan.daftar(req.user, { aktif: aktif === undefined ? undefined : aktif === 'true' }));
  } catch (e) { return next(e); }
});
tugas.post('/', ...khususAdmin, async (req, res, next) => {
  try { return json(res, 201, { status: true, data: await penugasan.tugaskan(req.body || {}, req.user) }); } catch (e) { return kirimGalat(res, next, e); }
});
tugas.post('/:id/cabut', ...khususAdmin, async (req, res, next) => {
  if (!idValidValue(req.params.id)) return tidakDitemukan(res);
  try { return res.json({ status: true, data: await penugasan.cabut(req.params.id, req.body?.alasan, req.user) }); } catch (e) { return kirimGalat(res, next, e); }
});

/* ── /api/preset (baca + validasi; isi versi tidak pernah diubah) ─────── */
const preset = express.Router();
preset.use(wajibTersedia);
preset.get('/', ...baca, async (_req, res, next) => {
  try {
    return res.json(await q(`
      SELECT p.id, p.id_tanaman, t.nama_tanaman, p.nama, p.aktif_versi_id, v.id AS id_versi, v.versi, v.status_validasi,
             v.divalidasi_pada, v.catatan, v.sumber, v.parameter,
             CASE WHEN p.aktif_versi_id = v.id AND v.status_validasi = 'TERVALIDASI' THEN 'AKTIF_TERVALIDASI'
                  WHEN p.aktif_versi_id = v.id THEN 'AKTIF_RANCANGAN' ELSE 'TIDAK_AKTIF' END AS kategori
        FROM preset_nutrisi p JOIN tanamen t ON t.id_tanaman = p.id_tanaman JOIN preset_versi v ON v.id_preset = p.id
       ORDER BY t.nama_tanaman, p.id, v.versi DESC`));
  } catch (e) { return next(e); }
});
preset.post('/:id/versi/:v/validasi', ...khususAdmin, async (req, res, next) => {
  if (!idValidValue(req.params.id) || !/^[0-9]{1,6}$/.test(req.params.v)) return tidakDitemukan(res);
  const catatan = typeof req.body?.catatan === 'string' ? req.body.catatan.trim() : '';
  if (catatan.length < 10 || catatan.length > 1000) {
    return json(res, 422, { message: 'Data tidak valid.', errors: { catatan: ['Catatan validasi (bukti/sumber/pihak yang memvalidasi) 10–1000 karakter.'] } });
  }
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const v = (await c.query('SELECT * FROM preset_versi WHERE id_preset = $1 AND versi = $2 FOR UPDATE', [req.params.id, req.params.v])).rows[0];
    if (!v) { await c.query('ROLLBACK'); return tidakDitemukan(res); }
    if (v.status_validasi === 'TERVALIDASI') { await c.query('ROLLBACK'); return json(res, 409, { message: 'Versi ini sudah tervalidasi.', kode: 'sudah_tervalidasi' }); }
    const r = (await c.query(
      `UPDATE preset_versi SET status_validasi = 'TERVALIDASI', divalidasi_oleh = $2, divalidasi_pada = now(),
              catatan = concat_ws(E'\\n', catatan, 'VALIDASI: ' || $3) WHERE id = $1 RETURNING *`, [v.id, req.user.sub, catatan])).rows[0];
    await c.query(
      `INSERT INTO audit_logs (actor_user_id, actor_tipe, actor_label, aksi, tabel, row_id, before_data, after_data, request_id, meta)
       VALUES ($1, 'user', $2, 'update', 'preset_versi', $3, $4, $5, $6, $7)`,
      [req.user.sub, req.user.username ?? null, String(v.id), { status_validasi: v.status_validasi }, { status_validasi: 'TERVALIDASI', catatan },
        crypto.randomUUID(), { level: req.user.level }]);
    await c.query('COMMIT');
    return res.json({ status: true, data: r });
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    return next(e);
  } finally { c.release(); }
});

/** Validasi bentuk parameter versi preset (rentang tipe; nilai agronomis TIDAK dikarang — admin yang mengisi). */
const TAHAP_PRESET = ['SEMAI', 'PEREMAJAAN', 'PENDEWASAAN'];
function validasiParameterPreset(p) {
  const e = {};
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { parameter: ['parameter wajib objek.'] };
  const lain = Object.keys(p).filter((k) => !['tahap', 'naik_harian', 'batas_operasi', 'durasi_hari'].includes(k));
  if (lain.length) e.parameter = [`kunci tidak dikenal: ${lain.join(', ')}`];
  const angka = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
  if (p.tahap !== undefined) {
    if (!p.tahap || typeof p.tahap !== 'object' || Array.isArray(p.tahap)) e.tahap = ['tahap wajib objek.'];
    else {
      for (const [k, t] of Object.entries(p.tahap)) {
        if (!TAHAP_PRESET.includes(k)) { e[`tahap.${k}`] = ['tahap tidak dikenal.']; continue; }
        if (!t || !angka(t.ec_min_ppm, 0, 5000) || !angka(t.ec_max_ppm, 0, 5000) || !angka(t.ph_min, 0, 14) || !angka(t.ph_max, 0, 14)
            || t.ec_min_ppm > t.ec_max_ppm || t.ph_min > t.ph_max) {
          e[`tahap.${k}`] = ['ec_min_ppm ≤ ec_max_ppm (0–5000), ph_min ≤ ph_max (0–14) wajib angka.'];
        }
      }
    }
  }
  if (p.naik_harian !== undefined && p.naik_harian !== null) {
    const n = p.naik_harian;
    if (!n || !angka(n.ppm_awal, 50, 2500) || !angka(n.ppm_target, 50, 2500) || !Number.isInteger(n.hari_capai) || n.hari_capai < 1 || n.hari_capai > 365 || n.ppm_awal > n.ppm_target) {
      e.naik_harian = ['ppm_awal ≤ ppm_target (50–2500), hari_capai 1–365.'];
    }
  }
  const b = validasiBatasOperasi(p.batas_operasi);
  if (!b.ok) e.batas_operasi = [b.galat];
  if (p.durasi_hari !== undefined && p.durasi_hari !== null) {
    if (typeof p.durasi_hari !== 'object' || Array.isArray(p.durasi_hari)
        || Object.entries(p.durasi_hari).some(([k, v]) => !TAHAP_PRESET.includes(k) || !Number.isInteger(v) || v < 1 || v > 365)) {
      e.durasi_hari = ['durasi_hari: {TAHAP: hari 1–365}.'];
    }
  }
  return e;
}

async function auditPreset(c, req, aksi, tabel, rowId, before, after) {
  await c.query(
    `INSERT INTO audit_logs (actor_user_id, actor_tipe, actor_label, aksi, tabel, row_id, before_data, after_data, request_id, meta)
     VALUES ($1, 'user', $2, $3, $4, $5, $6, $7, $8, $9)`,
    [req.user.sub, req.user.username ?? null, aksi, tabel, String(rowId), before, after, crypto.randomUUID(), { level: req.user.level }]);
}

preset.post('/:id/versi', ...khususAdmin, async (req, res, next) => {
  if (!idValidValue(req.params.id)) return tidakDitemukan(res);
  const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const errors = validasiParameterPreset(b.parameter);
  const catatan = typeof b.catatan === 'string' ? b.catatan.trim() : '';
  if (catatan.length < 5 || catatan.length > 1000) errors.catatan = ['Catatan perubahan (sumber nilai) 5–1000 karakter.'];
  if (Object.keys(errors).length) return json(res, 422, { message: 'Data tidak valid.', errors });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const p = (await c.query('SELECT id FROM preset_nutrisi WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!p) { await c.query('ROLLBACK'); return tidakDitemukan(res); }
    const v = (await c.query(
      `INSERT INTO preset_versi (id_preset, versi, parameter, catatan, sumber, dibuat_oleh)
       VALUES ($1, (SELECT coalesce(max(versi), 0) + 1 FROM preset_versi WHERE id_preset = $1), $2, $3, 'admin (API)', $4) RETURNING *`,
      [p.id, b.parameter, catatan, req.user.sub])).rows[0];
    await auditPreset(c, req, 'create', 'preset_versi', v.id, null, { id_preset: Number(p.id), versi: v.versi, parameter: b.parameter });
    await c.query('COMMIT');
    return json(res, 201, { status: true, data: v });
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    return next(e);
  } finally { c.release(); }
});

preset.post('/:id/versi/:v/aktifkan', ...khususAdmin, async (req, res, next) => {
  if (!idValidValue(req.params.id) || !/^[0-9]{1,6}$/.test(req.params.v)) return tidakDitemukan(res);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const p = (await c.query('SELECT id, aktif_versi_id FROM preset_nutrisi WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    const v = p && (await c.query('SELECT id, versi, status_validasi FROM preset_versi WHERE id_preset = $1 AND versi = $2', [p.id, req.params.v])).rows[0];
    if (!v) { await c.query('ROLLBACK'); return tidakDitemukan(res); }
    if (Number(p.aktif_versi_id) === Number(v.id)) { await c.query('ROLLBACK'); return json(res, 409, { message: 'Versi ini sudah aktif.', kode: 'sudah_aktif' }); }
    await c.query('UPDATE preset_nutrisi SET aktif_versi_id = $2 WHERE id = $1', [p.id, v.id]);
    await auditPreset(c, req, 'update', 'preset_nutrisi', p.id, { aktif_versi_id: p.aktif_versi_id }, { aktif_versi_id: Number(v.id), versi: v.versi, status_validasi: v.status_validasi });
    await c.query('COMMIT');
    return res.json({ status: true, data: { id_preset: Number(p.id), aktif_versi_id: Number(v.id), versi: v.versi, status_validasi: v.status_validasi } });
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    return next(e);
  } finally { c.release(); }
});

module.exports = { siklus, konfirmasi, lot, penugasan: tugas, preset };
