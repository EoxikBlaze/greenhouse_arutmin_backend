'use strict';
/**
 * LAYANAN SIKLUS BUDIDAYA (Fase 3B) — state machine docs/DESAIN_FASE2.md §3.A di atas tabel 3A
 * (siklus_budidaya, siklus_lot, siklus_transisi, permintaan_konfirmasi).
 *
 * Prinsip:
 *  - Setiap operasi tulis = SATU transaksi: kunci baris siklus (FOR UPDATE) → cek jalur → ubah →
 *    tepat satu baris siklus_transisi berkunci idempotensi → audit_logs di transaksi yang sama.
 *  - Siklus/lot ber-perlu_tinjau (data migrasi tidak cocok) tidak bisa dilanjutkan.
 *  - Tidak ada nilai tebakan: parameter yang belum SIAP (src/parameter.js) membuat fitur terkait
 *    tidak berjalan (jadwal ulang/pengingat kosong) atau operasinya ditolak.
 *  - Bibit TIDAK PERNAH dianggap siap tanpa jawaban pengguna.
 *  - Tidak menyentuh aktuator/pompa sama sekali.
 */
const crypto = require('crypto');
const { pool, q } = require('./db');
const { wajibSiap, nilaiBilaSiap, bacaParameter } = require('./parameter');
const { bacaanMustahil, SENSOR_BASI_DETIK } = require('./sanitySensor');
const { wajibDitugaskan, adalahAdmin, AksesDitolak } = require('./penugasan');
const { evaluasiKestabilan } = require('./kestabilan');

/** Jalur sah: JALUR[dari][ke] = aktor yang boleh ('user' | 'system'). */
const JALUR = {
  DRAFT: { TANK_PREPARATION: ['user'], CANCELLED: ['user'] },
  TANK_PREPARATION: { WAITING_TANK_CONFIRMATION: ['system'], CANCELLED: ['user'] },
  WAITING_TANK_CONFIRMATION: { SEEDING: ['user'], TANK_PREPARATION: ['user', 'system'], CANCELLED: ['user'] },
  SEEDING: { WAITING_REJUVENATION_CONFIRMATION: ['user', 'system'], CANCELLED: ['user'] },
  WAITING_REJUVENATION_CONFIRMATION: { WAITING_SEED_COUNT_CONFIRMATION: ['user'], SEEDING: ['user', 'system'], CANCELLED: ['user'] },
  WAITING_SEED_COUNT_CONFIRMATION: { GROWTH: ['user'], COMPLETED: ['user'], CANCELLED: ['user'] },
  GROWTH: { GROWTH: ['user'], COMPLETED: ['user', 'system'], CANCELLED: ['user'] },
  COMPLETED: {},
  CANCELLED: {},
};
const AKHIR = new Set(['COMPLETED', 'CANCELLED']);

class SiklusGalat extends Error {
  constructor(status, pesan, ekstra = {}) {
    super(pesan);
    this.status = status;
    Object.assign(this, ekstra);
  }
}

const bolehTransisi = (dari, ke, aktorTipe) => Boolean(JALUR[dari]?.[ke]?.includes(aktorTipe));

/* ── utilitas ─────────────────────────────────────────────────────────── */

const bulat = (v, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : null);
const angka = (v, min, max) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null);
const idSah = (v) => (Number.isInteger(v) && v >= 1 && v <= Number.MAX_SAFE_INTEGER ? v : null);

/** Hash permintaan untuk idempotensi (urutan kunci objek dinormalkan). */
function hashPermintaan(op, id, body) {
  const urut = (x) => (x && typeof x === 'object' && !Array.isArray(x)
    ? Object.keys(x).sort().reduce((o, k) => { o[k] = urut(x[k]); return o; }, {})
    : Array.isArray(x) ? x.map(urut) : x);
  return crypto.createHash('sha256').update(JSON.stringify([op, id ?? null, urut(body ?? {})])).digest('hex');
}

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
  const r = (await q('SELECT id_siklus, permintaan_hash FROM siklus_transisi WHERE idempotency_key = $1', [key]))[0];
  if (!r) return null;
  if (r.permintaan_hash !== hash) {
    throw new SiklusGalat(422, 'Idempotency-Key sudah dipakai untuk permintaan lain.', { kode: 'idempotency_bentrok' });
  }
  return { id_siklus: Number(r.id_siklus), replay: true };
}

const PESAN_UNIK = {
  siklus_budidaya_meja_semai_unik: ['penampung_dipakai', 'Penampung ini sedang dipakai siklus persiapan/semai lain.'],
  permintaan_konfirmasi_pending_unik: ['konfirmasi_terbuka', 'Masih ada permintaan konfirmasi yang belum dijawab.'],
};

/**
 * Bungkus operasi tulis: replay idempotensi → transaksi → (balapan kunci sama) replay.
 * fn(client) wajib mengembalikan { id_siklus }.
 */
async function operasi(idem, hash, fn) {
  const ada = await cariIdem(idem, hash);
  if (ada) return ada;
  try {
    return await tx(fn);
  } catch (e) {
    // permintaan kembar yang menunggu kunci baris: setelah yang pertama commit, ia ditolak (409/23505) —
    // bila kunci idempotensinya kini tercatat, itu replay, bukan konflik
    if (e.code === '23505' || e instanceof SiklusGalat) {
      const r = await cariIdem(idem, hash);
      if (r) return r;
    }
    if (e.code === '23505' && PESAN_UNIK[e.constraint]) {
      const [kode, pesan] = PESAN_UNIK[e.constraint];
      throw new SiklusGalat(409, pesan, { kode });
    }
    throw e;
  }
}

