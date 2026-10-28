#!/usr/bin/env node
'use strict';
/**
 * Migrasi data tahap lama → model siklus baru (Fase 3A, docs/DESAIN_FASE2.md §4.6 & §10).
 *
 *   node scripts/migrasi-siklus.js --kering    laporan rencana; transaksi di-ROLLBACK (tidak mengubah data)
 *   node scripts/migrasi-siklus.js --jalan     salin data (idempoten: aman dijalankan berulang)
 *   node scripts/migrasi-siklus.js --paritas   bandingkan lama vs baru; exit 1 bila ada selisih
 *   node scripts/migrasi-siklus.js --balik     hapus HANYA hasil migrasi (asal='MIGRASI' / legacy_*)
 *
 * DB tujuan = DATABASE_URL (env, lalu .env). Tabel lama TIDAK PERNAH diubah oleh skrip ini.
 * Data yang tidak memenuhi aturan baru disalin apa adanya + perlu_tinjau (keputusan 29 Okt 2026).
 */
const { Client } = require('pg');
require('../src/config');

const SUMBER_PRESET = 'migrasi: target_nutrisi+tanamen+sikluses';
const TAHAP = { Semai: 'SEMAI', Peremajaan: 'PEREMAJAAN', Pendewasaan: 'PENDEWASAAN' };
const STATUS_LOT = { proses: 'PROSES', selesai: 'SELESAI', gagal: 'GAGAL' };
// tanggal lama (date) → awal hari WITA
const TGL = (kol) => `CASE WHEN ${kol} IS NULL THEN NULL ELSE (${kol}::timestamp AT TIME ZONE 'Asia/Makassar') END`;

const n = (v) => (v == null ? null : Number(v));
const jumlahCocok = (jumlah, ok, gagal) => n(jumlah) != null && n(ok) + n(gagal) === n(jumlah);

/** Alasan tinjau untuk satu baris tahap lama (kosong = bersih). */
function alasanLot(r, masuk, ok, gagal) {
  const a = [];
  if (r[masuk] == null) a.push('jumlah_masuk kosong');
  if (r.status !== 'proses' && !jumlahCocok(r[masuk], r[ok], r[gagal])) a.push('berhasil+gagal ≠ jumlah_masuk');
  if (r.status === 'proses' && r[masuk] != null && n(r[ok]) + n(r[gagal]) > n(r[masuk])) a.push('berhasil+gagal > jumlah_masuk saat proses');
  return a;
}

/** Status siklus dari semai + lot turunannya (DESAIN_FASE2 D.2). */
function statusSiklus(semaiStatus, lots) {
  if (lots.some((l) => l.tahap !== 'PANEN' && l.status === 'PROSES')) return { status: 'GROWTH', hasil: null };
  if (semaiStatus === 'proses' && lots.length === 0) return { status: 'SEEDING', hasil: null };
  if (lots.some((l) => l.tahap === 'PANEN')) return { status: 'COMPLETED', hasil: 'PANEN' };
  if (semaiStatus === 'gagal') return { status: 'COMPLETED', hasil: 'GAGAL_SEMAI' };
  return { status: 'COMPLETED', hasil: null };
}

async function bacaLama(c) {
  const q = async (s) => (await c.query(s)).rows;
  return {
    semai: await q(`SELECT *, ${TGL('tgl_awal_semai')} AS mulai, ${TGL('tgl_akhir_semai')} AS akhir FROM semais ORDER BY id_semai`),
    prm: await q(`SELECT *, ${TGL('tgl_awal_peremajaan')} AS mulai, ${TGL('tgl_akhir_peremajaan')} AS akhir FROM peremajaans ORDER BY id_peremajaan`),
    pdw: await q(`SELECT *, ${TGL('tgl_awal_pendewasaan')} AS mulai, ${TGL('tgl_akhir_pendewasaan')} AS akhir FROM pendewasaans ORDER BY id_pendewasaan`),
    pnn: await q(`SELECT *, ${TGL('tgl_panen')} AS tgl FROM panens ORDER BY id_panen`),
  };
}

