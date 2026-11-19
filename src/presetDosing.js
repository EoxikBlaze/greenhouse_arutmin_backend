'use strict';
/**
 * PRESET DOSING — target EC/pH tiap penampung diisi OTOMATIS dari preset (tabel target_nutrisi).
 *
 * Preset = baris target_nutrisi berstatus 'aktif': (tanaman | semua tanaman) × tahap × rentang umur
 * → rentang EC (ppm) & pH. Untuk tiap meja, server mencari batch tanam yang sedang berjalan di meja
 * itu (semai / peremajaan / pendewasaan berstatus 'proses'), lalu memilih preset paling spesifik:
 *   1. preset tanaman itu sendiri, sebelum preset "semua tanaman";
 *   2. yang rentang umurnya cocok (umur = hari sejak semai dimulai), yang paling sempit dulu.
 * Target = titik tengah rentang. Penampung bermode 'manual' tidak pernah disentuh.
 *
 * NAIK HARIAN (per jenis tanaman, kolom tanamen.ppm_awal / ppm_target / hari_capai): sejak pindah netpot
 * (mulai tahap Peremajaan) target ppm = awal + (target − awal) × hari / hari_capai, lalu ditahan di target
 * sampai panen. Menggantikan EC preset pada Peremajaan & Pendewasaan; pH tetap dari preset. Semai tak berubah.
 *
 * Disinkronkan: saat server menyala, tiap 10 menit (umur bertambah), setelah mulai/selesai tahap,
 * dan setelah preset / mode diubah. Otomasi dosing (src/otomasi.js) membaca target hasil sinkron ini;
 * semua pagar keselamatan (src/aktuator.js) tetap berlaku.
 */
const { q } = require('./db');

const TAHAP = ['Semai', 'Peremajaan', 'Pendewasaan'];

/** Batch berjalan per meja (yang paling baru dimulai bila ada lebih dari satu). */
async function batchPerMeja() {
  const rows = await q(`
    WITH b AS (
      SELECT s.id_meja, 'Semai' AS tahap, s.id_semai AS id, s.id_tanaman, s.tgl_awal_semai AS mulai,
             s.tgl_awal_semai AS semai_mulai, NULL::date AS netpot_mulai, s.jumlah_benih AS jumlah, s.id_semai AS id_semai
        FROM semais s WHERE s.status = 'proses' AND s.id_meja IS NOT NULL
      UNION ALL
      SELECT p.id_meja, 'Peremajaan', p.id_peremajaan, s.id_tanaman, p.tgl_awal_peremajaan, s.tgl_awal_semai,
             p.tgl_awal_peremajaan, p.jumlah_masuk, s.id_semai
        FROM peremajaans p LEFT JOIN semais s ON s.id_semai = p.id_semai
       WHERE p.status = 'proses' AND p.id_meja IS NOT NULL
      UNION ALL
      SELECT d.id_meja, 'Pendewasaan', d.id_pendewasaan, s.id_tanaman, d.tgl_awal_pendewasaan, s.tgl_awal_semai,
             coalesce(p.tgl_awal_peremajaan, d.tgl_awal_pendewasaan), d.jumlah_masuk, s.id_semai
        FROM pendewasaans d LEFT JOIN peremajaans p ON p.id_peremajaan = d.id_peremajaan
        LEFT JOIN semais s ON s.id_semai = p.id_semai
       WHERE d.status = 'proses' AND d.id_meja IS NOT NULL
    )
    SELECT b.*, t.nama_tanaman, (current_date - coalesce(b.semai_mulai, b.mulai)) + 1 AS umur_hari,
           (current_date - b.netpot_mulai::date) AS hari_netpot, t.ppm_awal, t.ppm_target, t.hari_capai,
           ks.kurva_ppm_awal, ks.kurva_ppm_target, ks.kurva_hari_capai, ks.kurva_mulai_hari, ks.kurva_mulai_ppm,
           ks.kurva_cara, ks.kurva_ppm_semai, ks.kurva_ppm_peremajaan, ks.kurva_ppm_pendewasaan, ks.kurva_ph_min, ks.kurva_ph_max,
           count(*) OVER (PARTITION BY b.id_meja) AS jumlah_batch
      FROM b LEFT JOIN tanamen t ON t.id_tanaman = b.id_tanaman
      LEFT JOIN semais ks ON ks.id_semai = b.id_semai
     ORDER BY b.id_meja, b.mulai DESC, b.id DESC`);
  const peta = new Map();
  for (const r of rows) if (!peta.has(String(r.id_meja))) peta.set(String(r.id_meja), r);
  return peta;
}