async function kunciSiklus(c, id) {
  const s = (await c.query('SELECT * FROM siklus_budidaya WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!s) throw new SiklusGalat(404, 'Data tidak ditemukan.', { errors: {} });
  return s;
}

function wajibBolehLanjut(s) {
  if (s.perlu_tinjau) {
    throw new SiklusGalat(409, 'Siklus hasil migrasi ini perlu ditinjau dulu; operasi lanjutan ditolak.',
      { kode: 'perlu_tinjau', alasan_tinjau: s.alasan_tinjau });
  }
}

async function auditTx(c, aktor, { aksi, row_id, before = null, after = null, meta = {} }) {
  await c.query(
    `INSERT INTO audit_logs (actor_user_id, actor_tipe, actor_label, aksi, tabel, row_id, before_data, after_data, ip, user_agent, request_id, meta)
     VALUES ($1,$2,$3,$4,'siklus_budidaya',$5,$6,$7,$8,$9,$10,$11)`,
    [aktor.tipe === 'user' ? aktor.user.sub : null, aktor.tipe, aktor.tipe === 'user' ? aktor.user.username ?? null : 'penjadwal-siklus',
      aksi, String(row_id), before, after, aktor.ip ?? null, aktor.ua ?? null, crypto.randomUUID(),
      { ...meta, ...(aktor.user?.level ? { level: aktor.user.level } : {}) }]);
}

async function notif(c, { jenis, severity = 'info', judul, isi, tautan, dedup }) {
  await c.query(
    `INSERT INTO notifikasi (jenis, severity, judul, isi, tautan, dedup_key) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (dedup_key) DO NOTHING`,
    [jenis, severity, judul.slice(0, 150), isi, tautan ?? null, dedup ?? null]);
}

const KOLOM_SET = new Set(['hasil', 'semai_mulai_pada', 'jadwal_konfirmasi_berikut', 'benih_berhasil', 'benih_gagal']);

/**
 * Ubah status siklus yang SUDAH dikunci + catat transisi (+ idempotensi) + audit.
 * set: kolom tambahan; nilai berbentuk { sql: 'now() + ...', params: [...] } atau nilai biasa.
 */
async function ubahStatus(c, s, ke, aktor, { alasan = null, data = null, idem = null, hash = null, set = {} } = {}) {
  if (!bolehTransisi(s.status, ke, aktor.tipe)) {
    throw new SiklusGalat(409, `Transisi ${s.status} → ${ke} tidak sah.`, { kode: 'transisi_tidak_sah', status_sekarang: s.status });
  }
  const kol = ['status = $2', 'diperbarui_pada = now()'];
  const par = [s.id, ke];
  for (const [k, v] of Object.entries(set)) {
    if (!KOLOM_SET.has(k)) throw new Error(`kolom ${k} tidak boleh diubah lewat ubahStatus`);
    if (v && typeof v === 'object' && 'sql' in v) {
      const geser = v.params.map((p) => { par.push(p); return `$${par.length}`; });
      kol.push(`${k} = ${v.sql.replace(/\?/g, () => geser.shift())}`);
    } else {
      par.push(v);
      kol.push(`${k} = $${par.length}`);
    }
  }
  if (AKHIR.has(ke)) kol.push('selesai_pada = now()');
  const baru = (await c.query(`UPDATE siklus_budidaya SET ${kol.join(', ')} WHERE id = $1 RETURNING *`, par)).rows[0];
  await c.query(
    `INSERT INTO siklus_transisi (id_siklus, dari, ke, aktor_tipe, aktor_user_id, alasan, data, idempotency_key, permintaan_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [s.id, s.status, ke, aktor.tipe, aktor.tipe === 'user' ? aktor.user.sub : null, alasan, data, idem, hash]);
  await auditTx(c, aktor, {
    aksi: 'transition', row_id: s.id,
    before: { status: s.status }, after: { status: ke, ...(set.hasil !== undefined ? { hasil: set.hasil } : {}) },
    meta: { alasan, ...(data || {}) },
  });
  return baru;
}

/* ── pembuatan siklus ─────────────────────────────────────────────────── */

/** Validasi target manual (rentang tipe, sama dengan CHECK yang sudah ada di tanamen/target_nutrisi). */
function validasiTargetManual(t, errors) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) { errors.target = ['target wajib diisi untuk mode MANUAL.']; return null; }
  const out = {
    ec_min_ppm: angka(t.ec_min_ppm, 0, 5000), ec_max_ppm: angka(t.ec_max_ppm, 0, 5000),
    ph_min: angka(t.ph_min, 0, 14), ph_max: angka(t.ph_max, 0, 14),
  };
  for (const k of Object.keys(out)) if (out[k] === null) errors[`target.${k}`] = [`${k} wajib angka dalam rentang yang sah.`];
  if (out.ec_min_ppm !== null && out.ec_max_ppm !== null && out.ec_min_ppm > out.ec_max_ppm) errors['target.ec_max_ppm'] = ['ec_max_ppm harus ≥ ec_min_ppm.'];
  if (out.ph_min !== null && out.ph_max !== null && out.ph_min > out.ph_max) errors['target.ph_max'] = ['ph_max harus ≥ ph_min.'];
  const nh = ['ppm_awal', 'ppm_target', 'hari_capai'];
  const terisi = nh.filter((k) => t[k] !== undefined && t[k] !== null);
  if (terisi.length) {
    if (terisi.length !== 3) errors['target.naik_harian'] = ['ppm_awal, ppm_target, hari_capai harus diisi semua atau dikosongkan semua.'];
    else {
      out.ppm_awal = angka(t.ppm_awal, 50, 2500);
      out.ppm_target = angka(t.ppm_target, 50, 2500);
      out.hari_capai = bulat(t.hari_capai, 1, 365);
      if (out.ppm_awal === null || out.ppm_target === null || out.hari_capai === null) errors['target.naik_harian'] = ['ppm 50–2500, hari_capai 1–365.'];
      else if (out.ppm_awal > out.ppm_target) errors['target.ppm_target'] = ['ppm_target harus ≥ ppm_awal.'];
    }
  }
  return out;
}

async function buatSiklus(body, aktor, idem) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const errors = {};
  const idTanaman = idSah(b.id_tanaman);
  const idMeja = idSah(b.id_meja);
  const mode = ['PRESET', 'MANUAL'].includes(b.mode_target) ? b.mode_target : null;
  const ph = angka(b.ph_aktual, 0, 14);
  const tds = angka(b.tds_aktual_ppm, 0, 10000);
  const benih = bulat(b.jumlah_benih, 1, 1_000_000);
  if (!idTanaman) errors.id_tanaman = ['id_tanaman wajib bilangan bulat ≥ 1.'];
  if (!idMeja) errors.id_meja = ['id_meja wajib bilangan bulat ≥ 1.'];
  if (!mode) errors.mode_target = ['mode_target harus PRESET atau MANUAL.'];
  if (ph === null) errors.ph_aktual = ['ph_aktual wajib angka 0–14.'];
  if (tds === null) errors.tds_aktual_ppm = ['tds_aktual_ppm wajib angka 0–10000.'];
  if (benih === null) errors.jumlah_benih = ['jumlah_benih wajib bilangan bulat 1–1000000.'];
  const idVersi = mode === 'PRESET' ? idSah(b.id_preset_versi) : null;
  if (mode === 'PRESET' && !idVersi) errors.id_preset_versi = ['id_preset_versi wajib untuk mode PRESET.'];
  const manual = mode === 'MANUAL' ? validasiTargetManual(b.target, errors) : null;
  if (b.keterangan !== undefined && b.keterangan !== null && (typeof b.keterangan !== 'string' || b.keterangan.length > 500)) {
    errors.keterangan = ['keterangan maksimal 500 karakter.'];
  }
  if (Object.keys(errors).length) throw new SiklusGalat(422, 'Data tidak valid.', { errors });

  const hash = hashPermintaan('buat', null, b);
  return operasi(idem, hash, async (c) => {
    await wajibDitugaskan(c, aktor.user, [idMeja]);
    const fk = {};
    if (!(await c.query('SELECT 1 FROM tanamen WHERE id_tanaman = $1', [idTanaman])).rows[0]) fk.id_tanaman = ['Tanaman tidak terdaftar.'];
    if (!(await c.query('SELECT 1 FROM mejas WHERE id_meja = $1', [idMeja])).rows[0]) fk.id_meja = ['Meja/penampung tidak terdaftar.'];
    let target;
    if (mode === 'PRESET') {
      const v = (await c.query(
        `SELECT v.id, v.versi, v.parameter, v.status_validasi, p.id_tanaman, p.aktif_versi_id
           FROM preset_versi v JOIN preset_nutrisi p ON p.id = v.id_preset WHERE v.id = $1`, [idVersi])).rows[0];
      if (!v) fk.id_preset_versi = ['Versi preset tidak terdaftar.'];
      else if (Number(v.id_tanaman) !== idTanaman) fk.id_preset_versi = ['Versi preset bukan milik tanaman ini.'];
      else if (Number(v.aktif_versi_id) !== Number(v.id)) fk.id_preset_versi = ['Hanya versi preset yang aktif yang boleh dipakai.'];
      else target = { sumber: 'PRESET', id_preset_versi: Number(v.id), versi: v.versi, status_validasi: v.status_validasi, parameter: v.parameter };
    } else {
      target = { sumber: 'MANUAL', ...manual };
    }
    if (Object.keys(fk).length) throw new SiklusGalat(422, 'Data tidak valid.', { errors: fk });

    const s = (await c.query(
      `INSERT INTO siklus_budidaya (id_tanaman, id_meja_semai, id_preset_versi, mode_target, target, ph_awal, tds_awal_ppm,
         jumlah_benih, status, keterangan, dibuat_oleh, asal)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'DRAFT',$9,$10,'BARU') RETURNING *`,
      [idTanaman, idMeja, mode === 'PRESET' ? idVersi : null, mode, target, ph, tds, benih,
        b.keterangan ?? null, aktor.user.sub])).rows[0];
    await c.query(
      `INSERT INTO siklus_transisi (id_siklus, dari, ke, aktor_tipe, aktor_user_id, alasan, idempotency_key, permintaan_hash)
       VALUES ($1, NULL, 'DRAFT', 'user', $2, 'siklus dibuat', $3, $4)`, [s.id, aktor.user.sub, idem, hash]);
    await auditTx(c, aktor, { aksi: 'create', row_id: s.id, after: { status: 'DRAFT', id_tanaman: idTanaman, id_meja: idMeja, mode_target: mode, jumlah_benih: benih } });
    return { id_siklus: Number(s.id), baru: true };
  });
}

/* ── transisi manual (endpoint umum): mulai persiapan / batal ─────────── */

async function transisiManual(id, body, aktor, idem) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  if (!['TANK_PREPARATION', 'CANCELLED'].includes(b.ke)) {
    throw new SiklusGalat(422, 'Data tidak valid.', { errors: { ke: ['Lewat endpoint ini hanya TANK_PREPARATION atau CANCELLED; tahap lain memakai endpoint konfirmasi/benih/lot.'] } });
  }
  const alasan = typeof b.alasan === 'string' ? b.alasan.trim() : '';
  if (b.ke === 'CANCELLED' && alasan.length < 5) throw new SiklusGalat(422, 'Data tidak valid.', { errors: { alasan: ['Alasan pembatalan minimal 5 karakter.'] } });
  if (alasan.length > 500) throw new SiklusGalat(422, 'Data tidak valid.', { errors: { alasan: ['Alasan maksimal 500 karakter.'] } });
  const hash = hashPermintaan('transisi', id, b);
  return operasi(idem, hash, async (c) => {
    const s = await kunciSiklus(c, id);
    wajibBolehLanjut(s);
    await wajibDitugaskan(c, aktor.user, [s.id_meja_semai]);
    if (b.ke === 'CANCELLED' && !adalahAdmin(aktor.user) && !['DRAFT', 'TANK_PREPARATION'].includes(s.status)) {
      throw new AksesDitolak('Petani hanya boleh membatalkan siklus DRAFT/TANK_PREPARATION.', { kode: 'akses_ditolak' });
    }
    if (b.ke === 'TANK_PREPARATION') {
      const lock = (await c.query('SELECT status_lock, lock_alasan FROM penampung_states WHERE id_meja = $1', [s.id_meja_semai])).rows[0];
      if (lock?.status_lock) throw new SiklusGalat(423, `Penampung terkunci${lock.lock_alasan ? ` (${lock.lock_alasan})` : ''}.`, { kode: 'penampung_terkunci' });
      await ubahStatus(c, s, 'TANK_PREPARATION', aktor, { alasan: alasan || null, idem, hash });
    } else {
      await ubahStatus(c, s, 'CANCELLED', aktor, { alasan, idem, hash, set: { hasil: 'DIBATALKAN' } });
      await c.query("UPDATE permintaan_konfirmasi SET status = 'CANCELLED' WHERE id_siklus = $1 AND status = 'PENDING'", [s.id]);
      // siklus dosing aktif ikut dibatalkan (dimuat saat dipakai: dosingSiklus memuat modul ini)
      await require('./dosingSiklus').batalkanUntukSiklus(c, s.id, aktor, alasan);
    }
    return { id_siklus: Number(s.id) };
  });
}

/* ── konfirmasi ───────────────────────────────────────────────────────── */

/** Permintaan konfirmasi peremajaan: batas jawab wajib SIAP; pengingat hanya bila SIAP & < batas. */
async function buatPermintaanRejuvenasi(c, s) {
  const runner = (t, p) => c.query(t, p);
  const { konfirmasi_peremajaan_batas_jam: batas } = await wajibSiap({ timing_operasi: ['konfirmasi_peremajaan_batas_jam'] }, runner);
  const { pengingat_konfirmasi_jam: ingat } = await nilaiBilaSiap({ timing_operasi: ['pengingat_konfirmasi_jam'] }, runner);
  const ke = Number((await c.query("SELECT count(*) FROM permintaan_konfirmasi WHERE id_siklus = $1 AND jenis = 'REJUVENATION'", [s.id])).rows[0].count) + 1;
  const p = (await c.query(
    `INSERT INTO permintaan_konfirmasi (id_siklus, jenis, percobaan_ke, kedaluwarsa_pada, pengingat_pada)
     VALUES ($1, 'REJUVENATION', $2, now() + make_interval(secs => $3::float8 * 3600),
             CASE WHEN $4::float8 IS NULL OR $4::float8 >= $3::float8 THEN NULL ELSE now() + make_interval(secs => $4::float8 * 3600) END)
     RETURNING *`, [s.id, ke, batas, ingat])).rows[0];
  await notif(c, {
    jenis: 'konfirmasi_peremajaan', judul: 'Konfirmasi peremajaan bibit',
    isi: `Siklus #${s.id}: apakah bibit siap dipindah ke peremajaan? Jawab sebelum ${new Date(p.kedaluwarsa_pada).toISOString()}.`,
    tautan: { tipe: 'konfirmasi', id: Number(p.id), id_siklus: Number(s.id) }, dedup: `konfirmasi:${p.id}`,
  });
  return p;
}

