'use strict';
/**
 * OTOMASI DOSING (opsional, DEFAULT MATI) — aturan deterministik, bukan AI.
 *
 * Mengapa bukan AI? Model bahasa lokal (Ollama) bagus untuk MENJELASKAN & MENYARANKAN
 * (lihat routes/ai.js), tetapi tidak boleh memegang pompa: ia bisa salah, bisa dimanipulasi
 * lewat teks, dan tidak deterministik. Di sini keputusan dihitung dari rumus & pagar yang
 * tertulis di `konfigurasi_dosis`; setiap perintah tetap melewati pagar src/aktuator.js
 * (batas per suntikan, batas harian, LOCK penampung, E-STOP).
 *
 * Mengaktifkan (di .env), SEMUA wajib:
 *   OTOMASI=1                    → nyalakan pengendali
 *   OTOMASI_PENAMPUNG=<id_meja>  → penampung yang dikendalikan
 * dan penampung itu harus punya target_ec_ppm / target_ph di tabel penampung_states
 * (nilai target menunggu kesepakatan tim — bila NULL, otomasi tidak berbuat apa-apa).
 */
const { q, one } = require('./db');
const { bacaKonfig, buatPerintah, PerintahDitolak } = require('./aktuator');

const SENSOR_BASI_DETIK = 120;

/**
 * Rentang fisik wajar (Perancangan FINAL §4.1 & §9 "Sanity check sensor"): di luar ini = probe lepas /
 * kabel putus → bacaan DIBUANG, jangan pernah mendosis darinya. EC 0,1–5 mS/cm × 500 = 50–2.500 ppm.
 */
const SANITY = { ph: [3, 9], tds: [50, 2500], suhuAir: [5, 45] };

/** Bacaan mustahil → teks sebab; wajar → null. Nilai yang tidak dikirim (null) tidak diperiksa. */
function bacaanMustahil({ ph, tds, suhuAir }) {
  const luar = (v, [min, max]) => v != null && (!Number.isFinite(v) || v < min || v > max);
  if (luar(ph, SANITY.ph)) return `pH ${ph} di luar rentang wajar ${SANITY.ph.join('–')}`;
  if (luar(tds, SANITY.tds)) return `TDS ${tds} ppm di luar rentang wajar ${SANITY.tds.join('–')} ppm`;
  if (luar(suhuAir, SANITY.suhuAir)) return `suhu air ${suhuAir} °C di luar rentang wajar ${SANITY.suhuAir.join('–')} °C`;
  return null;
}

/**
 * Keputusan murni (tanpa DB) → perintah DOSIS atau null.
 * @param {{ph:number|null, tds:number|null, waterTemp?:number|null, umurDetik:number}} sensor
 * @param {{target_ec_ppm:number|null, target_ph:number|null}} target
 * @param {Record<string,number>} cfg konfigurasi_dosis
 * @param {number} penampung
 */
function putuskan(sensor, target, cfg, penampung) {
  if (!sensor || sensor.umurDetik == null || sensor.umurDetik > SENSOR_BASI_DETIK) return { aksi: null, sebab: 'sensor basi/tidak ada' };
  const angka = (v) => (v == null ? null : Number(v));
  const ph = angka(sensor.ph);
  const tds = angka(sensor.tds);
  // bacaan mustahil = sensor rusak/lepas → buang, jangan dosis (mis. probe EC lepas terbaca ~0 ppm)
  const mustahil = bacaanMustahil({ ph, tds, suhuAir: angka(sensor.waterTemp) });
  if (mustahil) return { aksi: null, sebab: `bacaan dibuang: ${mustahil}` };

  const tEc = target.target_ec_ppm == null ? null : Number(target.target_ec_ppm);
  const tPh = target.target_ph == null ? null : Number(target.target_ph);

  // 1) EC/TDS di bawah target → dosis AB (65% kekurangan, maks 300 ppm per suntikan)
  if (tEc != null && tds != null) {
    const dbEc = cfg.deadband_ec_ppm ?? 100;
    if (tds < tEc - dbEc) {
      const kekurangan = tEc - tds;
      const ppm = Math.min(kekurangan * ((cfg.persen_ronde_dosis ?? 65) / 100), cfg.maks_ppm_per_suntikan ?? 300);
      const mlPerPpm = (cfg.maks_ml_per_suntikan ?? 214) / (cfg.maks_ppm_per_suntikan ?? 300);
      const ml = Math.min(Math.round(ppm * mlPerPpm * 10) / 10, cfg.maks_ml_per_suntikan ?? 214);
      if (ml >= 1) {
        return { aksi: { tipe: 'DOSIS', parameter: { penampung, larutan: 'AB', ml }, alasan: `TDS ${tds} < target ${tEc} (±${dbEc})` } };
      }
    }
  }
  // 2) pH di luar pita mati → satu langkah kecil
  if (tPh != null && ph != null) {
    const dbPh = cfg.deadband_ph ?? 0.2;
    const langkah = cfg.ml_ph_per_langkah ?? 5;
    if (ph > tPh + dbPh) return { aksi: { tipe: 'DOSIS', parameter: { penampung, larutan: 'PH_DOWN', ml: langkah }, alasan: `pH ${ph} > target ${tPh} (±${dbPh})` } };
    if (ph < tPh - dbPh) return { aksi: { tipe: 'DOSIS', parameter: { penampung, larutan: 'PH_UP', ml: langkah }, alasan: `pH ${ph} < target ${tPh} (±${dbPh})` } };
  }
  return { aksi: null, sebab: 'dalam pita target' };
}