const angka = (v) => (v == null || v === '' ? null : Number(v));

/** Preset paling cocok untuk batch, dari daftar preset aktif. null bila tidak ada. */
function pilihPreset(batch, presets) {
  if (!batch) return null;
  const umur = Number(batch.umur_hari);
  const cocok = presets.filter((p) => p.tahap.toLowerCase() === batch.tahap.toLowerCase()
    && (p.id_tanaman == null || String(p.id_tanaman) === String(batch.id_tanaman))
    && (p.umur_min_hari == null || umur >= Number(p.umur_min_hari))
    && (p.umur_max_hari == null || umur <= Number(p.umur_max_hari))
    && (angka(p.ec_min_ppm) != null || angka(p.ec_max_ppm) != null || angka(p.ph_min) != null || angka(p.ph_max) != null));
  const lebar = (p) => (p.umur_min_hari == null || p.umur_max_hari == null ? Infinity : p.umur_max_hari - p.umur_min_hari);
  cocok.sort((a, b) => (a.id_tanaman == null) - (b.id_tanaman == null) || lebar(a) - lebar(b) || Number(a.id) - Number(b.id));
  return cocok[0] || null;
}

/**
 * Kurva batch: salinan di semais.kurva_* (sejak 18 Nov 2026), atau kurva tanaman untuk batch lama tanpa salinan.
 * mulai_hari/mulai_ppm = titik lanjut setelah kurva diubah di tengah jalan (0 / ppm_awal bila belum pernah).
 */
function kurvaBatch(batch) {
  const salinan = angka(batch.kurva_ppm_awal) != null;
  const awal = salinan ? angka(batch.kurva_ppm_awal) : angka(batch.ppm_awal);
  const akhir = salinan ? angka(batch.kurva_ppm_target) : angka(batch.ppm_target);
  const lama = salinan ? angka(batch.kurva_hari_capai) : angka(batch.hari_capai);
  const mulaiHari = salinan ? angka(batch.kurva_mulai_hari) ?? 0 : 0;
  const mulaiPpm = salinan ? angka(batch.kurva_mulai_ppm) ?? awal : awal;
  if (awal == null || akhir == null || !lama) return null;
  return { awal, akhir, lama, mulaiHari, mulaiPpm };
}

/**
 * Target ppm hari ini dari kurva naik harian batch, atau null bila tidak berlaku
 * (Semai, tanaman tanpa pengaturan, atau tanggal pindah netpot tidak diketahui).
 * Hari ke-0 = tanggal mulai Peremajaan → ppm_awal; hari ≥ hari_capai → ppm_target (ditahan).
 * Setelah kurva diubah pada hari m dengan target t_m: naik rata dari t_m ke target baru (tanpa lompatan).
 */
function naikHarian(batch) {
  if (!batch || batch.tahap === 'Semai') return null;
  const k = kurvaBatch(batch);
  const hari = angka(batch.hari_netpot);
  if (!k || hari == null) return null;
  return ringkasKurva(k, Math.max(0, hari));
}

/** Satu titik kurva: hari ≥ capai → akhir; hari ≤ mulaiHari → mulaiPpm; di antaranya naik rata (tanpa lompatan). */
function ringkasKurva(k, h) {
  const sisa = Math.max(1, k.lama - k.mulaiHari);
  const perHari = (k.akhir - k.mulaiPpm) / sisa;
  const target = h >= k.lama ? k.akhir : h <= k.mulaiHari ? k.mulaiPpm : k.mulaiPpm + perHari * (h - k.mulaiHari);
  return {
    hari: h, per_hari: Math.round(perHari * 10) / 10, ppm_awal: k.awal, ppm_target: k.akhir, hari_capai: k.lama,
    diubah_hari: k.mulaiHari > 0 ? k.mulaiHari : null,
    target_hari_ini: Math.round(target), tercapai: h >= k.lama,
  };
}

