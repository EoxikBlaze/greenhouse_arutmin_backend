'use strict';
/**
 * Fase 3F — bukti PERILAKU (bukan teks/regex) containment DOSIS pada antrean `perintah_aktuator`:
 * dequeue, cleanup expiry, urutan STOP, LOCK, E-STOP, dan balapan. Menutup blocker verifikasi 3E.4.
 *
 * HANYA di DB uji (`garap_uji*`). Baris DOSIS di sini adalah fixture SQL di DB uji (status 'menunggu' atau 'dikirim')
 * yang dipakai membuktikan filter; tidak ada broker, perangkat, atau pembuat DOSIS yang dipanggil, dan semuanya
 * dihapus di after() (ditandai alasan 'uji-3f%'). E-STOP dipulihkan ke nilai awal.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pool, q } = require('../../src/db');
const aktuator = require('../../src/aktuator');

const { lewati } = require('./_isolasi'); // nama garap_uji* DAN host loopback

const DEV = 'aktuator-01';
const TANDA = 'uji-3f';
const meja = []; let estopAwal; let jumlahAwal;

const isi = async (tipe, { status = 'menunggu', detik = 600, parameter = {}, dikirimDetikLalu = null } = {}) =>
  Number((await q(
    `INSERT INTO perintah_aktuator (perangkat_kode, tipe, parameter, sumber, status, alasan, kedaluwarsa_pada, dikirim_pada)
     VALUES ($1, $2, $3, 'sistem', $4, $5, now() + make_interval(secs => $6::float8),
             CASE WHEN $7::float8 IS NULL THEN NULL ELSE now() - make_interval(secs => $7::float8) END) RETURNING id`,
    [DEV, tipe, parameter, status, `${TANDA} ${tipe.trim()}`, detik, dikirimDetikLalu]))[0].id);
const baris = async (ids) => Object.fromEntries((await q('SELECT id, status, dikirim_pada FROM perintah_aktuator WHERE id = ANY($1)', [ids])).map((r) => [Number(r.id), r]));
const bersihkan = async () => {
  await q('DELETE FROM perintah_aktuator WHERE alasan LIKE $1', [`${TANDA}%`]);
  await q("UPDATE aktuator_state SET nilai = $1 WHERE kunci = 'estop'", [estopAwal]);
};

before(async () => {
  if (lewati) return;
  estopAwal = (await q("SELECT nilai FROM aktuator_state WHERE kunci = 'estop'"))[0].nilai;
  assert.equal(estopAwal, '0', 'prasyarat: E-STOP DB uji harus mati sebelum tes');
  assert.equal((await q("SELECT peran FROM perangkat WHERE kode = $1", [DEV]))[0].peran, 'gabungan');   // satu ESP32: sensor + aktuator (migrasi 2026-11-05_01)
  for (let i = 0; i < 3; i += 1) {
    meja.push(Number((await q('INSERT INTO mejas (meja, jumlah_lubang, created_at, updated_at) VALUES ($1, 10, now(), now()) RETURNING id_meja', [`uji-3f-${i}`]))[0].id_meja));
  }
  jumlahAwal = Number((await q('SELECT count(*) n FROM perintah_aktuator WHERE alasan NOT LIKE $1 OR alasan IS NULL', [`${TANDA}%`]))[0].n);
});

after(async () => {
  if (lewati) { await pool.end(); return; }
  try {
    await bersihkan();
    await q('DELETE FROM alert_logs WHERE id_meja = ANY($1)', [meja]);
    await q('DELETE FROM penampung_states WHERE id_meja = ANY($1)', [meja]);
    await q('DELETE FROM mejas WHERE id_meja = ANY($1)', [meja]);
    const sisa = Number((await q('SELECT count(*) n FROM perintah_aktuator WHERE alasan NOT LIKE $1 OR alasan IS NULL', [`${TANDA}%`]))[0].n);
    assert.equal(sisa, jumlahAwal, 'baris non-fixture tidak berubah');
  } finally {
    await pool.end();
  }
});

test('dequeue: DOSIS menunggu (expiry mendatang/lampau, variasi tipe) TIDAK dikirim, status tidak berubah; non-DOSIS tetap dikirim', { skip: lewati }, async () => {
  const dosis = [await isi('DOSIS', { detik: 600 }), await isi('DOSIS', { detik: -600 }), await isi(' dosis ', { detik: 600 }), await isi('Dosis', { detik: 600 }), await isi('DOSIS\t', { detik: 600 })];
  const lain = [await isi('ISI_AIR'), await isi('STOP'), await isi('SAMPLING'), await isi('BILAS')];
  const kedaluwarsa = await isi('SAMPLING', { detik: -600 });
  const hasil = await aktuator.ambilPerintah(DEV, 10);
  const idKirim = hasil.map((r) => Number(r.id));
  for (const id of dosis) assert.equal(idKirim.includes(id), false, `DOSIS ${id} tidak boleh dikembalikan`);
  assert.deepEqual([...idKirim].sort(), [...lain].sort(), 'hanya non-DOSIS yang eligible');
  const b = await baris([...dosis, ...lain, kedaluwarsa]);
  for (const id of dosis) { assert.equal(b[id].status, 'menunggu', `DOSIS ${id}`); assert.equal(b[id].dikirim_pada, null); }
  for (const id of lain) assert.equal(b[id].status, 'dikirim');
  assert.equal(b[kedaluwarsa].status, 'kedaluwarsa', 'cleanup expiry non-DOSIS tetap berjalan');
});

test('cleanup expiry: DOSIS menunggu lampau TIDAK ditandai kedaluwarsa/dibersihkan otomatis; dipanggil berulang tetap sama', { skip: lewati }, async () => {
  const lampau = await isi('DOSIS', { detik: -3600 });
  for (let i = 0; i < 3; i += 1) await aktuator.rapikanAntrean(DEV);
  assert.equal((await baris([lampau]))[lampau].status, 'menunggu');
});

test('urutan pengambilan: STOP_DARURAT lalu STOP mendahului perintah lain walau id lebih besar', { skip: lewati }, async () => {
  const air = await isi('ISI_AIR');
  const stop = await isi('STOP');
  const darurat = await isi('STOP_DARURAT');
  const urut = [];
  for (let i = 0; i < 3; i += 1) urut.push(...(await aktuator.ambilPerintah(DEV, 1)).map((r) => Number(r.id)));
  assert.deepEqual(urut, [darurat, stop, air]);
});

test('LOCK (runtime): dosis menunggu penampung itu dibatalkan, penampung lain tidak; kunci dua kali tidak menggandakan alert', { skip: lewati }, async () => {
  const a = await isi('DOSIS', { parameter: { penampung: meja[0], larutan: 'AB', ml: 10 } });
  const b = await isi('DOSIS', { parameter: { penampung: meja[1], larutan: 'AB', ml: 10 } });
  assert.equal(await aktuator.kunciPenampung(meja[0], { alasan: 'uji 3F', type: 'volume_tidak_pasti', value: 'uji' }), true);
  assert.equal(await aktuator.kunciPenampung(meja[0], { alasan: 'uji 3F lagi', type: 'volume_tidak_pasti', value: 'uji' }), false);
  const st = await baris([a, b]);
  assert.equal(st[a].status, 'batal'); assert.equal(st[b].status, 'menunggu', 'penampung lain tidak tersentuh');
  assert.equal((await q('SELECT status_lock FROM penampung_states WHERE id_meja = $1', [meja[0]]))[0].status_lock, true);
  assert.equal((await q('SELECT status_lock FROM penampung_states WHERE id_meja = $1', [meja[1]]))[0]?.status_lock ?? false, false);
  assert.equal(Number((await q("SELECT count(*) n FROM alert_logs WHERE id_meja = $1 AND type = 'volume_tidak_pasti'", [meja[0]]))[0].n), 1);
  assert.deepEqual((await aktuator.ambilPerintah(DEV, 10)).map((r) => Number(r.id)), [], 'DOSIS tetap tidak dikirim setelah LOCK');
});

test('timeout DOSIS yang sudah dikirim (perilaku lama dipertahankan): gagal + LOCK penampung', { skip: lewati }, async () => {
  const d = await isi('DOSIS', { status: 'dikirim', dikirimDetikLalu: 300, parameter: { penampung: meja[2], larutan: 'AB', ml: 10 } });
  await aktuator.rapikanAntrean(DEV);
  const r = (await q('SELECT status, hasil FROM perintah_aktuator WHERE id = $1', [d]))[0];
  assert.equal(r.status, 'gagal'); assert.equal(r.hasil.error, 'timeout_tanpa_laporan');
  assert.equal((await q('SELECT status_lock FROM penampung_states WHERE id_meja = $1', [meja[2]]))[0].status_lock, true);
});

test('E-STOP (runtime): latch menyala, semua perintah menunggu dibatalkan, STOP_DARURAT keluar pertama, perintah berisiko ditolak 423, STOP tetap diterima', { skip: lewati }, async () => {
  const dosis = await isi('DOSIS', { parameter: { penampung: meja[1], larutan: 'AB', ml: 10 } });
  const air = await isi('ISI_AIR');
  try {
    const es = await aktuator.buatPerintah({ tipe: 'STOP_DARURAT', parameter: {}, sumber: 'pengguna', alasan: `${TANDA} estop` });
    assert.equal((await aktuator.statusEstop()).nilai, '1');
    const b = await baris([dosis, air]);
    assert.equal(b[dosis].status, 'batal'); assert.equal(b[air].status, 'batal');
    await assert.rejects(aktuator.buatPerintah({ tipe: 'ISI_AIR', parameter: { penampung: meja[0], aksi: 'MULAI' }, sumber: 'pengguna', alasan: `${TANDA} saat estop` }), (e) => e.status === 423);
    const stop = await aktuator.buatPerintah({ tipe: 'STOP', parameter: {}, sumber: 'pengguna', alasan: `${TANDA} stop saat estop` });
    const urut = (await aktuator.ambilPerintah(DEV, 1)).map((r) => Number(r.id));
    assert.deepEqual(urut, [Number(es.id)]);
    assert.deepEqual((await aktuator.ambilPerintah(DEV, 1)).map((r) => Number(r.id)), [Number(stop.id)]);
    assert.equal((await baris([dosis]))[dosis].status, 'batal', 'DOSIS tidak pernah dikirim');
  } finally {
    await aktuator.resetEstop();
  }
  assert.equal((await aktuator.statusEstop()).nilai, '0');
});

test('balapan: 8 pengambil paralel — tiap non-DOSIS terkirim tepat sekali, DOSIS tidak pernah', { skip: lewati }, async () => {
  const dosis = []; const lain = [];
  for (let i = 0; i < 4; i += 1) dosis.push(await isi('DOSIS'));
  for (let i = 0; i < 12; i += 1) lain.push(await isi(i % 2 ? 'SAMPLING' : 'ISI_AIR'));
  const hasil = await Promise.all(Array.from({ length: 8 }, () => aktuator.ambilPerintah(DEV, 3)));
  const semua = hasil.flat().map((r) => Number(r.id));
  assert.equal(new Set(semua).size, semua.length, 'tidak ada perintah terkirim dua kali');
  assert.deepEqual([...semua].sort((x, y) => x - y), [...lain].sort((x, y) => x - y));
  for (const id of dosis) assert.equal(semua.includes(id), false);
  const b = await baris([...dosis, ...lain]);
  for (const id of dosis) assert.equal(b[id].status, 'menunggu');
});

test('balapan: E-STOP bersamaan dengan pengambilan — DOSIS tak pernah dikirim, latch menang, tak ada perintah tertinggal menunggu', { skip: lewati }, async () => {
  const dosis = []; const lain = [];
  for (let i = 0; i < 3; i += 1) dosis.push(await isi('DOSIS'));
  for (let i = 0; i < 9; i += 1) lain.push(await isi('SAMPLING'));
  try {
    const [, , es] = await Promise.all([aktuator.ambilPerintah(DEV, 3), aktuator.ambilPerintah(DEV, 3),
      aktuator.buatPerintah({ tipe: 'STOP_DARURAT', parameter: {}, sumber: 'pengguna', alasan: `${TANDA} estop balapan` })]);
    assert.equal((await aktuator.statusEstop()).nilai, '1');
    assert.ok(es.id);
    const b = await baris([...dosis, ...lain]);
    for (const id of dosis) assert.notEqual(b[id].status, 'dikirim', 'DOSIS tidak pernah dikirim');
    for (const id of lain) assert.ok(['dikirim', 'batal'].includes(b[id].status), `perintah ${id} berakhir ${b[id].status}`);
    const stDarurat = (await q('SELECT status FROM perintah_aktuator WHERE id = $1', [es.id]))[0].status;
    assert.ok(['menunggu', 'dikirim'].includes(stDarurat), `STOP_DARURAT tidak hilang (status ${stDarurat})`);
    const sisa = await aktuator.ambilPerintah(DEV, 10);
    assert.equal(sisa.some((r) => String(r.tipe).trim().toUpperCase() === 'DOSIS'), false);
  } finally {
    await aktuator.resetEstop();
  }
});

test('KARAKTERISASI: DOSIS lama yang menunggu tetap menghitung kuota antrean (10) → perintah berisiko baru ditolak 429, STOP tetap diterima', { skip: lewati }, async () => {
  for (let i = 0; i < 10; i += 1) await isi('DOSIS');
  await assert.rejects(aktuator.buatPerintah({ tipe: 'ISI_AIR', parameter: { penampung: meja[0], aksi: 'MULAI' }, sumber: 'pengguna', alasan: `${TANDA} kuota` }), (e) => e.status === 429);
  const stop = await aktuator.buatPerintah({ tipe: 'STOP', parameter: {}, sumber: 'pengguna', alasan: `${TANDA} stop kuota` });
  assert.ok(stop.id);
});

test('inventaris statis jalur dispatch (gagal bila jalur baru muncul → wajib ditinjau): satu penulis status dikirim, satu publisher perintah, dua pemanggil dequeue', { skip: lewati }, () => {
  const SRC = path.join(__dirname, '..', '..', 'src');
  const berkas = [];
  (function jelajah(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) jelajah(p); else if (f.name.endsWith('.js')) berkas.push(p); } })(SRC);
  const baca = (p) => fs.readFileSync(p, 'utf8');
  const rel = (p) => path.relative(SRC, p);
  const penulis = berkas.filter((p) => /SET\s+status\s*=\s*'dikirim'/.test(baca(p))).map(rel);
  assert.deepEqual(penulis, ['aktuator.js']);
  assert.equal((baca(path.join(SRC, 'aktuator.js')).match(/SET\s+status\s*=\s*'dikirim'/g) || []).length, 1);
  const publisher = berkas.filter((p) => /\.publish\(\s*`\$\{PREFIX\}\/\$\{kode\}\/perintah`/.test(baca(p))).map(rel);
  assert.deepEqual(publisher, ['mqttJembatan.js']);
  const pemanggil = berkas.filter((p) => rel(p) !== 'aktuator.js' && /ambilPerintah\(/.test(baca(p))).map(rel).sort();
  assert.deepEqual(pemanggil, ['mqttJembatan.js', path.join('routes', 'device.js')].sort());
  const mqtt = baca(path.join(SRC, 'mqttJembatan.js'));
  assert.ok(mqtt.indexOf('ambilPerintah(kode') > -1 && mqtt.lastIndexOf('terbitkanPerintah(client, kode, list') > mqtt.indexOf('ambilPerintah(kode'), 'publisher hanya menerima hasil dequeue');
});