/** Jadwal konfirmasi ulang: hanya bila ulang_konfirmasi_jam SIAP; selain itu NULL (tidak menebak). */
async function jadwalUlang(c, s) {
  const { ulang_konfirmasi_jam: ulang } = await nilaiBilaSiap({ timing_operasi: ['ulang_konfirmasi_jam'] }, (t, p) => c.query(t, p));
  if (ulang == null) {
    await notif(c, {
      jenis: 'jadwal_ulang_manual', severity: 'warning', judul: 'Konfirmasi ulang perlu diminta manual',
      isi: `Siklus #${s.id}: ulang_konfirmasi_jam belum diputuskan/divalidasi, jadi tidak ada jadwal otomatis. Admin perlu meminta konfirmasi lagi.`,
      tautan: { tipe: 'siklus', id: Number(s.id) }, dedup: `jadwal-manual:${s.id}:${Date.now()}`,
    });
    return null;
  }
  return { sql: 'now() + make_interval(secs => ?::float8 * 3600)', params: [ulang] };
}

/** Pita target tahap semai dari snapshot target (preset atau manual); null bila tidak lengkap. */
function pitaSemai(target) {
  const t = target?.parameter?.tahap?.SEMAI ?? target?.tahap?.SEMAI ?? target;
  const pita = { ec_min: Number(t?.ec_min_ppm), ec_max: Number(t?.ec_max_ppm), ph_min: Number(t?.ph_min), ph_max: Number(t?.ph_max) };
  return Object.values(pita).every((v) => Number.isFinite(v)) && t?.ec_min_ppm != null && t?.ph_min != null ? pita : null;
}