/** Hari sejak Mulai Semai (hari pertama = 0): hari_semai (dari /tanam) atau umur_hari − 1 (dari batchPerMeja). */
function hariSemai(batch) {
  const langsung = angka(batch?.hari_semai);
  if (langsung != null) return Math.max(0, langsung);
  const umur = angka(batch?.umur_hari);
  return umur == null ? null : Math.max(0, umur - 1);
}

/**
 * Kurva "per hari" batch baru: hari pertama Mulai Semai = ppm awal, tiap hari naik rata sampai ppm akhir di hari
 * ke-`hari_capai` (dihitung sejak Mulai Semai), lalu ditahan sampai panen — di semua tahap, tanpa menunggu pindah netpot.
 */
function naikDariSemai(batch) {
  if (!batch) return null;
  const k = kurvaBatch(batch);
  const h = hariSemai(batch);
  if (!k || h == null) return null;
  return ringkasKurva(k, h);
}

/**
 * Target ppm & pH batch dari resep tanaman yang disalin ke batch (semais.kurva_*):
 *  - per tahap : ppm tetap per tahap (kurva_ppm_semai / _peremajaan / _pendewasaan)
 *  - per hari  : hari pertama Mulai Semai = ppm awal, lalu naik rata tiap hari (naikDariSemai)
 *  - batch lama (tanpa kurva_cara): rumus lama sejak pindah netpot (naikHarian), supaya target tidak melompat
 * null = batch tanpa resep → pemanggil memakai preset tahap.
 */
function targetBatch(batch) {
  if (!batch) return null;
  const ph = angka(batch.kurva_ph_min) != null && angka(batch.kurva_ph_max) != null
    ? { ph_min: angka(batch.kurva_ph_min), ph_max: angka(batch.kurva_ph_max) } : { ph_min: null, ph_max: null };
  if (batch.kurva_cara === 'tahap') {
    const ppm = angka({ Semai: batch.kurva_ppm_semai, Peremajaan: batch.kurva_ppm_peremajaan, Pendewasaan: batch.kurva_ppm_pendewasaan }[batch.tahap]);
    return ppm == null ? null : { ppm, ...ph, cara: 'tahap' };
  }
  if (batch.kurva_cara === 'harian') {
    const ppm = naikDariSemai(batch)?.target_hari_ini ?? null;
    return ppm == null ? null : { ppm, ...ph, cara: 'harian' };
  }
  const naik = naikHarian(batch); // batch lama (sebelum 19 Nov 2026): perilaku lama
  return naik ? { ppm: naik.target_hari_ini, ...ph, cara: 'harian' } : null;
}

/** Titik tengah rentang (atau satu-satunya batas yang diisi). */
function tengah(min, max, desimal) {
  const a = angka(min); const b = angka(max);
  const v = a != null && b != null ? (a + b) / 2 : (a ?? b);
  if (v == null) return null;
  const f = 10 ** desimal;
  return Math.round(v * f) / f;
}

async function presetAktif() {
  return q("SELECT * FROM target_nutrisi WHERE status = 'aktif'");
}

/**
 * Isi target penampung bermode 'otomatis' dari preset. Mengembalikan jumlah penampung yang berubah.
 * State dibuat untuk meja yang punya batch berjalan tetapi belum punya baris penampung_states.
 */