/** Preset versi 1 per tanaman dari target_nutrisi (aktif) + naik harian tanamen + durasi sikluses. */
async function migrasiPreset(c, lap) {
  const tanaman = (await c.query(`
    SELECT t.id_tanaman, t.nama_tanaman, t.ppm_awal, t.ppm_target, t.hari_capai FROM tanamen t
     WHERE EXISTS (SELECT 1 FROM target_nutrisi tn WHERE tn.id_tanaman = t.id_tanaman AND tn.status = 'aktif')
        OR t.ppm_awal IS NOT NULL
        OR EXISTS (SELECT 1 FROM sikluses s WHERE s.id_tanaman = t.id_tanaman)
     ORDER BY t.id_tanaman`)).rows;
  const peta = new Map();
  for (const t of tanaman) {
    const target = (await c.query(
      "SELECT tahap, ec_min_ppm, ec_max_ppm, ph_min, ph_max, umur_min_hari, umur_max_hari, keterangan, sumber FROM target_nutrisi WHERE id_tanaman = $1 AND status = 'aktif' ORDER BY id",
      [t.id_tanaman])).rows;
    const durasi = (await c.query('SELECT nama_siklus, waktu_siklus FROM sikluses WHERE id_tanaman = $1 ORDER BY id_siklus', [t.id_tanaman])).rows;
    const parameter = { tahap: {}, durasi_hari: {}, naik_harian: null, catatan_migrasi: 'disalin apa adanya; belum divalidasi agronom' };
    for (const r of target) {
      const k = TAHAP[r.tahap] || r.tahap;
      parameter.tahap[k] = {
        ec_min_ppm: n(r.ec_min_ppm), ec_max_ppm: n(r.ec_max_ppm), ph_min: n(r.ph_min), ph_max: n(r.ph_max),
        umur_min_hari: r.umur_min_hari, umur_max_hari: r.umur_max_hari, sumber_lama: r.sumber,
      };
    }
    for (const d of durasi) parameter.durasi_hari[TAHAP[d.nama_siklus] || d.nama_siklus] = d.waktu_siklus;
    if (t.ppm_awal != null) parameter.naik_harian = { ppm_awal: n(t.ppm_awal), ppm_target: n(t.ppm_target), hari_capai: t.hari_capai };

    await c.query(
      `INSERT INTO preset_nutrisi (id_tanaman, nama) VALUES ($1, $2) ON CONFLICT (id_tanaman, nama) DO NOTHING`,
      [t.id_tanaman, `${t.nama_tanaman} (migrasi)`]);
    const p = (await c.query('SELECT id, aktif_versi_id FROM preset_nutrisi WHERE id_tanaman = $1 AND nama = $2',
      [t.id_tanaman, `${t.nama_tanaman} (migrasi)`])).rows[0];
    let v = (await c.query('SELECT id FROM preset_versi WHERE id_preset = $1 AND versi = 1', [p.id])).rows[0];
    if (!v) {
      v = (await c.query(
        `INSERT INTO preset_versi (id_preset, versi, parameter, status_validasi, catatan, sumber)
         VALUES ($1, 1, $2, 'BELUM_TERVALIDASI', 'Hasil migrasi data lama', $3) RETURNING id`,
        [p.id, parameter, SUMBER_PRESET])).rows[0];
      lap.preset_baru += 1;
    }
    if (!p.aktif_versi_id) await c.query('UPDATE preset_nutrisi SET aktif_versi_id = $2 WHERE id = $1', [p.id, v.id]);
    peta.set(String(t.id_tanaman), v.id);
  }
  return peta;
}

