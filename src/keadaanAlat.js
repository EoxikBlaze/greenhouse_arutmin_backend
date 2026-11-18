'use strict';
/**
 * Keadaan alat (firmware v6) yang dipakai Dashboard dan penilai peringatan (src/peringatan.js).
 *
 * Kontrak MQTT v2.0 §2/§4: alat kirim `status` tiap 30 dtk (+ LWT saat putus) dan `data` tiap 5 dtk (HTTP: 15 dtk).
 * "online" = alat terhubung (perangkat.terakhir_terlihat, diisi status/data/heartbeat; ambang sama dgn halaman lain),
 * "data_segar" = bacaan sensor tersimpan baru-baru ini. Keduanya terpisah: alat bisa terhubung tetapi datanya ditolak.
 * shortcut: LWT {online:false} belum ditandai di DB, jadi "terputus" baru tampil ≤120 dtk kemudian; tambah kolom bila perlu seketika.
 */
const { q, one } = require('./db');

/** Alat terhubung bila status/data terakhir ≤ ini (status v6 tiap 30 dtk; sama dengan /aktuator & /kalibrasi). */
const ALAT_ONLINE_DETIK = 120;
/** Data sensor segar bila bacaan terakhir ≤ ini (data tiap 5 dtk lewat MQTT, 15 dtk lewat HTTP cadangan). */
const DATA_SEGAR_DETIK = 30;

const bool = (v) => (v === '1' ? true : v === '0' ? false : null);
const angka = (v) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * @param {object|null} latest baris monitorings terbaru (boleh null)
 * @returns {Promise<{iotStatus: object, keadaanAlat: object}>}
 */
async function bacaKeadaanAlat(latest) {
  const alat = await one(
    `SELECT kode, terakhir_terlihat, estop_aktif, extract(epoch FROM now() - terakhir_terlihat)::int AS umur
       FROM perangkat WHERE peran IN ('gabungan', 'aktuator') ORDER BY (peran = 'gabungan') DESC, kode LIMIT 1`);
  const v6Baris = await q("SELECT kunci, nilai FROM aktuator_state WHERE kunci LIKE 'v6\\_%'");
  const v6 = Object.fromEntries(v6Baris.map((r) => [r.kunci.slice(3), r.nilai]));
  const dilihat = latest ? latest.updated_at || latest.created_at : null;
  const dataUmur = dilihat ? Math.round((Date.now() - new Date(dilihat).getTime()) / 1000) : null;
  const iotStatus = {
    online: alat?.umur != null && alat.umur <= ALAT_ONLINE_DETIK,
    perangkat: alat?.kode ?? null,
    seconds_ago: alat?.umur ?? null,
    last_seen: alat?.terakhir_terlihat ?? null,
    diff_text: alat?.umur != null ? `${alat.umur} detik yang lalu` : 'Alat belum pernah tersambung',
    data_segar: dataUmur != null && dataUmur <= DATA_SEGAR_DETIK,
    data_seconds_ago: dataUmur,
    data_last_seen: dilihat,
  };
  const keadaanAlat = {
    level_air: v6.level_air ?? null, pompa_isi: bool(v6.pompa_isi), mode: v6.mode ?? null,
    kegiatan: v6.kegiatan ?? null, kunci: v6.kunci ?? null, siap: bool(v6.siap), kurang: v6.kurang || null,
    pemeliharaan: bool(v6.pemeliharaan), ppm_terlalu_rendah: bool(v6.ppm_terlalu_rendah),
    target_ppm: angka(v6.target_ppm), ph_min: angka(v6.ph_min), ph_max: angka(v6.ph_max), hari_semai: angka(v6.hari_semai),
    estop: alat?.estop_aktif ?? null,
    dosing_ab_hari: angka(v6.dosing_ab_hari), dosing_ph_hari: angka(v6.dosing_ph_hari),
    encer_hari: angka(v6.encer_hari), isi_hari: angka(v6.isi_hari),
  };
  return { iotStatus, keadaanAlat };
}

module.exports = { bacaKeadaanAlat, ALAT_ONLINE_DETIK, DATA_SEGAR_DETIK };
