'use strict';
/**
 * Isi perintah KONFIGURASI (Kontrak MQTT v2.0 §6.2 & §6.4) dari Master Meja + hasil uji lab & kalibrasi laju pompa.
 * Dikirim saat Mulai Semai sebelum SEMAI, supaya alat langsung berstatus siap (Firmware v6 §4.1).
 * Nilai yang belum pernah diisi di web TIDAK dikirim: alat memakai nilai yang sudah tersimpan di flash-nya.
 */
const { q, one } = require('./db');
const { hitungSirkulasi } = require('./iotV41');

/** Rentang yang diterima firmware (Kontrak §6.4); satu nilai di luar rentang = seluruh KONFIGURASI ditolak alat. */
const RENTANG = {
  volume_l: [5, 5000], monitoring_menit: [5, 720], jeda_ab_dtk: [10, 900], ppm_per_ml_ab: [1, 3000],
  laju_a: [0.05, 50], laju_b: [0.05, 50], laju_ph_up: [0.05, 50], laju_ph_down: [0.05, 50],
};
/** konfigurasi_dosis.param (diisi menu Kalibrasi / Uji Lab) → nama parameter firmware. */
const DARI_KALIBRASI = {
  ppm_per_ml: 'ppm_per_ml_ab', laju_pompa_a_mls: 'laju_a', laju_pompa_b_mls: 'laju_b',
  laju_pompa_ph_up_mls: 'laju_ph_up', laju_pompa_ph_down_mls: 'laju_ph_down',
};

/** Nama untuk petani (pesan Mulai Semai). */
const LABEL = {
  volume_l: 'volume penampung (Master Meja)', monitoring_menit: 'waktu monitoring (Master Meja)', jeda_ab_dtk: 'jeda A→B (Master Meja)',
  ppm_per_ml_ab: 'uji lab nutrisi AB (Kalibrasi)', laju_a: 'laju pompa A (Kalibrasi)', laju_b: 'laju pompa B (Kalibrasi)',
  laju_ph_up: 'laju pompa pH up (Kalibrasi)', laju_ph_down: 'laju pompa pH down (Kalibrasi)',
};

const angka = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * Volume, waktu monitoring, dan jeda A→B satu meja. Monitoring/jeda kosong di master = dihitung dari
 * satu putaran larutan: volume ÷ (jumlah talang × laju per talang) (src/iotV41.js hitungSirkulasi).
 */
function konfigurasiMeja(m) {
  const volume = angka(m?.kapasitas_penampung_l);
  const s = hitungSirkulasi({ volume_l: volume ?? 0, talang_jumlah: m?.jumlah_talang ?? 0, talang_debit: m?.laju_per_talang_lpm ?? 0 });
  const adaPutaran = s.putaran_menit > 0;
  const monitoring = angka(m?.monitoring_menit) ?? (adaPutaran ? s.saran_monitoring_menit : null);
  const jeda = angka(m?.jeda_ab_dtk) ?? (adaPutaran ? s.saran_jeda_ab_menit * 60 : null);
  return {
    volume_l: volume == null ? null : Math.round(volume),
    putaran_menit: adaPutaran ? s.putaran_menit : null,
    monitoring_menit: monitoring, monitoring_otomatis: angka(m?.monitoring_menit) == null,
    jeda_ab_dtk: jeda, jeda_otomatis: angka(m?.jeda_ab_dtk) == null,
  };
}

/**
 * Parameter KONFIGURASI untuk meja. `kurang` = nilai yang belum bisa diisi dari web (dipakai pesan ke petani).
 * @returns {Promise<{parameter: Record<string, number>, kurang: string[]}>}
 */
async function parameterKonfigurasi(idMeja) {
  const meja = await one('SELECT * FROM mejas WHERE id_meja = $1', [idMeja]);
  const k = konfigurasiMeja(meja);
  const kal = await q('SELECT param, nilai FROM konfigurasi_dosis WHERE param = ANY($1::text[])', [Object.keys(DARI_KALIBRASI)]);
  const nilai = { volume_l: k.volume_l, monitoring_menit: k.monitoring_menit, jeda_ab_dtk: k.jeda_ab_dtk };
  for (const r of kal) if (angka(r.nilai) != null) nilai[DARI_KALIBRASI[r.param]] = angka(r.nilai);
  const parameter = { id_meja: Number(idMeja) };
  const kurang = [];
  for (const [kunci, [min, max]] of Object.entries(RENTANG)) {
    const v = nilai[kunci];
    if (v == null) { kurang.push(LABEL[kunci]); continue; }
    if (v < min || v > max) { kurang.push(`${LABEL[kunci]}: ${v} di luar ${min}–${max}`); continue; }
    parameter[kunci] = kunci === 'volume_l' || kunci.endsWith('_menit') || kunci.endsWith('_dtk') ? Math.round(v) : v;
  }
  return { parameter, kurang };
}

module.exports = { konfigurasiMeja, parameterKonfigurasi, RENTANG };