/** Sisipkan siklus (idempoten lewat kolom legacy unik). Mengembalikan id. */
async function sisipSiklus(c, kolomLegacy, legacyId, s, lap) {
  const r = (await c.query(
    `INSERT INTO siklus_budidaya (id_tanaman, id_meja_semai, id_preset_versi, mode_target, target, jumlah_benih,
       benih_berhasil, benih_gagal, status, hasil, semai_mulai_pada, waktu_presisi, keterangan, dibuat_pada,
       diperbarui_pada, selesai_pada, expires_at, asal, perlu_tinjau, alasan_tinjau, ${kolomLegacy})
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'TANGGAL',$12,$13,$13,$14,$15,'MIGRASI',$16,$17,$18)
     ON CONFLICT (${kolomLegacy}) DO NOTHING RETURNING id`,
    [s.id_tanaman, s.id_meja, s.id_preset_versi, s.id_preset_versi ? 'PRESET' : 'MANUAL',
      { catatan: 'data migrasi; target saat siklus berjalan tidak tercatat di model lama' },
      s.jumlah_benih ?? 0, s.benih_berhasil, s.benih_gagal, s.status, s.hasil, s.mulai, s.keterangan,
      s.dibuat_pada || new Date(), s.selesai_pada, s.expires_at, s.alasan.length > 0, s.alasan, legacyId])).rows[0];
  if (r) {
    lap.siklus_baru += 1;
    await c.query(
      `INSERT INTO siklus_transisi (id_siklus, dari, ke, aktor_tipe, alasan, data)
       VALUES ($1, NULL, $2, 'system', 'MIGRASI dari data tahap lama', $3)`,
      [r.id, s.status, { [kolomLegacy]: legacyId, hasil: s.hasil, perlu_tinjau: s.alasan }]);
    return r.id;
  }
  return (await c.query(`SELECT id FROM siklus_budidaya WHERE ${kolomLegacy} = $1`, [legacyId])).rows[0].id;
}

async function sisipLot(c, l, lap) {
  const r = (await c.query(
    `INSERT INTO siklus_lot (id_siklus, id_lot_induk, tahap, id_meja, jumlah_masuk, berhasil, gagal, status,
       mulai_pada, selesai_pada, waktu_presisi, keterangan, dibuat_pada, expires_at, perlu_tinjau, alasan_tinjau,
       legacy_tabel, legacy_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'TANGGAL',$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (legacy_tabel, legacy_id) DO NOTHING RETURNING id`,
    [l.id_siklus, l.induk, l.tahap, l.id_meja, l.masuk, l.ok, l.gagal, l.status, l.mulai, l.selesai, l.keterangan,
      l.dibuat_pada || new Date(), l.expires_at, l.alasan.length > 0, l.alasan, l.legacy_tabel, l.legacy_id])).rows[0];
  if (r) { lap.lot_baru += 1; return r.id; }
  return (await c.query('SELECT id FROM siklus_lot WHERE legacy_tabel = $1 AND legacy_id = $2', [l.legacy_tabel, l.legacy_id])).rows[0].id;
}

