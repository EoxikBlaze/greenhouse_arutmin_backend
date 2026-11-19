'use strict';
/**
 * Sinkron alur tanam web → alat (Perancangan v5.0 §2.2, Kontrak MQTT v2.0 §8.1):
 *   Mulai Semai di Kebun Saya → KONFIGURASI (Master Meja + uji lab + laju pompa) → SEMAI {target_ppm, ph_min, ph_max}
 *   target berubah (naik harian / per tahap / kurva diubah) → TARGET   (dicek tiap 10 menit, hanya bila alat SEMAI)
 *   tidak ada batch berjalan lagi di meja itu (panen/gagal) → PANEN
 * Alat = perangkat yang dipasang di meja batch (perangkat.id_meja, diatur di Master Data → Meja).
 * Target = resep batch (presetDosing.targetBatch) atau target penampung; pH = resep batch → preset → Ambang Sensor.
 * Tidak pernah mengirim DOSIS (keputusan K3): dosing diputuskan alat saat SEMAI.
 * shortcut: keadaan v6 (aktuator_state v6_*) masih satu untuk semua alat; bila alat > 1, simpan keadaan per perangkat.
 */
const { q, one } = require('./db');
const A = require('./aktuator');
const P = require('./presetDosing');
const { thresholdsMap } = require('./routes/monitoring');
const { bacaKeadaanAlat } = require('./keadaanAlat');
const { parameterKonfigurasi } = require('./konfigurasiAlat');

const angka = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** Alat yang terpasang di meja ({kode, nama} — nama untuk pesan ke petani), atau null. */
async function alatMeja(idMeja) {
  if (idMeja == null) return null;
  const a = await one(
    "SELECT kode, nama FROM perangkat WHERE id_meja = $1 AND peran IN ('gabungan', 'aktuator') AND aktif ORDER BY kode LIMIT 1", [idMeja]);
  return a ? { kode: a.kode, nama: a.nama || a.kode } : null;
}
const alatDiMeja = async (idMeja) => (await alatMeja(idMeja))?.kode ?? null;

async function mejaBatchTerbaru() {
  const batch = await P.batchPerMeja();
  const terbaru = [...batch.values()].sort((a, b) => new Date(b.mulai) - new Date(a.mulai) || Number(b.id) - Number(a.id))[0];
  return terbaru?.id_meja ?? null;
}

/** Target untuk alat di meja itu (batch terbaru di meja), atau null bila belum bisa dihitung. */
async function targetUntukMeja(idMeja) {
  const [batch, presets, ambang] = await Promise.all([P.batchPerMeja(), P.presetAktif(), thresholdsMap()]);
  const b = batch.get(String(idMeja));
  if (!b) return null;
  const st = await one('SELECT target_ec_ppm FROM penampung_states WHERE id_meja = $1', [idMeja]);
  const resep = P.targetBatch(b);
  const p = P.pilihPreset(b, presets);
  let phMin = resep?.ph_min ?? angka(p?.ph_min);
  let phMax = resep?.ph_max ?? angka(p?.ph_max);
  if (!(phMin < phMax)) { phMin = angka(ambang?.ph?.min); phMax = angka(ambang?.ph?.max); }
  const ppm = angka(st?.target_ec_ppm) ?? resep?.ppm ?? null;
  if (ppm == null || !(phMin < phMax)) return null;
  // rentang yang diterima firmware: target 50–3000 ppm, pH 4,0–8,5 (Kontrak §6.2)
  return { target_ppm: Math.min(3000, Math.max(50, Math.round(ppm))), ph_min: Math.max(4, phMin), ph_max: Math.min(8.5, phMax) };
}

async function adaPerintahTertunda(kode, tipe) {
  return Boolean(await one(
    "SELECT 1 AS x FROM perintah_aktuator WHERE perangkat_kode = $1 AND tipe = ANY($2::text[]) AND status IN ('menunggu','dikirim') LIMIT 1",
    [kode, tipe]));
}

/**
 * Mulai Semai: KONFIGURASI lalu SEMAI ke alat di meja. Keduanya diantre berurutan; bila konfigurasi belum
 * lengkap (mis. kalibrasi pH), alat menolak SEMAI dengan `belum_siap_<apa>` dan web menampilkan kekurangannya.
 * @returns {Promise<{dikirim: boolean, ket: string, kurang?: string[]}>}
 */
