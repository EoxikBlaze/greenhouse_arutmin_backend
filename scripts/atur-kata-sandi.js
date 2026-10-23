#!/usr/bin/env node
'use strict';
/**
 * Atur kata sandi akun aplikasi (bcrypt cost 12).
 *
 *   node scripts/atur-kata-sandi.js --semua-acak        # SEMUA akun → sandi acak kuat (dicetak sekali)
 *   node scripts/atur-kata-sandi.js --user garap --acak # satu akun → sandi acak
 *   KATA_SANDI='...' node scripts/atur-kata-sandi.js --user garap   # sandi dari env (≥12 karakter)
 *
 * Dump awal (database/vertonik.sql) membawa sandi contoh yang tercantum di dokumen — WAJIB diganti
 * sebelum server dipakai. Installer Pi menjalankan --semua-acak otomatis pada instalasi pertama.
 */
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { q, pool } = require('../src/db');

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : undefined; };
const ada = (n) => process.argv.includes(`--${n}`);
// 20 karakter tanpa karakter yang mudah tertukar (0/O, 1/l/I)
const ALFABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const acak = () => Array.from(crypto.randomBytes(20), (b) => ALFABET[b % ALFABET.length]).join('');

(async () => {
  let targets;
  if (ada('semua-acak')) targets = (await q('SELECT username FROM users ORDER BY id')).map((r) => r.username);
  else if (arg('user')) targets = [arg('user')];
  else { console.error('Pakai: --semua-acak | --user <nama> [--acak]'); process.exit(2); }

  for (const u of targets) {
    const sandi = ada('semua-acak') || ada('acak') ? acak() : process.env.KATA_SANDI;
    if (!sandi || sandi.length < 12) throw new Error('kata sandi minimal 12 karakter (atau pakai --acak)');
    const hash = await bcrypt.hash(sandi, 12);
    const r = await q('UPDATE users SET password = $2, updated_at = now() WHERE username = $1 RETURNING username', [u, hash]);
    if (!r.length) { console.error(`akun '${u}' tidak ada`); continue; }
    if (ada('semua-acak') || ada('acak')) console.log(`${u}\t${sandi}`);
    else console.log(`${u}\tkata sandi diperbarui`);
  }
})().catch((e) => { console.error('GAGAL:', e.message); process.exitCode = 1; }).finally(() => pool.end());