async function migrasi(c) {
  const lap = { preset_baru: 0, siklus_baru: 0, lot_baru: 0, tinjau: [] };
  const presetPeta = await migrasiPreset(c, lap);
  const L = await bacaLama(c);

  // rencana lot per semai (dipakai juga untuk menentukan status siklus)
  const prmPerSemai = new Map();
  for (const p of L.prm) {
    if (!prmPerSemai.has(String(p.id_semai))) prmPerSemai.set(String(p.id_semai), []);
    prmPerSemai.get(String(p.id_semai)).push(p);
  }
  const pdwPerPrm = new Map();
  const yatim = [];
  const prmIds = new Set(L.prm.map((p) => String(p.id_peremajaan)));
  for (const d of L.pdw) {
    if (d.id_peremajaan == null || !prmIds.has(String(d.id_peremajaan))) { yatim.push(d); continue; }
    if (!pdwPerPrm.has(String(d.id_peremajaan))) pdwPerPrm.set(String(d.id_peremajaan), []);
    pdwPerPrm.get(String(d.id_peremajaan)).push(d);
  }
  const pnnPerPdw = new Map();
  for (const x of L.pnn) {
    if (!pnnPerPdw.has(String(x.id_pendewasaan))) pnnPerPdw.set(String(x.id_pendewasaan), []);
    pnnPerPdw.get(String(x.id_pendewasaan)).push(x);
  }

  const lotPrm = (p) => ({ tahap: 'PEREMAJAAN', status: STATUS_LOT[p.status] });
  const lotPdw = (d) => ({ tahap: 'PENDEWASAAN', status: STATUS_LOT[d.status] });
  const turunan = (prms) => {
    const out = [];
    for (const p of prms) {
      out.push(lotPrm(p));
      for (const d of pdwPerPrm.get(String(p.id_peremajaan)) || []) {
        out.push(lotPdw(d));
        for (const _ of pnnPerPdw.get(String(d.id_pendewasaan)) || []) out.push({ tahap: 'PANEN', status: 'SELESAI' });
      }
    }
    return out;
  };
  const akhirLot = (prms) => {
    let t = null;
    const geser = (v) => { if (v && (!t || new Date(v) > t)) t = new Date(v); };
    for (const p of prms) {
      if (p.status !== 'proses') geser(p.akhir);
      for (const d of pdwPerPrm.get(String(p.id_peremajaan)) || []) {
        if (d.status !== 'proses') geser(d.akhir);
        for (const x of pnnPerPdw.get(String(d.id_pendewasaan)) || []) geser(x.tgl);
      }
    }
    return t;
  };

  // pendewasaan + panen di bawah lot peremajaan
  async function lotBawah(idSiklus, indukId, d) {
    const a = alasanLot(d, 'jumlah_masuk', 'tanaman_berhasil', 'tanaman_gagal');
    const idPdw = await sisipLot(c, {
      id_siklus: idSiklus, induk: indukId, tahap: 'PENDEWASAAN', id_meja: d.id_meja, masuk: d.jumlah_masuk,
      ok: d.tanaman_berhasil, gagal: d.tanaman_gagal, status: STATUS_LOT[d.status], mulai: d.mulai,
      selesai: d.status === 'proses' ? null : d.akhir, keterangan: d.keterangan, dibuat_pada: d.created_at,
      expires_at: d.expires_at, alasan: a, legacy_tabel: 'pendewasaans', legacy_id: d.id_pendewasaan,
    }, lap);
    if (a.length) lap.tinjau.push({ tabel: 'pendewasaans', id: d.id_pendewasaan, alasan: a });
    for (const x of pnnPerPdw.get(String(d.id_pendewasaan)) || []) {
      await sisipLot(c, {
        id_siklus: idSiklus, induk: idPdw, tahap: 'PANEN', id_meja: d.id_meja, masuk: null,
        ok: x.panen_berhasil, gagal: x.panen_gagal, status: 'SELESAI', mulai: x.tgl, selesai: x.tgl,
        keterangan: x.keterangan, dibuat_pada: x.created_at, expires_at: x.expires_at, alasan: [],
        legacy_tabel: 'panens', legacy_id: x.id_panen,
      }, lap);
    }
  }

  for (const s of L.semai) {
    const prms = prmPerSemai.get(String(s.id_semai)) || [];
    const { status, hasil } = statusSiklus(s.status, turunan(prms));
    const alasan = [];
    if (s.id_tanaman == null) alasan.push('id_tanaman kosong');
    if (s.id_meja == null) alasan.push('id_meja kosong');
    if (s.status !== 'proses' && !jumlahCocok(s.jumlah_benih, s.benih_berhasil, s.benih_gagal)) alasan.push('benih_berhasil+benih_gagal ≠ jumlah_benih');
    const selesai = status === 'COMPLETED' ? (akhirLot(prms) || s.akhir || s.updated_at || s.created_at || new Date()) : null;
    const idSiklus = await sisipSiklus(c, 'legacy_semai_id', s.id_semai, {
      id_tanaman: s.id_tanaman, id_meja: s.id_meja, id_preset_versi: s.id_tanaman ? presetPeta.get(String(s.id_tanaman)) ?? null : null,
      jumlah_benih: s.jumlah_benih, benih_berhasil: s.benih_berhasil, benih_gagal: s.benih_gagal, status, hasil,
      mulai: s.mulai || s.created_at, keterangan: s.keterangan, dibuat_pada: s.created_at, selesai_pada: selesai,
      expires_at: s.expires_at, alasan,
    }, lap);
    if (alasan.length) lap.tinjau.push({ tabel: 'semais', id: s.id_semai, alasan });
    for (const p of prms) {
      const a = alasanLot(p, 'jumlah_masuk', 'benih_berhasil', 'benih_gagal');
      const idPrm = await sisipLot(c, {
        id_siklus: idSiklus, induk: null, tahap: 'PEREMAJAAN', id_meja: p.id_meja, masuk: p.jumlah_masuk,
        ok: p.benih_berhasil, gagal: p.benih_gagal, status: STATUS_LOT[p.status], mulai: p.mulai,
        selesai: p.status === 'proses' ? null : p.akhir, keterangan: p.keterangan, dibuat_pada: p.created_at,
        expires_at: p.expires_at, alasan: a, legacy_tabel: 'peremajaans', legacy_id: p.id_peremajaan,
      }, lap);
      if (a.length) lap.tinjau.push({ tabel: 'peremajaans', id: p.id_peremajaan, alasan: a });
      for (const d of pdwPerPrm.get(String(p.id_peremajaan)) || []) await lotBawah(idSiklus, idPrm, d);
    }
  }

  // pendewasaan yatim → siklus tersendiri (keputusan 29 Okt 2026)
  for (const d of yatim) {
    const panen = (pnnPerPdw.get(String(d.id_pendewasaan)) || []).length > 0;
    const status = d.status === 'proses' ? 'GROWTH' : 'COMPLETED';
    const alasan = ['pendewasaan yatim: peremajaan induk terhapus', 'id_tanaman tidak diketahui'];
    const idSiklus = await sisipSiklus(c, 'legacy_pendewasaan_yatim', d.id_pendewasaan, {
      id_tanaman: null, id_meja: null, id_preset_versi: null, jumlah_benih: 0, benih_berhasil: null, benih_gagal: null,
      status, hasil: status === 'COMPLETED' && panen ? 'PANEN' : null, mulai: null, keterangan: d.keterangan,
      dibuat_pada: d.created_at,
      selesai_pada: status === 'COMPLETED' ? (d.akhir || d.updated_at || d.created_at || new Date()) : null,
      expires_at: d.expires_at, alasan,
    }, lap);
    lap.tinjau.push({ tabel: 'pendewasaans', id: d.id_pendewasaan, alasan });
    await lotBawah(idSiklus, null, d);
  }
  return lap;
}