/**
 * Bacaan terbaru MILIK penampung ini (monitorings.id_meja). Bacaan meja lain atau tanpa id_meja
 * (firmware lama / rute lama) tidak pernah dipakai untuk mendosis. null bila belum ada.
 * created_at hanya presisi detik → `id DESC` memecah seri.
 */
async function bacaanTerakhir(penampung) {
  const m = await one(
    'SELECT ph, tds, "waterTemp", created_at FROM monitorings WHERE id_meja = $1 ORDER BY created_at DESC, id DESC LIMIT 1',
    [penampung]);
  if (!m) return null;
  return {
    ph: m.ph, tds: m.tds, waterTemp: m.waterTemp,
    umurDetik: Math.round((Date.now() - new Date(m.created_at).getTime()) / 1000),
  };
}

/** Satu siklus: baca data → putuskan → antre lewat pagar. Mengembalikan ringkasan (untuk uji/log). */
async function siklus(penampung) {
  const target = await one('SELECT target_ec_ppm, target_ph, status_lock FROM penampung_states WHERE id_meja = $1', [penampung]);
  if (!target) return { aksi: null, sebab: 'penampung belum punya state/target' };
  if (target.status_lock) return { aksi: null, sebab: 'penampung terkunci' };

  const aktif = await one(
    `SELECT 1 AS x FROM perintah_aktuator
      WHERE perangkat_kode = 'aktuator-01' AND status IN ('menunggu','dikirim') AND tipe IN ('DOSIS','BILAS','SAMPLING','ISI_AIR') LIMIT 1`);
  if (aktif) return { aksi: null, sebab: 'masih ada perintah berjalan' };

  const cfg = await bacaKonfig();
  const jeda = (await one("SELECT nilai FROM timing_operasi WHERE param = 'mixing_menit'"))?.nilai;
  const terakhir = await one(
    `SELECT dibuat_pada FROM perintah_aktuator
      WHERE tipe = 'DOSIS' AND (parameter->>'penampung')::bigint = $1 AND status IN ('dikirim','selesai')
      ORDER BY id DESC LIMIT 1`, [penampung]);
  if (terakhir && Date.now() - new Date(terakhir.dibuat_pada).getTime() < Number(jeda ?? 15) * 60_000) {
    return { aksi: null, sebab: 'menunggu pencampuran (mixing)' };
  }

  const sensor = await bacaanTerakhir(penampung);
  if (!sensor) return { aksi: null, sebab: 'belum ada bacaan untuk penampung ini' };
  const { aksi, sebab } = putuskan(sensor, target, cfg, penampung);
  if (!aksi) return { aksi: null, sebab };
  try {
    const p = await buatPerintah({ ...aksi, sumber: 'otomasi', ttlDetik: 120 });
    return { aksi, perintah: p.id };
  } catch (e) {
    if (e instanceof PerintahDitolak) return { aksi: null, sebab: `ditolak pagar: ${e.message}` };
    throw e;
  }
}

let timer = null;
function mulai() {
  if (process.env.OTOMASI !== '1') return false;
  const penampung = Number(process.env.OTOMASI_PENAMPUNG);
  if (!Number.isInteger(penampung) || penampung < 1) {
    console.warn('[OTOMASI] OTOMASI=1 tetapi OTOMASI_PENAMPUNG tidak valid — otomasi TIDAK dijalankan.');
    return false;
  }
  const detik = Math.max(30, Number(process.env.OTOMASI_INTERVAL_DETIK) || 60);
  console.log(`OTOMASI dosing     : AKTIF untuk penampung ${penampung} (cek tiap ${detik} dtk)`);
  timer = setInterval(() => {
    siklus(penampung).then((r) => { if (r.aksi) console.log('[OTOMASI]', r.aksi.alasan, '→ perintah', r.perintah); })
      .catch((e) => console.error('[OTOMASI] galat:', e.message));
  }, detik * 1000);
  if (timer.unref) timer.unref();
  return true;
}
function henti() { if (timer) clearInterval(timer); timer = null; }

module.exports = { SANITY, bacaanMustahil, putuskan, bacaanTerakhir, siklus, mulai, henti };
