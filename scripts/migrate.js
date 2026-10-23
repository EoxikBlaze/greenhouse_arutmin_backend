#!/usr/bin/env node
'use strict';
/**
 * Pelari migrasi SQL sederhana (tanpa dependensi baru).
 *
 *   npm run migrate            → jalankan file di database/migrations yang belum tercatat
 *   npm run migrate:status     → daftar file + status
 *   node scripts/migrate.js --baseline
 *                              → tandai SEMUA file sebagai sudah jalan TANPA menjalankannya
 *                                (untuk database lama yang sudah berisi skema terbaru)
 *
 * Catatan:
 *  - Urutan = nama file (awali dengan tanggal: YYYY-MM-DD_NN_judul.sql).
 *  - Riwayat disimpan di tabel schema_migrations (versi, checksum, dijalankan_pada).
 *  - File yang sudah jalan lalu ISINYA DIUBAH → ditolak (buat file migrasi baru saja).
 *  - Tiap file boleh punya BEGIN/COMMIT sendiri; file tanpa transaksi dijalankan apa adanya.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');
require('../src/config'); // memuat .env ke process.env

const DIR = path.join(__dirname, '..', 'database', 'migrations');
const arg = process.argv[2] || '';

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL belum diisi di .env');
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      versi varchar(200) PRIMARY KEY,
      checksum char(64) NOT NULL,
      dijalankan_pada timestamp(0) without time zone NOT NULL DEFAULT now()
    )`);
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
    const sudah = new Map((await c.query('SELECT versi, checksum FROM schema_migrations')).rows
      .map((r) => [r.versi, r.checksum]));

    let jalan = 0;
    for (const f of files) {
      const sql = fs.readFileSync(path.join(DIR, f), 'utf8');
      const sum = crypto.createHash('sha256').update(sql).digest('hex');
      const lama = sudah.get(f);

      if (arg === '--status') {
        const st = !lama ? 'BELUM' : lama === sum ? 'sudah' : 'BERUBAH!';
        console.log(`${st.padEnd(9)} ${f}`);
        continue;
      }
      if (lama) {
        if (lama !== sum) {
          throw new Error(`${f} sudah dijalankan tetapi isinya berubah. Jangan ubah migrasi lama — buat file baru.`);
        }
        continue;
      }
      if (arg !== '--baseline') {
        process.stdout.write(`→ ${f} … `);
        try {
          await c.query(sql);
        } catch (e) {
          await c.query('ROLLBACK').catch(() => {});
          console.log('GAGAL');
          throw new Error(`${f}: ${e.message}`);
        }
        console.log('ok');
      }
      await c.query('INSERT INTO schema_migrations (versi, checksum) VALUES ($1, $2)', [f, sum]);
      jalan += 1;
    }
    if (arg === '--baseline') console.log(`${jalan} migrasi ditandai sudah jalan (baseline).`);
    else if (arg !== '--status') console.log(jalan ? `${jalan} migrasi dijalankan.` : 'Database sudah terbaru.');
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(`Migrasi gagal: ${e.message}`);
  process.exit(1);
});