/** Paritas lama ↔ baru. Mengembalikan daftar selisih (kosong = lulus). */
async function paritas(c) {
  const selisih = [];
  const satu = async (s) => (await c.query(s)).rows[0];
  const cek = async (nama, sql) => {
    const r = await satu(sql);
    if (Number(r.lama) !== Number(r.baru)) selisih.push({ cek: nama, lama: r.lama, baru: r.baru });
  };
  await cek('jumlah semai → siklus', `SELECT (SELECT count(*) FROM semais) lama, (SELECT count(*) FROM siklus_budidaya WHERE legacy_semai_id IS NOT NULL) baru`);
  for (const t of ['peremajaans', 'pendewasaans', 'panens']) {
    await cek(`jumlah ${t} → lot`, `SELECT (SELECT count(*) FROM ${t}) lama, (SELECT count(*) FROM siklus_lot WHERE legacy_tabel = '${t}') baru`);
  }
  await cek('pendewasaan yatim → siklus yatim', `
    SELECT (SELECT count(*) FROM pendewasaans d WHERE NOT EXISTS (SELECT 1 FROM peremajaans p WHERE p.id_peremajaan = d.id_peremajaan)) lama,
           (SELECT count(*) FROM siklus_budidaya WHERE legacy_pendewasaan_yatim IS NOT NULL) baru`);
  // nilai per baris identik (IS DISTINCT FROM menangani NULL)
  const baris = [
    ['semais', `SELECT count(*) n FROM semais s JOIN siklus_budidaya b ON b.legacy_semai_id = s.id_semai
      WHERE b.id_tanaman IS DISTINCT FROM s.id_tanaman OR b.id_meja_semai IS DISTINCT FROM s.id_meja
         OR b.jumlah_benih IS DISTINCT FROM coalesce(s.jumlah_benih, 0) OR b.benih_berhasil IS DISTINCT FROM s.benih_berhasil
         OR b.benih_gagal IS DISTINCT FROM s.benih_gagal OR b.keterangan IS DISTINCT FROM s.keterangan
         OR b.expires_at IS DISTINCT FROM s.expires_at
         OR (s.tgl_awal_semai IS NOT NULL AND (b.semai_mulai_pada AT TIME ZONE 'Asia/Makassar')::date IS DISTINCT FROM s.tgl_awal_semai)`],
    ['peremajaans', `SELECT count(*) n FROM peremajaans p JOIN siklus_lot l ON l.legacy_tabel = 'peremajaans' AND l.legacy_id = p.id_peremajaan
      WHERE l.id_meja IS DISTINCT FROM p.id_meja OR l.jumlah_masuk IS DISTINCT FROM p.jumlah_masuk
         OR l.berhasil IS DISTINCT FROM p.benih_berhasil OR l.gagal IS DISTINCT FROM p.benih_gagal
         OR l.status IS DISTINCT FROM upper(p.status) OR l.keterangan IS DISTINCT FROM p.keterangan
         OR l.expires_at IS DISTINCT FROM p.expires_at OR l.tahap <> 'PEREMAJAAN' OR l.id_lot_induk IS NOT NULL
         OR l.id_siklus IS DISTINCT FROM (SELECT id FROM siklus_budidaya WHERE legacy_semai_id = p.id_semai)`],
    ['pendewasaans', `SELECT count(*) n FROM pendewasaans d JOIN siklus_lot l ON l.legacy_tabel = 'pendewasaans' AND l.legacy_id = d.id_pendewasaan
      LEFT JOIN siklus_lot i ON i.id = l.id_lot_induk
      WHERE l.id_meja IS DISTINCT FROM d.id_meja OR l.jumlah_masuk IS DISTINCT FROM d.jumlah_masuk
         OR l.berhasil IS DISTINCT FROM d.tanaman_berhasil OR l.gagal IS DISTINCT FROM d.tanaman_gagal
         OR l.status IS DISTINCT FROM upper(d.status) OR l.keterangan IS DISTINCT FROM d.keterangan
         OR l.expires_at IS DISTINCT FROM d.expires_at OR l.tahap <> 'PENDEWASAAN'
         OR (CASE WHEN EXISTS (SELECT 1 FROM peremajaans p WHERE p.id_peremajaan = d.id_peremajaan)
                  THEN i.legacy_tabel IS DISTINCT FROM 'peremajaans' OR i.legacy_id IS DISTINCT FROM d.id_peremajaan OR i.id_siklus <> l.id_siklus
                  ELSE l.id_lot_induk IS NOT NULL
                       OR l.id_siklus IS DISTINCT FROM (SELECT id FROM siklus_budidaya WHERE legacy_pendewasaan_yatim = d.id_pendewasaan) END)`],
    ['panens', `SELECT count(*) n FROM panens x JOIN siklus_lot l ON l.legacy_tabel = 'panens' AND l.legacy_id = x.id_panen
      LEFT JOIN siklus_lot i ON i.id = l.id_lot_induk
      WHERE l.berhasil IS DISTINCT FROM x.panen_berhasil OR l.gagal IS DISTINCT FROM x.panen_gagal
         OR l.keterangan IS DISTINCT FROM x.keterangan OR l.expires_at IS DISTINCT FROM x.expires_at
         OR l.tahap <> 'PANEN' OR i.legacy_tabel IS DISTINCT FROM 'pendewasaans' OR i.legacy_id IS DISTINCT FROM x.id_pendewasaan
         OR i.id_siklus <> l.id_siklus
         OR (x.tgl_panen IS NOT NULL AND (l.mulai_pada AT TIME ZONE 'Asia/Makassar')::date IS DISTINCT FROM x.tgl_panen)`],
  ];
  for (const [t, sql] of baris) {
    const r = await satu(sql);
    if (Number(r.n) !== 0) selisih.push({ cek: `nilai per baris ${t}`, baris_beda: Number(r.n) });
  }
  // agregat per tabel/status
  const agregat = [
    ['semais', `SELECT status k, count(*) c, sum(jumlah_benih) j, sum(benih_berhasil) o, sum(benih_gagal) g FROM semais GROUP BY 1`,
      `SELECT CASE WHEN asal='MIGRASI' THEN (SELECT status FROM semais WHERE id_semai = legacy_semai_id) END k, count(*) c, sum(jumlah_benih) j, sum(benih_berhasil) o, sum(benih_gagal) g
         FROM siklus_budidaya WHERE legacy_semai_id IS NOT NULL GROUP BY 1`],
    ['peremajaans', `SELECT upper(status) k, count(*) c, sum(jumlah_masuk) j, sum(benih_berhasil) o, sum(benih_gagal) g FROM peremajaans GROUP BY 1`,
      `SELECT status k, count(*) c, sum(jumlah_masuk) j, sum(berhasil) o, sum(gagal) g FROM siklus_lot WHERE legacy_tabel = 'peremajaans' GROUP BY 1`],
    ['pendewasaans', `SELECT upper(status) k, count(*) c, sum(jumlah_masuk) j, sum(tanaman_berhasil) o, sum(tanaman_gagal) g FROM pendewasaans GROUP BY 1`,
      `SELECT status k, count(*) c, sum(jumlah_masuk) j, sum(berhasil) o, sum(gagal) g FROM siklus_lot WHERE legacy_tabel = 'pendewasaans' GROUP BY 1`],
    ['panens', `SELECT 'x' k, count(*) c, 0 j, sum(panen_berhasil) o, sum(panen_gagal) g FROM panens`,
      `SELECT 'x' k, count(*) c, 0 j, sum(berhasil) o, sum(gagal) g FROM siklus_lot WHERE legacy_tabel = 'panens'`],
  ];
  for (const [t, a, b] of agregat) {
    const urut = (rows) => JSON.stringify(rows.map((r) => [r.k, String(r.c), String(r.j), String(r.o), String(r.g)]).sort());
    const lama = urut((await c.query(a)).rows);
    const baru = urut((await c.query(b)).rows);
    if (lama !== baru) selisih.push({ cek: `agregat ${t}`, lama, baru });
  }
  // tidak ada baris baru yang menunjuk legacy fiktif
  const fiktif = await satu(`SELECT
    (SELECT count(*) FROM siklus_budidaya b WHERE legacy_semai_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM semais s WHERE s.id_semai = b.legacy_semai_id))
  + (SELECT count(*) FROM siklus_lot l WHERE legacy_tabel = 'peremajaans' AND NOT EXISTS (SELECT 1 FROM peremajaans p WHERE p.id_peremajaan = l.legacy_id))
  + (SELECT count(*) FROM siklus_lot l WHERE legacy_tabel = 'pendewasaans' AND NOT EXISTS (SELECT 1 FROM pendewasaans p WHERE p.id_pendewasaan = l.legacy_id))
  + (SELECT count(*) FROM siklus_lot l WHERE legacy_tabel = 'panens' AND NOT EXISTS (SELECT 1 FROM panens p WHERE p.id_panen = l.legacy_id)) n`);
  if (Number(fiktif.n) !== 0) selisih.push({ cek: 'baris baru tanpa sumber lama', n: Number(fiktif.n) });
  return selisih;
}

