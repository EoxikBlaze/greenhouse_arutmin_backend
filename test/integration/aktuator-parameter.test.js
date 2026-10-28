'use strict';
/**
 * Fase 3B.1 — jalur aktuator tidak boleh menganggap NULL/tidak sah sebagai angka aman; jatah harian
 * hanya dikembalikan untuk volume yang benar-benar tidak keluar. TIDAK ada perangkat fisik: perintah
 * hanya diantre di DB lalu dibersihkan.
 *
 * HANYA di DB uji (`garap_uji*`) — mengubah konfigurasi_dosis sementara dan memulihkannya di after().
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { startServer, stopChild, craftToken, bearer } = require('./_server');
const { pool, q } = require('../../src/db');
const { buatPerintah, laporHasil, PerintahDitolak } = require('../../src/aktuator');

const namaDb = new URL(process.env.DATABASE_URL || 'postgres://x/none').pathname.slice(1);
const lewati = namaDb.startsWith('garap_uji') ? false : `hanya untuk DB uji garap_uji* (sekarang: ${namaDb || 'dari .env'})`;
const PERANGKAT = 'aktuator-01';
let meja; let cfgAwal; let timingAwal; let srv; let admin;

const dosis = (ml, larutan = 'AB') => buatPerintah({ tipe: 'DOSIS', parameter: { penampung: meja, larutan, ml }, sumber: 'pengguna', userId: null, perangkat: PERANGKAT });
const setCfg = (param, nilai) => q('UPDATE konfigurasi_dosis SET nilai = $2 WHERE param = $1', [param, nilai]);
const volumeAb = async () => Number((await q('SELECT volume_ab_hari_ml FROM penampung_states WHERE id_meja = $1', [meja]))[0].volume_ab_hari_ml);
const kirim = (id) => q("UPDATE perintah_aktuator SET status = 'dikirim', dikirim_pada = now() WHERE id = $1", [id]);

before(async () => {
  if (lewati) return;
  cfgAwal = await q('SELECT param, nilai, tervalidasi, divalidasi_pada, catatan_validasi FROM konfigurasi_dosis');
  timingAwal = await q('SELECT param, nilai, tervalidasi, divalidasi_pada, catatan_validasi FROM timing_operasi');
  meja = Number((await q("INSERT INTO mejas (meja, jumlah_lubang, created_at, updated_at) VALUES ('uji-3b1-akt', 10, now(), now()) RETURNING id_meja"))[0].id_meja);
  assert.equal((await q("SELECT nilai FROM aktuator_state WHERE kunci = 'estop'"))[0]?.nilai ?? '0', '0', 'E-STOP harus mati di DB uji');
  srv = await startServer();
  const idAdmin = Number((await q("SELECT id FROM users WHERE level = 'admin' AND NOT is_demo ORDER BY id LIMIT 1"))[0].id);
  admin = craftToken({ sub: idAdmin, username: 'garap', level: 'admin', demo: false }, { expiresIn: '10m' });
});

after(async () => {
  if (lewati) { await pool.end(); return; }
  try {
    for (const [tabel, rows] of [['konfigurasi_dosis', cfgAwal], ['timing_operasi', timingAwal]]) {
      for (const p of rows) {
        await q(`UPDATE ${tabel} SET nilai = $2, tervalidasi = $3, divalidasi_pada = $4, catatan_validasi = $5 WHERE param = $1`,
          [p.param, p.nilai, p.tervalidasi, p.divalidasi_pada, p.catatan_validasi]);
      }
    }
    await q("DELETE FROM perintah_aktuator WHERE (parameter->>'penampung')::bigint = $1", [meja]);
    await q('DELETE FROM alert_logs WHERE id_meja = $1', [meja]);
    await q('DELETE FROM dosing_events WHERE id_meja = $1', [meja]);
    await q('DELETE FROM monitorings WHERE id_meja = $1', [meja]);
    await q('DELETE FROM penampung_states WHERE id_meja = $1', [meja]);
    await q('DELETE FROM mejas WHERE id_meja = $1', [meja]);
  } finally {
    await stopChild(srv?.child);
    await pool.end();
  }
});

test('3B.1 aktuator: batas NULL / negatif / hilang → perintah DITOLAK (bukan dianggap 0 atau nilai bawaan)', { skip: lewati }, async () => {
  for (const [param, nilai, pola] of [['maks_volume_ab_hari_ml', null, /maks_volume_ab_hari_ml \(NULL\)/], ['maks_ml_per_suntikan', -5, /maks_ml_per_suntikan \(TIDAK_VALID\)/]]) {
    const asli = cfgAwal.find((p) => p.param === param).nilai;
    await setCfg(param, nilai);
    await assert.rejects(dosis(50), (e) => e instanceof PerintahDitolak && e.status === 409 && pola.test(e.message));
    await setCfg(param, asli);
  }
  await setCfg('maks_ml_ph_per_suntikan', null);
  await assert.rejects(dosis(5, 'PH_DOWN'), (e) => e.status === 409 && /maks_ml_ph_per_suntikan/.test(e.message));
  await setCfg('maks_ml_ph_per_suntikan', cfgAwal.find((p) => p.param === 'maks_ml_ph_per_suntikan').nilai);
  assert.equal((await q("SELECT count(*)::int n FROM perintah_aktuator WHERE (parameter->>'penampung')::bigint = $1", [meja]))[0].n, 0, 'tidak ada yang diantre');
  const p = await dosis(50);
  assert.equal(p.status, 'menunggu', 'parameter terisi → jalur lama berjalan seperti biasa');
  await q("UPDATE perintah_aktuator SET status = 'batal' WHERE id = $1", [p.id]);
});

// 3B.4: perilaku berubah — ESTIMASI (ml_nyata firmware = waktu × laju contoh) bukan bukti → tidak ada pengembalian.
test('3B.4 aktuator: kategori volume — hanya TIDAK_JALAN/UKUR yang mengembalikan jatah; ESTIMASI & TIDAK_DIKETAHUI tidak', { skip: lewati }, async () => {
  await q('UPDATE penampung_states SET volume_ab_hari_ml = 0, kejadian_dosis_hari = 0 WHERE id_meja = $1', [meja]);
  await q("UPDATE dosing_events SET hasil = 'dibatalkan', selesai_pada = now() WHERE id_meja = $1 AND hasil = 'berjalan'", [meja]);
  const vol = async (id) => (await q('SELECT hasil FROM perintah_aktuator WHERE id = $1', [id]))[0].hasil.volume_server;
  const a = await dosis(100);
  await kirim(a.id);
  await laporHasil(PERANGKAT, a.id, { status: 'gagal', hasil: { alasan: 'tombol_estop', ml_nyata: 60 } });
  assert.equal(await volumeAb(), 100, 'estimasi 60 mL tidak membuktikan 40 mL sisanya tidak keluar');
  assert.deepEqual(await vol(a.id), { kategori: 'ESTIMASI', ml: 60, diperintahkan: 100 });
  const ev = (await q("SELECT ronde_total FROM dosing_events WHERE id_meja = $1 AND hasil = 'berjalan'", [meja]))[0];
  assert.equal(ev.ronde_total, 1, 'suntikan sebagian tetap ronde');

  const u = await dosis(50);
  await kirim(u.id);
  await laporHasil(PERANGKAT, u.id, { status: 'gagal', hasil: { alasan: 'x', ml_nyata: 30, sumber_volume: 'ukur' } });
  assert.equal(await volumeAb(), 130, 'UKUR: sisa terukur (20 mL) dikembalikan');
  assert.equal((await vol(u.id)).kategori, 'UKUR');

  const b = await dosis(50);
  await kirim(b.id);
  await laporHasil(PERANGKAT, b.id, { status: 'gagal', hasil: { alasan: 'x', ml_nyata: 999 } });
  assert.equal(await volumeAb(), 180);
  assert.deepEqual(await vol(b.id), { kategori: 'ESTIMASI', ml: 50, diperintahkan: 50 }, 'dibatasi ke volume diperintahkan');

  const c = await dosis(40);
  await kirim(c.id);
  await laporHasil(PERANGKAT, c.id, { status: 'gagal', hasil: { error: 'pompa macet', ml_nyata: 0 } });
  assert.equal(await volumeAb(), 180, 'TIDAK_JALAN (0 tepat): seluruh reservasi dikembalikan');
  assert.equal((await vol(c.id)).kategori, 'TIDAK_JALAN');

  const d = await dosis(30);
  await kirim(d.id);
  await laporHasil(PERANGKAT, d.id, { status: 'gagal', hasil: { alasan: 'x', ml_nyata: 'banyak' } });
  assert.equal(await volumeAb(), 210, 'TIDAK_DIKETAHUI → tidak dikembalikan');
  assert.deepEqual(await vol(d.id), { kategori: 'TIDAK_DIKETAHUI', ml: null, diperintahkan: 30 });
  const st = (await q('SELECT status_lock, lock_alasan FROM penampung_states WHERE id_meja = $1', [meja]))[0];
  assert.equal(st.status_lock, true);
  assert.match(st.lock_alasan, /tidak diketahui/);
  await assert.rejects(dosis(10), (e) => e.status === 423, 'penampung terkunci menolak dosis berikutnya');
  await q('UPDATE penampung_states SET status_lock = false, lock_alasan = NULL, lock_sejak = NULL WHERE id_meja = $1', [meja]);
});

test('3B.1 konfigurasi: PUT nilai NULL/kosong/negatif/teks ditolak 422; nilai sah diterima tetapi BELUM tervalidasi', { skip: lewati }, async () => {
  const put = (param, nilai) => request(srv.base).put(`/konfigurasi-dosis/${param}`).set(bearer(admin)).send({ nilai });
  for (const v of [null, '', -1, 'abc']) {
    const r = await put('deadband_ec_ppm', v);
    assert.equal(r.status, 422, `nilai ${JSON.stringify(v)}: ${r.text}`);
  }
  assert.equal((await put('min_progres_persen', 150)).status, 422, 'persen > 100');
  const ok = await put('min_progres_persen', 20);
  assert.equal(ok.status, 200, ok.text);
  const st = await request(srv.base).get('/api/siklus/parameter').set(bearer(admin));
  if (st.status === 200) assert.equal(st.body.find((x) => x.param === 'min_progres_persen').status, 'BELUM_TERVALIDASI');
});

test('3B.2 aktuator: DOSIS tanpa laporan (timeout) → gagal, jatah TIDAK dikembalikan, penampung dikunci', { skip: lewati }, async () => {
  const { rapikanAntrean } = require('../../src/aktuator');
  await q('UPDATE penampung_states SET volume_ab_hari_ml = 0, status_lock = false, lock_alasan = NULL, lock_sejak = NULL WHERE id_meja = $1', [meja]);
  await q("UPDATE dosing_events SET hasil = 'dibatalkan', selesai_pada = now() WHERE id_meja = $1 AND hasil = 'berjalan'", [meja]);
  await q("UPDATE perintah_aktuator SET status = 'batal' WHERE perangkat_kode = $1 AND status IN ('menunggu','dikirim')", [PERANGKAT]);
  const p = await dosis(70);
  await q("UPDATE perintah_aktuator SET status = 'dikirim', dikirim_pada = now() - interval '91 seconds' WHERE id = $1", [p.id]);
  await rapikanAntrean(PERANGKAT);
  assert.equal((await q('SELECT status FROM perintah_aktuator WHERE id = $1', [p.id]))[0].status, 'gagal');
  assert.equal(await volumeAb(), 70, 'volume tidak diketahui → tidak dikembalikan');
  const st = (await q('SELECT status_lock, lock_alasan FROM penampung_states WHERE id_meja = $1', [meja]))[0];
  assert.equal(st.status_lock, true);
  assert.match(st.lock_alasan, /timeout/);
  // laporan terlambat setelah timeout tidak mengubah apa pun (perintah sudah ditutup)
  await assert.rejects(laporHasil(PERANGKAT, p.id, { status: 'gagal', hasil: { ml_nyata: 0 } }), (e) => e.status === 404);
  assert.equal(await volumeAb(), 70);
  await q('UPDATE penampung_states SET status_lock = false, lock_alasan = NULL, lock_sejak = NULL WHERE id_meja = $1', [meja]);
});
