'use strict';
/**
 * KONTROL AIR (rancangan Fase 3B.3) — BELUM DIPASANG ke rute; /watercontrol/* tetap 503.
 *
 * Alur: permintaan (idempoten) → perintah ISI_AIR di antrean aktuator (pagar E-STOP, TTL, antrean) →
 *   menunggu → dikirim → selesai | gagal | kedaluwarsa.
 * Status fisik katup HANYA dari laporan perangkat yang sah; selain itu TIDAK_DIKETAHUI. Timeout ≠ sukses.
 * Syarat sebelum dipasang: pemetaan penampung ↔ katup terbukti (tabel pemetaan_katup, kini kosong), firmware v0.3
 * (cek exp, ISI_AIR per katup — v0.2 memakai satu output untuk semua penampung), dan UI yang mem-poll status.
 */
const { q, one } = require('./db');
const { buatPerintah, PerintahDitolak } = require('./aktuator');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Ringkas status untuk UI: status perintah ≠ status fisik. */
function ringkasStatus(p) {
  const fisik = p.status === 'selesai' && p.hasil && typeof p.hasil === 'object' && typeof p.hasil.katup === 'string'
    ? p.hasil.katup.toUpperCase() : 'TIDAK_DIKETAHUI';
  return {
    id_perintah: Number(p.id),
    aksi: p.parameter?.aksi ?? null,
    status_perintah: p.status,
    berhasil: p.status === 'selesai',
    status_fisik_katup: ['ON', 'OFF'].includes(fisik) ? fisik : 'TIDAK_DIKETAHUI',
    alasan: p.status === 'gagal' ? (p.hasil?.alasan ?? p.hasil?.error ?? 'tidak_dilaporkan') : null,
    kedaluwarsa_pada: p.kedaluwarsa_pada,
  };
}

/**
 * Minta isi/stop air untuk penampung yang SUDAH dipetakan. Idempoten per Idempotency-Key.
 * @returns {Promise<object>} ringkasStatus perintah (status awal 'menunggu', bukan 'berhasil')
 */
async function mintaKontrolAir({ idMeja, aksi, userId, idempotencyKey }) {
  if (!['MULAI', 'STOP'].includes(aksi)) throw new PerintahDitolak(422, 'Data tidak valid.', { aksi: ['aksi harus MULAI atau STOP.'] });
  if (!UUID.test(String(idempotencyKey || ''))) throw new PerintahDitolak(422, 'Data tidak valid.', { 'Idempotency-Key': ['wajib UUID.'] });
  const lama = await one('SELECT * FROM perintah_aktuator WHERE idempotency_key = $1', [idempotencyKey]);
  if (lama) return { ...ringkasStatus(lama), replay: true };
  const peta = await one('SELECT perangkat_kode, nomor_katup FROM pemetaan_katup WHERE id_meja = $1 AND aktif', [idMeja]);
  if (!peta) throw new PerintahDitolak(409, 'Penampung ini belum dipetakan ke katup perangkat; kontrol air ditolak.');
  try {
    const p = await buatPerintah({
      tipe: 'ISI_AIR', parameter: { penampung: Number(idMeja), katup: Number(peta.nomor_katup), aksi }, sumber: 'pengguna', userId,
      alasan: `kontrol air meja ${idMeja}`, ttlDetik: 60, perangkat: peta.perangkat_kode, idempotencyKey,
    });
    return { ...ringkasStatus(p), replay: false };
  } catch (e) {
    if (e.code === '23505') {
      const r = await one('SELECT * FROM perintah_aktuator WHERE idempotency_key = $1', [idempotencyKey]);
      if (r) return { ...ringkasStatus(r), replay: true };
    }
    throw e;
  }
}

async function statusKontrolAir(idPerintah) {
  const p = (await q("SELECT * FROM perintah_aktuator WHERE id = $1 AND tipe = 'ISI_AIR'", [idPerintah]))[0];
  return p ? ringkasStatus(p) : null;
}

module.exports = { mintaKontrolAir, statusKontrolAir, ringkasStatus };