/** Bacaan terakhir penampung segar, sah, dan di dalam pita semai — syarat mulai semai. */
async function wajibTandonDalamPita(c, s) {
  const pita = pitaSemai(s.target);
  if (!pita) throw new SiklusGalat(409, 'Target semai di snapshot siklus tidak lengkap.', { kode: 'target_tidak_lengkap' });
  const m = (await c.query(
    `SELECT ph, tds, "waterTemp", extract(epoch FROM now() - coalesce(updated_at, created_at)) AS umur
       FROM monitorings WHERE id_meja = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [s.id_meja_semai])).rows[0];
  const ph = m?.ph == null ? null : Number(m.ph);
  const tds = m?.tds == null ? null : Number(m.tds);
  const masalah = !m ? 'belum ada bacaan'
    : Number(m.umur) > SENSOR_BASI_DETIK ? 'bacaan basi'
      : ph == null || tds == null ? 'bacaan pH/TDS tidak lengkap'
        : bacaanMustahil({ ph, tds, suhuAir: m.waterTemp == null ? null : Number(m.waterTemp) })
          || (tds < pita.ec_min || tds > pita.ec_max || ph < pita.ph_min || ph > pita.ph_max ? `bacaan (pH ${ph}, TDS ${tds}) di luar pita target` : null);
  if (masalah) throw new SiklusGalat(409, `Tandon belum memenuhi syarat mulai semai: ${masalah}.`, { kode: 'tandon_tidak_dalam_pita' });
}

/** Admin meminta konfirmasi peremajaan secara manual (hanya setelah H+4 tercapai). */
async function mintaKonfirmasi(id, aktor, idem) {
  if (!adalahAdmin(aktor.user)) throw new AksesDitolak('Hanya admin yang boleh meminta konfirmasi manual.', { kode: 'akses_ditolak' });
  const hash = hashPermintaan('minta-konfirmasi', id, {});
  return operasi(idem, hash, async (c) => {
    const s = await kunciSiklus(c, id);
    wajibBolehLanjut(s);
    if (s.status !== 'SEEDING') throw new SiklusGalat(409, `Konfirmasi peremajaan hanya untuk siklus SEEDING.`, { kode: 'transisi_tidak_sah', status_sekarang: s.status });
    const { konfirmasi_peremajaan_jam_ke: jamKe } = await wajibSiap({ timing_operasi: ['konfirmasi_peremajaan_jam_ke'] }, (t, p) => c.query(t, p));
    if (!s.semai_mulai_pada) throw new SiklusGalat(409, 'Waktu mulai semai tidak tercatat.', { kode: 'perlu_tinjau' });
    // data migrasi hanya tahu TANGGAL semai (disimpan 00:00 WITA): hitung dari akhir hari itu agar 96 jam pasti sudah lewat
    const belum = (await c.query(
      `SELECT $1::timestamptz + CASE WHEN $3 = 'TANGGAL' THEN interval '1 day' ELSE interval '0' END
              + make_interval(secs => $2::float8 * 3600) > now() AS belum`, [s.semai_mulai_pada, jamKe, s.waktu_presisi])).rows[0].belum;
    if (belum) throw new SiklusGalat(409, `Konfirmasi peremajaan baru boleh diminta ${jamKe} jam setelah semai dimulai.`, { kode: 'belum_waktunya' });
    const p = await buatPermintaanRejuvenasi(c, s);
    await ubahStatus(c, s, 'WAITING_REJUVENATION_CONFIRMATION', aktor, {
      alasan: 'permintaan konfirmasi manual', idem, hash, data: { id_permintaan: Number(p.id) }, set: { jadwal_konfirmasi_berikut: null },
    });
    return { id_siklus: Number(s.id) };
  });
}

async function jawabKonfirmasi(idPermintaan, body, aktor, idem) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  if (!['SIAP', 'BELUM_SIAP'].includes(b.jawaban)) throw new SiklusGalat(422, 'Data tidak valid.', { errors: { jawaban: ['jawaban harus SIAP atau BELUM_SIAP.'] } });
  const awal = (await q('SELECT id_siklus FROM permintaan_konfirmasi WHERE id = $1', [idPermintaan]))[0];
  if (!awal) throw new SiklusGalat(404, 'Data tidak ditemukan.', { errors: {} });
  const hash = hashPermintaan('jawab', idPermintaan, b);
  return operasi(idem, hash, async (c) => {
    const s = await kunciSiklus(c, awal.id_siklus); // urutan kunci: siklus → permintaan (sama dengan penjadwal)
    wajibBolehLanjut(s);
    await wajibDitugaskan(c, aktor.user, [s.id_meja_semai]);
    const p = (await c.query('SELECT *, kedaluwarsa_pada <= now() AS lewat FROM permintaan_konfirmasi WHERE id = $1 FOR UPDATE', [idPermintaan])).rows[0];
    if (p.status === 'EXPIRED' || (p.status === 'PENDING' && p.lewat)) {
      throw new SiklusGalat(410, 'Permintaan konfirmasi sudah kedaluwarsa.', { kode: 'konfirmasi_kedaluwarsa' });
    }
    if (p.status !== 'PENDING') {
      throw new SiklusGalat(409, 'Permintaan konfirmasi sudah ditutup.', { kode: 'sudah_dijawab', status_permintaan: p.status, dijawab_pada: p.dijawab_pada });
    }
    const siap = b.jawaban === 'SIAP';
    await c.query(
      'UPDATE permintaan_konfirmasi SET status = $2, dijawab_oleh = $3, dijawab_pada = now(), idempotency_key = $4 WHERE id = $1',
      [p.id, siap ? 'ANSWERED_READY' : 'ANSWERED_NOT_READY', aktor.user.sub, idem]);
    const data = { id_permintaan: Number(p.id), jenis: p.jenis, jawaban: b.jawaban };
    if (p.jenis === 'REJUVENATION') {
      if (siap) await ubahStatus(c, s, 'WAITING_SEED_COUNT_CONFIRMATION', aktor, { alasan: 'bibit dinyatakan siap', data, idem, hash });
      else {
        await ubahStatus(c, s, 'SEEDING', aktor, {
          alasan: 'bibit belum siap', data, idem, hash, set: { jadwal_konfirmasi_berikut: await jadwalUlang(c, s) },
        });
      }
    } else if (siap) {
      await wajibTandonDalamPita(c, s);
      const { konfirmasi_peremajaan_jam_ke: jamKe } = await wajibSiap({ timing_operasi: ['konfirmasi_peremajaan_jam_ke'] }, (t, pr) => c.query(t, pr));
      await ubahStatus(c, s, 'SEEDING', aktor, {
        alasan: 'tandon siap, semai dimulai', data, idem, hash,
        set: { semai_mulai_pada: { sql: 'now()', params: [] }, jadwal_konfirmasi_berikut: { sql: 'now() + make_interval(secs => ?::float8 * 3600)', params: [jamKe] } },
      });
    } else {
      await ubahStatus(c, s, 'TANK_PREPARATION', aktor, { alasan: 'tandon belum siap', data, idem, hash });
    }
    return { id_siklus: Number(s.id) };
  });
}

/* ── jumlah benih ─────────────────────────────────────────────────────── */

async function konfirmasiBenih(id, body, aktor, idem) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const errors = {};
  const jumlah = bulat(b.jumlah_benih, 0, 1_000_000);
  const ok = bulat(b.berhasil, 0, 1_000_000);
  const gagal = bulat(b.gagal, 0, 1_000_000);
  if (jumlah === null) errors.jumlah_benih = ['jumlah_benih wajib bilangan bulat ≥ 0.'];
  if (ok === null) errors.berhasil = ['berhasil wajib bilangan bulat ≥ 0.'];
  if (gagal === null) errors.gagal = ['gagal wajib bilangan bulat ≥ 0.'];
  if (jumlah !== null && ok !== null && gagal !== null && ok + gagal !== jumlah) {
    errors.berhasil = [`berhasil + gagal (${ok + gagal}) harus sama dengan jumlah benih disemai (${jumlah}).`];
  }
  const tujuan = b.id_meja_tujuan === undefined || b.id_meja_tujuan === null ? null : idSah(b.id_meja_tujuan);
  if (ok > 0 && !tujuan) errors.id_meja_tujuan = ['id_meja_tujuan wajib bila ada bibit berhasil.'];
  if (Object.keys(errors).length) throw new SiklusGalat(422, 'Data tidak valid.', { errors });
  const hash = hashPermintaan('benih', id, b);
  return operasi(idem, hash, async (c) => {
    const s = await kunciSiklus(c, id);
    wajibBolehLanjut(s);
    await wajibDitugaskan(c, aktor.user, ok > 0 ? [s.id_meja_semai, tujuan] : [s.id_meja_semai]);
    if (s.status !== 'WAITING_SEED_COUNT_CONFIRMATION') {
      throw new SiklusGalat(409, 'Jumlah benih hanya bisa dikonfirmasi setelah bibit dinyatakan siap.', { kode: 'transisi_tidak_sah', status_sekarang: s.status });
    }
    if (jumlah !== Number(s.jumlah_benih)) {
      throw new SiklusGalat(422, 'Data tidak valid.', { errors: { jumlah_benih: [`jumlah_benih harus sama dengan yang tercatat saat semai (${s.jumlah_benih}).`] } });
    }
    const set = { benih_berhasil: ok, benih_gagal: gagal };
    if (ok === 0) {
      await ubahStatus(c, s, 'COMPLETED', aktor, { alasan: 'semua benih gagal', idem, hash, data: { berhasil: 0, gagal }, set: { ...set, hasil: 'GAGAL_SEMAI' } });
      return { id_siklus: Number(s.id) };
    }
    if (!(await c.query('SELECT 1 FROM mejas WHERE id_meja = $1', [tujuan])).rows[0]) {
      throw new SiklusGalat(422, 'Data tidak valid.', { errors: { id_meja_tujuan: ['Meja tujuan tidak terdaftar.'] } });
    }
    const lot = (await c.query(
      `INSERT INTO siklus_lot (id_siklus, tahap, id_meja, jumlah_masuk, status, mulai_pada, dibuat_oleh)
       VALUES ($1, 'PEREMAJAAN', $2, $3, 'PROSES', now(), $4) RETURNING id`, [s.id, tujuan, ok, aktor.user.sub])).rows[0];
    await ubahStatus(c, s, 'GROWTH', aktor, { alasan: 'jumlah benih dikonfirmasi', idem, hash, data: { berhasil: ok, gagal, lot: Number(lot.id) }, set });
    return { id_siklus: Number(s.id) };
  });
}

/* ── lot (peremajaan → pendewasaan → panen) ───────────────────────────── */

async function selesaikanLot(idLot, body, aktor, idem) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const errors = {};
  const ok = bulat(b.berhasil, 0, 1_000_000);
  const gagal = bulat(b.gagal, 0, 1_000_000);
  if (ok === null) errors.berhasil = ['berhasil wajib bilangan bulat ≥ 0.'];
  if (gagal === null) errors.gagal = ['gagal wajib bilangan bulat ≥ 0.'];
  let tujuan = null;
  if (b.tujuan !== undefined && b.tujuan !== null) {
    if (!Array.isArray(b.tujuan) || b.tujuan.length < 1 || b.tujuan.length > 20) errors.tujuan = ['tujuan harus daftar 1–20 meja.'];
    else {
      tujuan = b.tujuan.map((t) => ({ id_meja: idSah(t?.id_meja), jumlah: bulat(t?.jumlah, 1, 1_000_000) }));
      if (tujuan.some((t) => !t.id_meja || !t.jumlah)) errors.tujuan = ['Setiap tujuan wajib {id_meja ≥ 1, jumlah ≥ 1}.'];
    }
  }
  if (Object.keys(errors).length) throw new SiklusGalat(422, 'Data tidak valid.', { errors });
  const awal = (await q('SELECT id_siklus FROM siklus_lot WHERE id = $1', [idLot]))[0];
  if (!awal) throw new SiklusGalat(404, 'Data tidak ditemukan.', { errors: {} });
  const hash = hashPermintaan('lot-selesai', idLot, b);
  return operasi(idem, hash, async (c) => {
    const s = await kunciSiklus(c, awal.id_siklus);
    wajibBolehLanjut(s);
    if (s.status !== 'GROWTH') throw new SiklusGalat(409, 'Lot hanya bisa diselesaikan saat siklus GROWTH.', { kode: 'transisi_tidak_sah', status_sekarang: s.status });
    const lot = (await c.query('SELECT * FROM siklus_lot WHERE id = $1 FOR UPDATE', [idLot])).rows[0];
    if (lot.perlu_tinjau) throw new SiklusGalat(409, 'Lot hasil migrasi ini perlu ditinjau dulu.', { kode: 'perlu_tinjau', alasan_tinjau: lot.alasan_tinjau });
    await wajibDitugaskan(c, aktor.user, [lot.id_meja, ...(tujuan || []).map((t) => t.id_meja)]);
    if (lot.status !== 'PROSES' || lot.tahap === 'PANEN') throw new SiklusGalat(409, 'Lot ini sudah selesai.', { kode: 'sudah_selesai' });
    if (lot.jumlah_masuk == null) throw new SiklusGalat(409, 'Jumlah masuk lot tidak tercatat.', { kode: 'perlu_tinjau' });
    const masuk = Number(lot.jumlah_masuk);
    const e2 = {};
    if (ok + gagal !== masuk) e2.berhasil = [`berhasil + gagal (${ok + gagal}) harus sama dengan jumlah masuk lot (${masuk}).`];
    if (lot.tahap === 'PEREMAJAAN' && ok > 0) {
      if (!tujuan) e2.tujuan = ['tujuan (meja pendewasaan) wajib bila ada tanaman berhasil.'];
      else if (tujuan.reduce((a, t) => a + t.jumlah, 0) !== ok) e2.tujuan = [`Total jumlah tujuan harus sama dengan berhasil (${ok}).`];
    }
    if (lot.tahap === 'PENDEWASAAN' && tujuan) e2.tujuan = ['Lot pendewasaan langsung dipanen; tujuan tidak dipakai.'];
    if (Object.keys(e2).length) throw new SiklusGalat(422, 'Data tidak valid.', { errors: e2 });
    if (tujuan) {
      const ada = (await c.query('SELECT id_meja FROM mejas WHERE id_meja = ANY($1::bigint[])', [tujuan.map((t) => t.id_meja)])).rows.map((r) => Number(r.id_meja));
      const hilang = tujuan.filter((t) => !ada.includes(t.id_meja)).map((t) => t.id_meja);
      if (hilang.length) throw new SiklusGalat(422, 'Data tidak valid.', { errors: { tujuan: [`Meja tidak terdaftar: ${hilang.join(', ')}.`] } });
    }

    await c.query(`UPDATE siklus_lot SET berhasil = $2, gagal = $3, status = $4, selesai_pada = now() WHERE id = $1`,
      [lot.id, ok, gagal, ok > 0 ? 'SELESAI' : 'GAGAL']);
    const anak = [];
    if (lot.tahap === 'PEREMAJAAN') {
      for (const t of tujuan || []) {
        anak.push(Number((await c.query(
          `INSERT INTO siklus_lot (id_siklus, id_lot_induk, tahap, id_meja, jumlah_masuk, status, mulai_pada, dibuat_oleh)
           VALUES ($1,$2,'PENDEWASAAN',$3,$4,'PROSES',now(),$5) RETURNING id`, [s.id, lot.id, t.id_meja, t.jumlah, aktor.user.sub])).rows[0].id));
      }
    } else {
      // pendewasaan selesai = panen (perilaku lama tanam.js: panen_berhasil/gagal = berhasil/gagal pendewasaan)
      anak.push(Number((await c.query(
        `INSERT INTO siklus_lot (id_siklus, id_lot_induk, tahap, id_meja, jumlah_masuk, berhasil, gagal, status, mulai_pada, selesai_pada, dibuat_oleh)
         VALUES ($1,$2,'PANEN',$3,$4,$5,$6,'SELESAI',now(),now(),$7) RETURNING id`, [s.id, lot.id, lot.id_meja, masuk, ok, gagal, aktor.user.sub])).rows[0].id));
    }
    const data = { lot: Number(lot.id), tahap: lot.tahap, berhasil: ok, gagal, lot_baru: anak };
    const sisa = Number((await c.query(
      "SELECT count(*) FROM siklus_lot WHERE id_siklus = $1 AND status = 'PROSES' AND tahap <> 'PANEN'", [s.id])).rows[0].count);
    if (sisa === 0) {
      const panen = (await c.query("SELECT 1 FROM siklus_lot WHERE id_siklus = $1 AND tahap = 'PANEN' AND berhasil > 0 LIMIT 1", [s.id])).rows[0];
      await ubahStatus(c, s, 'COMPLETED', aktor, { alasan: 'semua lot selesai', data, idem, hash, set: { hasil: panen ? 'PANEN' : null } });
    } else {
      await ubahStatus(c, s, 'GROWTH', aktor, { alasan: `lot ${lot.tahap.toLowerCase()} selesai`, data, idem, hash });
    }
    return { id_siklus: Number(s.id) };
  });
}

/* ── penjadwal (aktor sistem) ─────────────────────────────────────────── */

const SISTEM = { tipe: 'system' };

const PARAM_STABIL = { timing_operasi: ['stabil_menit', 'stabil_n_bacaan'], konfigurasi_dosis: ['stabil_toleransi_ph', 'stabil_toleransi_tds_ppm'] };

/** Parameter kestabilan: siap hanya bila SEMUA SIAP (tervalidasi). */
async function parameterKestabilan(runner) {
  const st = await bacaParameter(PARAM_STABIL, runner);
  const belum = Object.values(st).filter((x) => x.status !== 'SIAP').map((x) => `${x.param} (${x.status})`);
  return { siap: belum.length === 0, belum, nilai: Object.fromEntries(Object.entries(st).map(([k, v]) => [k, v.nilai])) };
}

/** Muat bacaan penampung dalam jendela lalu evaluasi (fungsi murni src/kestabilan.js). */
async function evaluasiTandon(runner, s, p) {
  const pita = pitaSemai(s.target);
  if (!pita) return { stabil: false, alasan: 'target semai di snapshot siklus tidak lengkap' };
  const jalan = runner ? (t, pr) => runner.query(t, pr).then((r) => r.rows) : q;
  const baris = await jalan(
    `SELECT created_at, updated_at, ph, tds, "waterTemp", n_konfirmasi, celah_maks_detik, extract(epoch FROM now()) * 1000 AS sekarang
       FROM monitorings WHERE id_meja = $1 AND (coalesce(updated_at, created_at) >= now() - make_interval(mins => $2::int)
            -- bacaan terakhir selalu ikut: bila basi, alasannya harus "basi", bukan "belum ada bacaan"
            OR id = (SELECT id FROM monitorings WHERE id_meja = $1 ORDER BY created_at DESC, id DESC LIMIT 1))
      ORDER BY created_at, id`, [s.id_meja_semai, p.stabil_menit]);
  const sekarangMs = baris.length ? Number(baris[0].sekarang) : Date.now();
  return evaluasiKestabilan(baris, {
    sekarangMs, jendelaDetik: p.stabil_menit * 60, basiDetik: SENSOR_BASI_DETIK, pita,
    toleransi: { ph: p.stabil_toleransi_ph, tds: p.stabil_toleransi_tds_ppm }, minKonfirmasi: p.stabil_n_bacaan,
  });
}

/** Diagnostik baca-saja: hasil evaluasi kestabilan siklus (tidak mengubah apa pun). */
async function kestabilan(id) {
  const s = (await q('SELECT * FROM siklus_budidaya WHERE id = $1', [id]))[0];
  if (!s) return null;
  const p = await parameterKestabilan();
  if (!p.siap) return { id_siklus: Number(id), dievaluasi: false, alasan: 'parameter kestabilan belum SIAP', parameter: p.belum };
  return { id_siklus: Number(id), dievaluasi: true, ...(await evaluasiTandon(null, s, p.nilai)) };
}

/**
 * Satu putaran: (0) siklus dosing kedaluwarsa, (1) kedaluwarsa, (2) konfirmasi H+4 jatuh tempo, (3) tandon stabil → minta konfirmasi
 * tandon (HANYA bila semua parameter kestabilan SIAP), (4) pengingat.
 * Tiap butir di transaksinya sendiri; aman dijalankan bersamaan (kunci baris + cek ulang + indeks unik).
 */
async function jalankanPenjadwal() {
  const hasil = { kedaluwarsa: 0, diminta: 0, pengingat: 0, dilewati: [], galat: [] };
  try {
    hasil.dosing_kedaluwarsa = await require('./dosingSiklus').kedaluwarsakan();
  } catch (e) { hasil.galat.push({ dosing: true, pesan: e.message }); }

  for (const r of await q("SELECT id, id_siklus FROM permintaan_konfirmasi WHERE status = 'PENDING' AND kedaluwarsa_pada <= now() ORDER BY id")) {
    try {
      await tx(async (c) => {
        const s = await kunciSiklus(c, r.id_siklus);
        const p = (await c.query("SELECT * FROM permintaan_konfirmasi WHERE id = $1 AND status = 'PENDING' AND kedaluwarsa_pada <= now() FOR UPDATE", [r.id])).rows[0];
        if (!p) return;
        await c.query("UPDATE permintaan_konfirmasi SET status = 'EXPIRED' WHERE id = $1", [p.id]);
        const data = { id_permintaan: Number(p.id), jenis: p.jenis };
        if (p.jenis === 'REJUVENATION' && s.status === 'WAITING_REJUVENATION_CONFIRMATION') {
          await ubahStatus(c, s, 'SEEDING', SISTEM, { alasan: 'konfirmasi peremajaan tidak dijawab (kedaluwarsa)', data, set: { jadwal_konfirmasi_berikut: await jadwalUlang(c, s) } });
        } else if (p.jenis === 'TANK_READY' && s.status === 'WAITING_TANK_CONFIRMATION') {
          await ubahStatus(c, s, 'TANK_PREPARATION', SISTEM, { alasan: 'konfirmasi tandon tidak dijawab (kedaluwarsa)', data });
        }
        await notif(c, {
          jenis: 'konfirmasi_kedaluwarsa', severity: 'warning', judul: 'Konfirmasi terlewat',
          isi: `Siklus #${s.id}: permintaan konfirmasi ${p.jenis} tidak dijawab sampai batas waktu. Bibit TIDAK dianggap siap.`,
          tautan: { tipe: 'siklus', id: Number(s.id) }, dedup: `kedaluwarsa:${p.id}`,
        });
        hasil.kedaluwarsa += 1;
      });
    } catch (e) { hasil.galat.push({ permintaan: Number(r.id), pesan: e.message }); }
  }

  const jatuhTempo = await q(
    "SELECT id FROM siklus_budidaya WHERE status = 'SEEDING' AND NOT perlu_tinjau AND jadwal_konfirmasi_berikut <= now() ORDER BY id");
  if (jatuhTempo.length) {
    const st = await nilaiBilaSiap({ timing_operasi: ['konfirmasi_peremajaan_batas_jam'] });
    if (st.konfirmasi_peremajaan_batas_jam == null) hasil.dilewati.push('konfirmasi_peremajaan_batas_jam belum SIAP');
    else {
      for (const r of jatuhTempo) {
        try {
          await tx(async (c) => {
            const s = await kunciSiklus(c, r.id);
            if (s.status !== 'SEEDING' || s.perlu_tinjau) return;
            const tempo = (await c.query('SELECT jadwal_konfirmasi_berikut <= now() AS ya FROM siklus_budidaya WHERE id = $1', [s.id])).rows[0].ya;
            if (!tempo) return;
            const p = await buatPermintaanRejuvenasi(c, s);
            await ubahStatus(c, s, 'WAITING_REJUVENATION_CONFIRMATION', SISTEM, {
              alasan: 'jadwal konfirmasi peremajaan tercapai', data: { id_permintaan: Number(p.id) }, set: { jadwal_konfirmasi_berikut: null },
            });
            hasil.diminta += 1;
          });
        } catch (e) { hasil.galat.push({ siklus: Number(r.id), pesan: e.message }); }
      }
    }
  }

  const tandon = await q(`SELECT s.id FROM siklus_budidaya s WHERE s.status = 'TANK_PREPARATION' AND NOT s.perlu_tinjau
      AND NOT EXISTS (SELECT 1 FROM permintaan_konfirmasi k WHERE k.id_siklus = s.id AND k.status = 'PENDING') ORDER BY s.id`);
  if (tandon.length) {
    const p = await parameterKestabilan();
    if (!p.siap) hasil.dilewati.push(`kestabilan tandon: ${p.belum.join(', ')} belum SIAP`);
    else {
      hasil.tandon_siap = 0;
      for (const r of tandon) {
        try {
          await tx(async (c) => {
            const s = await kunciSiklus(c, r.id);
            if (s.status !== 'TANK_PREPARATION' || s.perlu_tinjau) return;
            const ev = await evaluasiTandon(c, s, p.nilai);
            if (!ev.stabil) return;
            const { konfirmasi_tandon_jam: jam } = await nilaiBilaSiap({ timing_operasi: ['konfirmasi_tandon_jam'] }, (t, pr) => c.query(t, pr));
            const k = (await c.query(
              `INSERT INTO permintaan_konfirmasi (id_siklus, jenis, percobaan_ke, kedaluwarsa_pada)
               VALUES ($1, 'TANK_READY', (SELECT count(*) + 1 FROM permintaan_konfirmasi WHERE id_siklus = $1 AND jenis = 'TANK_READY'),
                       CASE WHEN $2::float8 IS NULL THEN NULL ELSE now() + make_interval(secs => $2::float8 * 3600) END) RETURNING id`,
              [s.id, jam])).rows[0];
            await ubahStatus(c, s, 'WAITING_TANK_CONFIRMATION', SISTEM, { alasan: 'tandon stabil dalam pita target', data: { id_permintaan: Number(k.id), konfirmasi: ev.konfirmasi } });
            await notif(c, {
              jenis: 'konfirmasi_tandon', judul: 'Konfirmasi tandon siap',
              isi: `Siklus #${s.id}: tandon stabil di pita target. Konfirmasi untuk mulai semai.`,
              tautan: { tipe: 'konfirmasi', id: Number(k.id), id_siklus: Number(s.id) }, dedup: `konfirmasi:${k.id}`,
            });
            hasil.tandon_siap += 1;
          });
        } catch (e) { hasil.galat.push({ siklus: Number(r.id), pesan: e.message }); }
      }
    }
  }

  await tx(async (c) => {
    const rows = (await c.query(
      `UPDATE permintaan_konfirmasi SET pengingat_terkirim = true
        WHERE status = 'PENDING' AND NOT pengingat_terkirim AND pengingat_pada <= now() RETURNING id, id_siklus, jenis, kedaluwarsa_pada`)).rows;
    for (const p of rows) {
      await notif(c, {
        jenis: 'konfirmasi_pengingat', judul: 'Pengingat konfirmasi',
        isi: `Siklus #${p.id_siklus}: konfirmasi ${p.jenis} belum dijawab. Batas: ${new Date(p.kedaluwarsa_pada).toISOString()}.`,
        tautan: { tipe: 'konfirmasi', id: Number(p.id), id_siklus: Number(p.id_siklus) }, dedup: `pengingat:${p.id}`,
      });
    }
    hasil.pengingat = rows.length;
  });
  return hasil;
}

