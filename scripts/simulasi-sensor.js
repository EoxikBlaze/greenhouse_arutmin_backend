#!/usr/bin/env node
'use strict';
/**
 * Simulator sensor untuk DEV LOKAL — menulis bacaan baru ke tiap meja "DEMO Meja %" setiap N detik,
 * supaya status IoT tetap "terhubung" dan tabel sensor per meja tidak basi saat menguji web/AI.
 *
 *   npm run sim:sensor                 # tiap 30 dtk sampai Ctrl+C
 *   node scripts/simulasi-sensor.js --detik 10 --sekali
 *
 * Langsung ke DB (bukan lewat API): endpoint perangkat menyimpan bacaan tanpa id_meja, jadi tabel
 * per meja DEMO tidak akan terisi. Hanya menyentuh meja DEMO dari database/seed_fake.sql —
 * jalankan seed itu dulu. Menolak jalan bila NODE_ENV=production.
 */
const { q, pool } = require('../src/db');

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : undefined; };
const DETIK = Math.max(5, Number(arg('detik')) || 30);
const SEKALI = process.argv.includes('--sekali');

if (process.env.NODE_ENV === 'production') {
  console.error('simulasi-sensor: menolak jalan di NODE_ENV=production.');
  process.exit(2);
}

const acak = (min, max) => min + Math.random() * (max - min);

async function kirim() {
  const mejas = await q("SELECT id_meja FROM mejas WHERE meja LIKE 'DEMO Meja%' ORDER BY id_meja");
  if (!mejas.length) throw new Error('Meja DEMO tidak ada — jalankan dulu: npm run db:seed-fake');
  const t = Date.now() / 60000; // menit — gelombang pelan agar grafik terlihat hidup
  await Promise.all(mejas.map(({ id_meja: id }, k) => {
    const tds = 900 + k * 25 + 120 * Math.sin(t / 55 + k) + acak(-20, 20);
    return q(
      `INSERT INTO monitorings ("waterTemp", ph, tds, "airTemp", humidity, id_meja, ec_ms_cm, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())`,
      [
        (25.5 + k * 0.3 + 2 * Math.sin(t / 40) + acak(-0.3, 0.3)).toFixed(1),
        (6.1 + k * 0.08 + 0.25 * Math.sin(t / 30 + k) + acak(-0.06, 0.06)).toFixed(2),
        Math.round(tds),
        (29 + k * 0.4 + 4 * Math.sin(t / 50) + acak(-0.4, 0.4)).toFixed(1),
        Math.round(68 - k * 2 + 10 * Math.sin(t / 45 + 1) + acak(-1, 1)),
        id,
        (tds / 500).toFixed(2),
      ],
    );
  }));
  console.log(`${new Date().toLocaleTimeString('id-ID')}  ${mejas.length} bacaan ditulis (meja DEMO)`);
}

(async () => {
  await kirim();
  if (SEKALI) return pool.end();
  const timer = setInterval(() => kirim().catch((e) => console.error('gagal:', e.message)), DETIK * 1000);
  const berhenti = () => { clearInterval(timer); pool.end().then(() => process.exit(0)); };
  process.on('SIGINT', berhenti);
  process.on('SIGTERM', berhenti);
})().catch((e) => { console.error(e.message); process.exit(1); });