async function balik(c) {
  await c.query("SET LOCAL garap.rollback_migrasi = 'on'");
  const hapus = async (sql) => (await c.query(sql)).rowCount;
  const out = {};
  out.transisi = await hapus("DELETE FROM siklus_transisi WHERE id_siklus IN (SELECT id FROM siklus_budidaya WHERE asal = 'MIGRASI')");
  out.lot_panen = await hapus("DELETE FROM siklus_lot WHERE legacy_tabel = 'panens'");
  out.lot_pendewasaan = await hapus("DELETE FROM siklus_lot WHERE legacy_tabel = 'pendewasaans'");
  out.lot_peremajaan = await hapus("DELETE FROM siklus_lot WHERE legacy_tabel = 'peremajaans'");
  out.siklus = await hapus("DELETE FROM siklus_budidaya WHERE asal = 'MIGRASI'");
  await c.query(`UPDATE preset_nutrisi SET aktif_versi_id = NULL
                  WHERE aktif_versi_id IN (SELECT id FROM preset_versi WHERE sumber = $1)`, [SUMBER_PRESET]);
  out.preset_versi = (await c.query('DELETE FROM preset_versi WHERE sumber = $1', [SUMBER_PRESET])).rowCount;
  out.preset = await hapus("DELETE FROM preset_nutrisi p WHERE nama LIKE '% (migrasi)' AND NOT EXISTS (SELECT 1 FROM preset_versi v WHERE v.id_preset = p.id)");
  return out;
}