let timer = null;
/** Default MATI. SIKLUS_PENJADWAL=1 menyalakan; tabel 3A wajib sudah ada. */
async function mulaiPenjadwal() {
  if (process.env.SIKLUS_PENJADWAL !== '1') return false;
  if (!(await fiturTersedia())) {
    console.warn('[SIKLUS] SIKLUS_PENJADWAL=1 tetapi tabel siklus belum dimigrasi — penjadwal TIDAK dijalankan.');
    return false;
  }
  const detik = Math.max(30, Number(process.env.SIKLUS_PENJADWAL_DETIK) || 60);
  console.log(`Penjadwal siklus   : AKTIF (tiap ${detik} dtk)`);
  timer = setInterval(() => {
    jalankanPenjadwal().then((r) => {
      if (r.kedaluwarsa || r.dosing_kedaluwarsa || r.diminta || r.pengingat || r.galat.length) console.log('[SIKLUS]', JSON.stringify(r));
    }).catch((e) => console.error('[SIKLUS] galat:', e.message));
  }, detik * 1000);
  if (timer.unref) timer.unref();
  return true;
}
function hentiPenjadwal() { if (timer) clearInterval(timer); timer = null; }

/* ── baca ─────────────────────────────────────────────────────────────── */

let tersedia = false;
async function fiturTersedia() {
  if (tersedia) return true;
  tersedia = (await q("SELECT to_regclass('siklus_budidaya') IS NOT NULL AND to_regclass('permintaan_konfirmasi') IS NOT NULL AND to_regclass('penugasan_penampung') IS NOT NULL AS ada"))[0].ada
    && (await q("SELECT 1 FROM information_schema.columns WHERE table_name = 'siklus_transisi' AND column_name = 'idempotency_key'")).length > 0;
  return tersedia;
}

