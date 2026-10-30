'use strict';
/**
 * Fase 3F — kontrak OpenAPI vs implementasi rute dosing (statis, tanpa DB): setiap rute di src/routes/dosing.js
 * terdokumentasi di docs/openapi.yaml (repo induk) dengan metode yang sama, operasi POST mewajibkan Idempotency-Key,
 * dan kode respons yang dipakai kode terdokumentasi. Dilewati bila docs/openapi.yaml tidak ada (repo backend berdiri sendiri).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, '..', '..', 'docs', 'openapi.yaml');
const lewati = fs.existsSync(FILE) ? false : 'docs/openapi.yaml tidak ada (repo backend berdiri sendiri)';
const yaml = lewati ? '' : fs.readFileSync(FILE, 'utf8');
const rute = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'dosing.js'), 'utf8');

/** {path: teks blok} untuk path /api/dosing/* di openapi.yaml. */
function bloklari() {
  const out = {};
  const baris = yaml.split('\n');
  let kunci = null;
  for (const b of baris) {
    const m = b.match(/^ {2}(\/[^\s:]*):\s*$/);
    if (m) { kunci = m[1]; out[kunci] = ''; continue; }
    if (/^\S/.test(b)) kunci = null; // kunci tingkat atas berikutnya (components:, dst.)
    if (kunci) out[kunci] += `${b}\n`;
  }
  return Object.fromEntries(Object.entries(out).filter(([k]) => k.startsWith('/api/dosing')));
}
const dariKode = () => [...rute.matchAll(/router\.(get|post)\('([^']+)'/g)].map(([, metode, p]) => [metode, `/api/dosing${p}`.replace(/:id\b/g, '{id}')]);

test('setiap rute dosing di kode terdokumentasi (path + metode), dan sebaliknya', { skip: lewati }, () => {
  const blok = bloklari();
  const kode = dariKode();
  assert.ok(kode.length >= 7, `rute terdeteksi: ${kode.length}`);
  for (const [metode, p] of kode) {
    assert.ok(blok[p], `${metode.toUpperCase()} ${p} tidak ada di openapi.yaml`);
    assert.match(blok[p], new RegExp(`^ {4}${metode}:`, 'm'), `${metode.toUpperCase()} ${p}: metode tidak terdokumentasi`);
  }
  const set = new Set(kode.map(([m, p]) => `${m} ${p}`));
  for (const [p, teks] of Object.entries(blok)) {
    for (const m of teks.matchAll(/^ {4}(get|post|put|delete|patch):/gm)) assert.ok(set.has(`${m[1]} ${p}`), `openapi ${m[1].toUpperCase()} ${p} tidak ada di kode`);
  }
});

test('operasi POST dosing mewajibkan Idempotency-Key; GET tidak', { skip: lewati }, () => {
  const blok = bloklari();
  for (const [metode, p] of dariKode()) {
    const teks = blok[p];
    const mulai = teks.search(new RegExp(`^ {4}${metode}:`, 'm'));
    const sisa = teks.slice(mulai + 1);
    const berikut = sisa.search(/^ {4}(get|post|put|delete|patch):/m);
    const bagian = berikut === -1 ? teks.slice(mulai) : teks.slice(mulai, mulai + 1 + berikut); // hanya operasi ini
    if (metode === 'post') assert.match(bagian, /parameters\/IdempotencyKey/, `POST ${p}`);
    else assert.doesNotMatch(bagian, /IdempotencyKey/, `GET ${p}`);
  }
});

test('kode respons yang dipakai implementasi terdokumentasi per operasi', { skip: lewati }, () => {
  const blok = bloklari();
  const wajib = {
    '/api/dosing/siklus/{id}/jalankan': ['401', '403', '404', '409', '410', '422', '423', '501', '503'],
    '/api/dosing/siklus/{id}/setujui': ['200', '401', '403', '404', '409', '410', '422', '423', '503'],
    '/api/dosing/siklus/{id}/tolak': ['200', '401', '403', '404', '409', '422', '503'],
    '/api/dosing/siklus/{id}/cabut': ['200', '401', '403', '404', '409', '422', '503'],
    '/api/dosing/siklus': ['200', '201', '401', '403', '409', '422', '423', '503'],
    '/api/dosing/siklus/{id}': ['200', '401', '404', '503'],
  };
  for (const [p, kodeWajib] of Object.entries(wajib)) {
    for (const k of kodeWajib) assert.match(blok[p], new RegExp(`^ {8}"${k}":`, 'm'), `${p}: respons ${k} tidak terdokumentasi`);
  }
  // jalankan tidak boleh mendokumentasikan 200 (tidak pernah sukses selama gerbang tertutup)
  assert.doesNotMatch(blok['/api/dosing/siklus/{id}/jalankan'], /^ {8}"200":/m);
});

test('operationId openapi.yaml unik dan semua $ref komponen terselesaikan', { skip: lewati }, () => {
  const ids = [...yaml.matchAll(/operationId:\s*(\S+)/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, 'operationId duplikat');
  const bagianKomponen = (nama) => { const m = yaml.match(new RegExp(`^ {2}${nama}:\\n((?: {4}.*\\n|\\n)*)`, 'm')); return m ? new Set([...m[1].matchAll(/^ {4}(\w+):/gm)].map((x) => x[1])) : new Set(); };
  const ada = { schemas: bagianKomponen('schemas'), responses: bagianKomponen('responses'), parameters: bagianKomponen('parameters') };
  for (const [, jenis, nama] of yaml.matchAll(/#\/components\/(schemas|responses|parameters)\/(\w+)/g)) assert.ok(ada[jenis].has(nama), `$ref hilang: ${jenis}/${nama}`);
});

/* ── Semua rute Fase 3 (introspeksi router Express, bukan regex) ───────────────────────────────────────────── */
const normal = (p) => p.replace(/\{[^}]+\}/g, '{}').replace(/:[A-Za-z_]+/g, '{}').replace(/\/+$/, '') || '/';
function rutaRouter(router, prefiks) {
  const out = [];
  for (const l of router.stack) {
    if (!l.route) continue;
    const jalur = Array.isArray(l.route.path) ? l.route.path : [l.route.path];
    for (const j of jalur) for (const m of Object.keys(l.route.methods)) if (l.route.methods[m]) out.push(`${m} ${normal(`${prefiks}${j === '/' ? '' : j}`)}`);
  }
  return out;
}

test('semua rute Fase 3 (siklus, konfirmasi, lot, penugasan, preset, parameter, dosing) cocok dengan openapi.yaml (path + metode, dua arah)', { skip: lewati }, () => {
  const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  const sb = require('../src/routes/siklusBudidaya');
  const dipasang = [
    ['/api/siklus', sb.siklus], ['/api/konfirmasi', sb.konfirmasi], ['/api/lot', sb.lot], ['/api/penugasan', sb.penugasan],
    ['/api/preset', sb.preset], ['/api/parameter', require('../src/routes/parameter')], ['/api/dosing', require('../src/routes/dosing')],
  ];
  for (const [pref] of dipasang) assert.match(index, new RegExp(`app\\.use\\('${pref.replace(/\//g, '\\/')}'`), `${pref} dipasang di index.js`);
  const kode = new Set(dipasang.flatMap(([pref, r]) => rutaRouter(r, pref)));
  assert.ok(kode.size >= 25, `rute terdeteksi: ${kode.size}`);
  const dok = new Set();
  let kunci = null;
  for (const b of yaml.split('\n')) {
    const mp = b.match(/^ {2}(\/[^\s:]*):\s*$/);
    if (mp) { kunci = mp[1]; continue; }
    if (/^\S/.test(b)) kunci = null;
    const mm = kunci && b.match(/^ {4}(get|post|put|delete|patch):/);
    if (mm && dipasang.some(([pref]) => kunci === pref || kunci.startsWith(`${pref}/`))) dok.add(`${mm[1]} ${normal(kunci)}`);
  }
  const hilangDiDok = [...kode].filter((k) => !dok.has(k));
  const hilangDiKode = [...dok].filter((k) => !kode.has(k));
  assert.deepEqual(hilangDiDok, [], `rute ada di kode tetapi tidak di openapi.yaml: ${hilangDiDok.join(', ')}`);
  assert.deepEqual(hilangDiKode, [], `operasi ada di openapi.yaml tetapi tidak di kode: ${hilangDiKode.join(', ')}`);
});