async function main() {
  const mode = process.argv[2];
  if (!['--kering', '--jalan', '--paritas', '--balik'].includes(mode)) {
    console.error('Pakai: --kering | --jalan | --paritas | --balik');
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL belum diisi');
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  console.log(`DB: ${new URL(process.env.DATABASE_URL).pathname.slice(1)}  mode: ${mode}`);
  try {
    if (mode === '--paritas') {
      const s = await paritas(c);
      console.log(s.length ? `PARITAS GAGAL (${s.length}):\n${JSON.stringify(s, null, 1)}` : 'PARITAS LULUS: semua cek cocok.');
      process.exitCode = s.length ? 1 : 0;
      return;
    }
    await c.query('BEGIN');
    // satu proses migrasi pada satu waktu
    await c.query("SELECT pg_advisory_xact_lock(hashtext('garap.migrasi_siklus'))");
    if (mode === '--balik') {
      const out = await balik(c);
      await c.query('COMMIT');
      console.log('ROLLBACK MIGRASI selesai:', JSON.stringify(out));
      return;
    }
    const lap = await migrasi(c);
    const s = await paritas(c);
    lap.paritas = s.length ? s : 'LULUS';
    if (mode === '--kering' || s.length) {
      await c.query('ROLLBACK');
      console.log(mode === '--kering' ? 'KERING (tidak ada yang disimpan):' : 'DIBATALKAN — paritas gagal, tidak ada yang disimpan:');
    } else {
      await c.query('COMMIT');
      console.log('JALAN (disimpan):');
    }
    console.log(JSON.stringify(lap, null, 1));
    if (s.length) process.exitCode = 1;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(`migrasi-siklus gagal: ${e.message}`); process.exit(1); });
}

module.exports = { statusSiklus, alasanLot, jumlahCocok };