async function sinkronTarget() {
  const [batch, presets] = await Promise.all([batchPerMeja(), presetAktif()]);
  for (const idMeja of batch.keys()) {
    await q('INSERT INTO penampung_states (id_meja) VALUES ($1) ON CONFLICT (id_meja) DO NOTHING', [idMeja]);
  }
  const states = await q("SELECT id_meja, target_ec_ppm, target_ph, target_preset_id FROM penampung_states WHERE target_mode = 'otomatis'");
  let berubah = 0;
  for (const st of states) {
    const b = batch.get(String(st.id_meja));
    const p = pilihPreset(b, presets);
    const t = targetBatch(b);
    const ec = t ? t.ppm : p ? tengah(p.ec_min_ppm, p.ec_max_ppm, 0) : null;
    const ph = t?.ph_min != null ? tengah(t.ph_min, t.ph_max, 2) : p ? tengah(p.ph_min, p.ph_max, 2) : null;
    const pid = p ? Number(p.id) : null;
    if (angka(st.target_ec_ppm) === ec && angka(st.target_ph) === ph && angka(st.target_preset_id) === pid) continue;
    await q(
      `UPDATE penampung_states SET target_ec_ppm = $2, target_ph = $3, target_preset_id = $4,
              target_diperbarui = now(), updated_at = now() WHERE id_meja = $1 AND target_mode = 'otomatis'`,
      [st.id_meja, ec, ph, pid]);
    berubah += 1;
  }
  return berubah;
}

/** Sinkron tanpa menggagalkan pemanggil (dipakai setelah mulai/selesai tahap). */
function sinkronDiam() {
  sinkronTarget()
    // target baru (naik harian / kurva diubah) diteruskan ke alat bila alat sedang SEMAI (require malas: hindari siklus modul)
    .then(() => { const S = require('./sinkronAlat'); return S.diam(S.sinkronKeAlat); })
    .catch((e) => console.error('[preset-dosing] gagal sinkron:', e.message));
}

/** Ringkasan per meja untuk halaman Dosing: batch berjalan, preset terpilih, target & mode. */
async function ringkasTarget() {
  const [batch, presets, meja] = await Promise.all([batchPerMeja(), presetAktif(), q(`
    SELECT m.id_meja, m.meja, coalesce(ps.target_mode, 'otomatis') AS target_mode, ps.target_ec_ppm, ps.target_ph,
           ps.target_preset_id, ps.target_diperbarui, coalesce(ps.status_lock, false) AS status_lock, ps.lock_alasan,
           coalesce(ps.mode_pemeliharaan, false) AS mode_pemeliharaan
      FROM mejas m LEFT JOIN penampung_states ps ON ps.id_meja = m.id_meja ORDER BY m.meja`)]);
  return meja.map((m) => {
    const b = batch.get(String(m.id_meja)) || null;
    const p = pilihPreset(b, presets);
    const naik = naikHarian(b);
    const tb = targetBatch(b);
    const catatan = m.target_mode === 'manual' ? 'Target diatur manual oleh admin.'
      : !b ? 'Tidak ada batch berjalan — dosing otomatis diam.'
        : !p && !tb ? `Belum ada preset aktif untuk ${b.nama_tanaman || 'tanaman ini'} · ${b.tahap} (umur ${b.umur_hari} hari).`
          : null;
    return {
      ...m,
      batch: b && { tahap: b.tahap, id: b.id, id_tanaman: b.id_tanaman, nama_tanaman: b.nama_tanaman, umur_hari: Number(b.umur_hari),
        jumlah: b.jumlah, jumlah_batch: Number(b.jumlah_batch) },
      preset_cocok: p && { id: p.id, id_tanaman: p.id_tanaman, tahap: p.tahap, ec_min_ppm: p.ec_min_ppm, ec_max_ppm: p.ec_max_ppm,
        ph_min: p.ph_min, ph_max: p.ph_max, umur_min_hari: p.umur_min_hari, umur_max_hari: p.umur_max_hari },
      naik_harian: b?.kurva_cara === 'harian' ? naikDariSemai(b) : naik,
      target_batch: tb,
      catatan,
    };
  });
}

let timer = null;
function mulai() {
  sinkronDiam();
  timer = setInterval(sinkronDiam, 10 * 60_000);
  if (timer.unref) timer.unref();
}

module.exports = { TAHAP, pilihPreset, tengah, naikHarian, naikDariSemai, hariSemai, kurvaBatch, targetBatch, batchPerMeja, presetAktif, sinkronTarget, sinkronDiam, ringkasTarget, mulai };
