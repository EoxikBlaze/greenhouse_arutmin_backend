#!/usr/bin/env node
'use strict';
/**
 * Buat API key baru dari terminal (dipakai installer Pi & admin).
 *
 *   node scripts/buat-kunci.js --perangkat sensor-01
 *   node scripts/buat-kunci.js --perangkat aktuator-01 --hari 365
 *   node scripts/buat-kunci.js --klien "Aplikasi HP" --scope data:baca
 *   node scripts/buat-kunci.js --perangkat sensor-01 --cabut-lama   # cabut kunci aktif lama perangkat itu
 *
 * Kunci dicetak SEKALI ke stdout (baris `KUNCI=vsf_...`); simpan segera. DB hanya menyimpan hash.
 */
const { buatKunci, SCOPE_VALID, SCOPE_PERAN } = require('../src/kunci');
const { q, one, pool } = require('../src/db');

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : undefined; };
const ada = (n) => process.argv.includes(`--${n}`);

(async () => {
  const kode = arg('perangkat');
  const klien = arg('klien');
  if (!kode && !klien) {
    console.error('Pakai: --perangkat <kode> | --klien <nama> --scope data:baca  [--hari N] [--cabut-lama]');
    process.exit(2);
  }
  let nama; let scope; let perangkatKode = null;
  if (kode) {
    const d = await one('SELECT kode, nama, peran FROM perangkat WHERE kode = $1', [kode]);
    if (!d || !d.peran) throw new Error(`perangkat '${kode}' tidak ditemukan/tidak punya peran (jalankan npm run migrate)`);
    nama = `kunci ${d.kode}`; scope = SCOPE_PERAN[d.peran]; perangkatKode = d.kode;
  } else {
    nama = klien; scope = (arg('scope') || 'data:baca').split(',');
    if (scope.some((s) => !SCOPE_VALID.includes(s))) throw new Error(`scope harus dari: ${SCOPE_VALID.join(', ')}`);
  }
  const hari = arg('hari') ? Number(arg('hari')) : null;
  if (ada('cabut-lama') && perangkatKode) {
    await q('UPDATE api_keys SET aktif = false, dicabut_pada = now() WHERE perangkat_kode = $1 AND dicabut_pada IS NULL', [perangkatKode]);
  }
  const k = await buatKunci({ nama, scope, perangkatKode, hariBerlaku: hari });
  console.log(`KUNCI=${k.kunci}`);
  console.error(`(id ${k.id}, scope ${k.scope.join('+')}${perangkatKode ? `, perangkat ${perangkatKode}` : ''}) — simpan sekarang, tidak ditampilkan lagi.`);
})().catch((e) => { console.error('GAGAL:', e.message); process.exitCode = 1; }).finally(() => pool.end());