async function mulaiSemaiAlat(idMeja, userId = null) {
  const alat = await alatMeja(idMeja);
  if (!alat) return { dikirim: false, ket: 'Meja ini belum dipasangi alat (Master Data → Meja Tanaman → Alat terpasang).' };
  const { kode } = alat;
  const t = await targetUntukMeja(idMeja);
  if (!t) return { dikirim: false, ket: 'Belum ada target nutrisi / rentang pH (isi resep di Master Data → Jenis Tanaman).' };
  if (await adaPerintahTertunda(kode, ['KONFIGURASI', 'SEMAI'])) return { dikirim: false, ket: 'Perintah sebelumnya masih menunggu alat.' };
  const sumber = userId ? 'pengguna' : 'otomasi';
  const { parameter, kurang } = await parameterKonfigurasi(idMeja);
  await A.buatPerintah({
    tipe: 'KONFIGURASI', parameter, sumber, userId, perangkat: kode, ttlDetik: 600,
    alasan: 'Konfigurasi meja sebelum mulai semai',
  });
  await A.buatPerintah({
    tipe: 'SEMAI', parameter: { target_ppm: t.target_ppm, ph_min: t.ph_min, ph_max: t.ph_max },
    sumber, userId, perangkat: kode, ttlDetik: 600, alasan: 'Mulai semai dari Kebun Saya',
  });
  const ket = `konfigurasi meja + mulai semai ${t.target_ppm} ppm · pH ${t.ph_min}–${t.ph_max} dikirim ke ${alat.nama}, menunggu jawaban alat`
    + (kurang.length ? ` (belum ada di web: ${kurang.join(', ')}; alat memakai nilai tersimpannya)` : '');
  return { dikirim: true, ket, kurang };
}

/** Penjadwal (tiap 10 menit): kirim TARGET ke alat yang sedang SEMAI bila target batch di mejanya berubah. */
async function sinkronKeAlat() {
  const alat = await q("SELECT kode, id_meja FROM perangkat WHERE id_meja IS NOT NULL AND peran IN ('gabungan', 'aktuator') AND aktif");
  const hasil = [];
  for (const { kode, id_meja: idMeja } of alat) {
    const { keadaanAlat: a } = await bacaKeadaanAlat(null);
    if (a.mode !== 'SEMAI') continue;
    const t = await targetUntukMeja(idMeja);
    if (!t) continue;
    const sama = angka(a.target_ppm) === t.target_ppm && angka(a.ph_min) === t.ph_min && angka(a.ph_max) === t.ph_max;
    if (sama || await adaPerintahTertunda(kode, ['TARGET', 'SEMAI'])) continue;
    const p = await A.buatPerintah({
      tipe: 'TARGET', parameter: t, sumber: 'otomasi', perangkat: kode, ttlDetik: 600, alasan: 'Target nutrisi harian dari resep batch',
    });
    hasil.push({ kode, id: String(p.id), tipe: 'TARGET', ket: `TARGET ${t.target_ppm} ppm dikirim ke ${kode}` });
  }
  return hasil;
}

/** Batch terakhir di meja selesai (panen / gagal) dan alat masih SEMAI → PANEN: dosing & isi otomatis berhenti. */
async function panenBilaKosong(idMeja, userId = null) {
  const kode = await alatDiMeja(idMeja);
  if (!kode) return { dikirim: false, ket: 'Meja tanpa alat.' };
  const batch = await P.batchPerMeja();
  if (batch.has(String(idMeja))) return { dikirim: false, ket: 'Masih ada batch berjalan di meja ini.' };
  const { keadaanAlat: a } = await bacaKeadaanAlat(null);
  if (a.mode !== 'SEMAI' || await adaPerintahTertunda(kode, ['PANEN'])) return { dikirim: false, ket: 'Alat tidak sedang SEMAI.' };
  const p = await A.buatPerintah({
    tipe: 'PANEN', parameter: {}, sumber: userId ? 'pengguna' : 'otomasi', userId, perangkat: kode,
    alasan: 'Semua batch di meja ini selesai', ttlDetik: 600,
  });
  return { dikirim: true, tipe: 'PANEN', id: String(p.id), ket: `PANEN dikirim ke ${kode}` };
}

/** Jalankan tanpa menggagalkan pemanggil (dipakai penjadwal & setelah aksi tanam). */
function diam(fn, ...arg) {
  return fn(...arg).catch((e) => {
    console.error('[SINKRON ALAT] gagal:', e.message);
    return { dikirim: false, ket: `Gagal mengirim ke alat (${e.message})` };
  });
}

module.exports = { alatDiMeja, alatMeja, mejaBatchTerbaru, targetUntukMeja, mulaiSemaiAlat, sinkronKeAlat, panenBilaKosong, diam };
