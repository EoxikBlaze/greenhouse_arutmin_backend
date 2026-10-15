'use strict';
/**
 * Notifikasi WhatsApp (Fonnte) — pengaturan + kirim uji + daftar tipe pesan.
 * api_key disimpan TER-ENKRIPSI (AES-256 kompatibel Laravel) dan tidak pernah
 * dikirim balik ke client (hanya versi tersamar).
 */
const express = require('express');
const { q, one } = require('../db');
const { encrypt, decrypt } = require('../crypto');
const { demoGuard, json } = require('../auth');

const router = express.Router();

function masked(key) {
  if (!key) return null;
  return key.slice(0, 6) + '***';
}

async function setting() {
  const row = await one('SELECT * FROM wa_settings ORDER BY id LIMIT 1')
    || await one("INSERT INTO wa_settings (id, aktif, api_key, target, updated_at) VALUES (1, false, NULL, NULL, now()) RETURNING *");
  return row;
}

/** Kirim pesan WA via Fonnte (best-effort — tidak pernah menggagalkan request). */
async function kirimWa(target, pesan) {
  try {
    const row = await setting();
    const key = decrypt(row.api_key);
    if (!row.aktif || !key || !target) return { terkirim: false, alasan: 'belum dikonfigurasi' };
    const res = await fetch('https://api.fonnte.com/send', {
      method: 'POST',
      headers: { Authorization: key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ target, message: pesan }),
      signal: AbortSignal.timeout(6000),
    });
    return { terkirim: res.ok, status: res.status };
  } catch (e) {
    return { terkirim: false, alasan: 'gagal kirim' };
  }
}

router.get('/', async (_req, res, next) => {
  try {
    const row = await setting();
    res.json({
      page: 'notifikasi-wa',
      aktif: !!row.aktif,
      api_key_masked: masked(decrypt(row.api_key)),
      target: row.target,
      tipe_pesan: [
        { tipe: 'solenoid', pemicu: 'Katup ON/OFF', konten: 'Solenoid ON (manual)' },
        { tipe: 'water_level', pemicu: 'Tandon Penuh/Kosong', konten: 'Tandon sudah penuh' },
        { tipe: 'jadwal', pemicu: 'H-1 pemindahan meja', konten: 'Besok pindah meja' },
      ],
    });
  } catch (e) { next(e); }
});

router.post('/', demoGuard('notifikasi-wa.update'), async (req, res, next) => {
  try {
    const { aktif = false, api_key = '', target = '' } = req.body || {};
    await q(
      `UPDATE wa_settings SET aktif = $1, api_key = $2, target = $3, updated_at = now() WHERE id = 1`,
      [!!aktif, api_key ? encrypt(String(api_key)) : null, target || null],
    );
    res.json({ status: true, message: 'Pengaturan tersimpan.' });
  } catch (e) { next(e); }
});

router.post('/uji', demoGuard('notifikasi-wa.uji'), async (req, res, next) => {
  try {
    const row = await setting();
    const targets = String(row.target || '').split(',').map((s) => s.trim()).filter(Boolean);
    const hasil = await kirimWa(targets[0], '[UJI] Vertonik Smart Farm — pesan uji notifikasi WhatsApp.');
    res.json({
      status: hasil.terkirim,
      message: hasil.terkirim ? 'Pesan uji terkirim — cek WhatsApp di nomor tujuan.' : 'Pesan uji gagal / belum dikonfigurasi.',
      log: { waktu: new Date().toISOString(), tipe: 'uji', target: targets[0] ?? null, hasil },
    });
  } catch (e) { next(e); }
});

module.exports = router;