async function daftar(f = {}) {
  const w = [];
  const p = [];
  const tambah = (sql, v) => { p.push(v); w.push(sql.replace('?', `$${p.length}`)); };
  if (f.status) tambah('s.status = ?', f.status);
  if (f.id_tanaman) tambah('s.id_tanaman = ?', f.id_tanaman);
  if (f.id_meja) tambah('s.id_meja_semai = ?', f.id_meja);
  if (f.asal) tambah('s.asal = ?', f.asal);
  if (f.perlu_tinjau !== undefined) tambah('s.perlu_tinjau = ?', f.perlu_tinjau);
  return q(`
    SELECT s.id, s.id_tanaman, t.nama_tanaman, s.id_meja_semai, m.meja, s.mode_target, s.status, s.hasil, s.jumlah_benih,
           s.benih_berhasil, s.benih_gagal, s.semai_mulai_pada, s.waktu_presisi, s.jadwal_konfirmasi_berikut, s.asal,
           s.perlu_tinjau, s.alasan_tinjau, s.dibuat_pada, s.diperbarui_pada, s.selesai_pada,
           (SELECT json_build_object('id', k.id, 'jenis', k.jenis, 'kedaluwarsa_pada', k.kedaluwarsa_pada)
              FROM permintaan_konfirmasi k WHERE k.id_siklus = s.id AND k.status = 'PENDING' LIMIT 1) AS konfirmasi_terbuka,
           (SELECT count(*)::int FROM siklus_lot l WHERE l.id_siklus = s.id AND l.status = 'PROSES' AND l.tahap <> 'PANEN') AS lot_proses
      FROM siklus_budidaya s LEFT JOIN tanamen t ON t.id_tanaman = s.id_tanaman LEFT JOIN mejas m ON m.id_meja = s.id_meja_semai
     ${w.length ? `WHERE ${w.join(' AND ')}` : ''}
     ORDER BY s.id DESC LIMIT 200`, p);
}

