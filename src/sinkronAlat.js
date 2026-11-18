'use strict';
/**
 * Sinkron alur tanam web → alat (Perancangan v5.0 §2.2, Kontrak MQTT v2.0 §8.1):
 *   Mulai Semai di Kebun Saya → SEMAI {target_ppm, ph_min, ph_max}
 *   target berubah (naik harian / kurva diubah) → TARGET   (dicek tiap 10 menit, hanya bila alat sedang SEMAI)
 *   tidak ada batch berjalan lagi (panen/gagal) → PANEN
 * Target = target penampung hasil presetDosing.sinkronTarget (batch terbaru); pH = preset tahap, cadangan Ambang Sensor.
 * Tidak pernah mengirim DOSIS (keputusan K3): dosing diputuskan alat saat SEMAI.
 */
const { one } = require('./db');
const A = require('./aktuator');
const P = require('./presetDosing');
const { thresholdsMap } = require('./routes/monitoring');
const { bacaKeadaanAlat } = require('./keadaanAlat');

const angka = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** Target untuk alat dari batch terbaru, atau null bila tidak ada batch / target belum bisa dihitung. */
async function targetUntukAlat() {
  const [batch, presets, ambang] = await Promise.all([P.batchPerMeja(), P.presetAktif(), thresholdsMap()]);
  const terbaru = [...batch.values()].sort((a, b) => new Date(b.mulai) - new Date(a.mulai) || Number(b.id) - Number(a.id))[0];
  if (!terbaru) return null;
  const st = await one('SELECT target_ec_ppm FROM penampung_states WHERE id_meja = $1', [terbaru.id_meja]);
  const p = P.pilihPreset(terbaru, presets);
  let phMin = angka(p?.ph_min);
  let phMax = angka(p?.ph_max);
  if (!(phMin < phMax)) { phMin = angka(ambang?.ph?.min); phMax = angka(ambang?.ph?.max); }
  const ppm = angka(st?.target_ec_ppm) ?? P.naikHarian(terbaru)?.target_hari_ini ?? P.kurvaBatch(terbaru)?.awal ?? null;
  if (ppm == null || !(phMin < phMax)) return null;
  // rentang yang diterima firmware: target 50–3000 ppm, pH 4,0–8,5 (Kontrak §6.2)
  return {
    target_ppm: Math.min(3000, Math.max(50, Math.round(ppm))),
    ph_min: Math.max(4, phMin), ph_max: Math.min(8.5, phMax), id_meja: terbaru.id_meja,
  };
}

async function adaPerintahTertunda(tipe) {
  return Boolean(await one(
    "SELECT 1 AS x FROM perintah_aktuator WHERE tipe = ANY($1::text[]) AND status IN ('menunggu','dikirim') LIMIT 1", [tipe]));
}

/**
 * Kirim SEMAI (bila diminta pengguna dan alat belum SEMAI) atau TARGET (bila alat SEMAI dan targetnya beda).
 * @param {{mulaiSemai?: boolean, userId?: number|null}} opsi
 * @returns {Promise<{dikirim: boolean, tipe?: string, id?: string, ket: string}>}
 */
async function sinkronKeAlat({ mulaiSemai = false, userId = null } = {}) {
  const t = await targetUntukAlat();
  if (!t) return { dikirim: false, ket: 'Belum ada target nutrisi (kurva tanaman / preset belum diatur).' };
  const { keadaanAlat: a } = await bacaKeadaanAlat(null);
  const sumber = userId ? 'pengguna' : 'otomasi';
  if (a.mode !== 'SEMAI') {
    if (!mulaiSemai) return { dikirim: false, ket: 'Alat belum mode SEMAI.' };
    if (await adaPerintahTertunda(['SEMAI'])) return { dikirim: false, ket: 'Perintah SEMAI sebelumnya masih menunggu alat.' };
    const p = await A.buatPerintah({
      tipe: 'SEMAI', parameter: { target_ppm: t.target_ppm, ph_min: t.ph_min, ph_max: t.ph_max },
      sumber, userId, alasan: 'Mulai semai dari Kebun Saya', ttlDetik: 600,
    });
    return { dikirim: true, tipe: 'SEMAI', id: String(p.id), ket: `SEMAI ${t.target_ppm} ppm · pH ${t.ph_min}–${t.ph_max} dikirim, menunggu alat` };
  }
  const sama = angka(a.target_ppm) === t.target_ppm && angka(a.ph_min) === t.ph_min && angka(a.ph_max) === t.ph_max;
  if (sama) return { dikirim: false, ket: 'Target di alat sudah sesuai.' };
  if (await adaPerintahTertunda(['TARGET', 'SEMAI'])) return { dikirim: false, ket: 'Perintah target sebelumnya masih menunggu alat.' };
  const p = await A.buatPerintah({
    tipe: 'TARGET', parameter: { target_ppm: t.target_ppm, ph_min: t.ph_min, ph_max: t.ph_max },
    sumber, userId, alasan: 'Target nutrisi harian dari kurva batch', ttlDetik: 600,
  });
  return { dikirim: true, tipe: 'TARGET', id: String(p.id), ket: `TARGET ${t.target_ppm} ppm dikirim, menunggu alat` };
}

/** Semua batch selesai (panen / gagal) dan alat masih SEMAI → PANEN: dosing & isi otomatis alat berhenti. */
async function panenBilaKosong(userId = null) {
  const batch = await P.batchPerMeja();
  if (batch.size > 0) return { dikirim: false, ket: 'Masih ada batch berjalan.' };
  const { keadaanAlat: a } = await bacaKeadaanAlat(null);
  if (a.mode !== 'SEMAI' || await adaPerintahTertunda(['PANEN'])) return { dikirim: false, ket: 'Alat tidak sedang SEMAI.' };
  const p = await A.buatPerintah({
    tipe: 'PANEN', parameter: {}, sumber: userId ? 'pengguna' : 'otomasi', userId,
    alasan: 'Semua batch di Kebun Saya selesai', ttlDetik: 600,
  });
  return { dikirim: true, tipe: 'PANEN', id: String(p.id), ket: 'PANEN dikirim ke alat' };
}

/** Jalankan tanpa menggagalkan pemanggil (dipakai penjadwal & setelah aksi tanam). */
function diam(fn, ...arg) {
  return fn(...arg).catch((e) => {
    console.error('[SINKRON ALAT] gagal:', e.message);
    return { dikirim: false, ket: `Gagal mengirim ke alat (${e.message})` };
  });
}

module.exports = { targetUntukAlat, sinkronKeAlat, panenBilaKosong, diam };