async function detail(id) {
  const s = (await q(`SELECT s.*, t.nama_tanaman, m.meja FROM siklus_budidaya s
    LEFT JOIN tanamen t ON t.id_tanaman = s.id_tanaman LEFT JOIN mejas m ON m.id_meja = s.id_meja_semai WHERE s.id = $1`, [id]))[0];
  if (!s) return null;
  const [lot, transisi, konfirmasi] = await Promise.all([
    q('SELECT l.*, m.meja FROM siklus_lot l LEFT JOIN mejas m ON m.id_meja = l.id_meja WHERE l.id_siklus = $1 ORDER BY l.id', [id]),
    q(`SELECT x.id, x.dari, x.ke, x.aktor_tipe, x.aktor_user_id, u.username AS aktor_username, x.alasan, x.data, x.terjadi_pada
         FROM siklus_transisi x LEFT JOIN users u ON u.id = x.aktor_user_id WHERE x.id_siklus = $1 ORDER BY x.id`, [id]),
    q('SELECT id, jenis, percobaan_ke, status, dibuat_pada, kedaluwarsa_pada, pengingat_pada, dijawab_oleh, dijawab_pada FROM permintaan_konfirmasi WHERE id_siklus = $1 ORDER BY id', [id]),
  ]);
  return { ...s, lot, transisi, konfirmasi };
}

module.exports = {
  JALUR, SiklusGalat, bolehTransisi, hashPermintaan, pitaSemai, validasiTargetManual,
  buatSiklus, transisiManual, mintaKonfirmasi, jawabKonfirmasi, konfirmasiBenih, selesaikanLot,
  jalankanPenjadwal, mulaiPenjadwal, hentiPenjadwal, fiturTersedia, daftar, detail, kestabilan, evaluasiTandon,
};
