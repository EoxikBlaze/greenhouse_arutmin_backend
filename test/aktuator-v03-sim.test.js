'use strict';
/** Model perilaku firmware v0.3 (scripts/aktuator-v03-sim.js) — BUKAN uji firmware/perangkat. Angka kalibrasi = fixture. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AktuatorV03 } = require('../scripts/aktuator-v03-sim');

const T0 = 1_800_000_000; // epoch detik fixture
const NVS = () => ({ idTerakhir: null, kalibrasi: { AB: 2 }, batasMl: { AB: 100 }, sedangJalan: null });
const dosis = (o = {}) => ({ id: 10, tipe: 'DOSIS', parameter: { larutan: 'AB', ml: 20 }, kejadian: 1, percobaan: 1, exp: T0 + 60, ...o });
function siap(nvs = NVS()) {
  const a = new AktuatorV03({ nvs });
  a.detak({ ts: T0 }, 0);
  return a;
}

test('v0.3 sim: jam belum sinkron → perintah ditolak (pompa tidak nyala)', () => {
  const a = new AktuatorV03({ nvs: NVS() });
  assert.equal(a.terima(dosis(), 100).alasan, 'server_hilang', 'tanpa detak sama sekali');
  const b = new AktuatorV03({ nvs: NVS() });
  b.detakMs = 0; // server hidup tetapi jam belum pernah disinkron (offset kosong)
  assert.equal(b.terima(dosis(), 10).alasan, 'jam_belum_sinkron');
  assert.equal(b.output, false);
});

test('v0.3 sim: perintah kedaluwarsa / exp tidak ada / exp terlalu jauh ditolak', () => {
  const a = siap();
  assert.equal(a.terima(dosis({ exp: T0 - 1 }), 1000).alasan, 'kedaluwarsa');
  assert.equal(a.terima(dosis({ exp: undefined }), 1000).alasan, 'exp_tidak_ada');
  assert.equal(a.terima(dosis({ exp: T0 + 3600 }), 1000).alasan, 'exp_tidak_wajar');
  assert.equal(a.output, false);
});

test('v0.3 sim: ID duplikat setelah reboot tidak menyalakan pompa lagi (NVS)', () => {
  const nvs = NVS();
  const a = siap(nvs);
  assert.equal(a.terima(dosis(), 1000).diterima, true);
  a.tick(11_000);
  assert.equal(a.output, false);
  a.reboot(0);
  a.detak({ ts: T0 + 20 }, 0);
  const r = a.terima(dosis({ exp: T0 + 80 }), 100);
  assert.deepEqual(r, { diterima: false, alasan: 'duplikat' });
  assert.equal(a.output, false);
  assert.equal(a.terima(dosis({ id: 9, exp: T0 + 80 }), 100).alasan, 'duplikat', 'id lebih kecil juga ditolak');
});

test('v0.3 sim: koneksi putus saat berjalan → pompa mati, laporan estimasi; perintah baru ditolak', () => {
  const a = siap();
  a.terima(dosis(), 1000);
  a.putus(4000);
  assert.equal(a.output, false);
  assert.deepEqual(a.laporan[0].hasil, { alasan: 'server_hilang', ml_nyata: 6, durasi_ms: 3000, sumber_volume: 'estimasi' });
  assert.deepEqual(a.kirimLaporan(), [], 'tidak bisa terkirim saat putus');
  assert.equal(a.terima(dosis({ id: 11 }), 4100).alasan, 'server_hilang');
  a.sambung(5000);
  assert.equal(a.kirimLaporan().length, 2, 'dikirim ulang setelah tersambung');
  a.ack(10); a.ack(11);
  assert.equal(a.kirimLaporan().length, 0);
});

test('v0.3 sim: detak hilang > 30 dtk tanpa putus eksplisit → fail-safe saat tick', () => {
  const a = siap();
  a.terima(dosis({ parameter: { larutan: 'AB', ml: 100 } }), 1000);
  a.tick(31_000);
  assert.equal(a.output, false);
  assert.equal(a.laporan[0].hasil.alasan, 'server_hilang');
});

test('v0.3 sim: E-STOP saat aktif → pompa mati; perintah berikut ditolak; STOP selalu diterima', () => {
  const a = siap();
  a.terima(dosis(), 1000);
  a.detak({ ts: T0 + 2, estop: true }, 2000);
  assert.equal(a.output, false);
  assert.equal(a.laporan[0].hasil.alasan, 'estop_server');
  assert.equal(a.terima(dosis({ id: 11 }), 2100).alasan, 'estop');
  assert.equal(a.terima({ id: 12, tipe: 'STOP' }, 2200).diterima, true);
});

test('v0.3 sim: pompa belum dikalibrasi / batas lokal hilang → ditolak, tanpa nilai bawaan', () => {
  assert.equal(siap({ ...NVS(), kalibrasi: {} }).terima(dosis(), 1000).alasan, 'belum_dikalibrasi');
  assert.equal(siap({ ...NVS(), kalibrasi: { AB: 0 } }).terima(dosis(), 1000).alasan, 'belum_dikalibrasi');
  assert.equal(siap({ ...NVS(), batasMl: {} }).terima(dosis(), 1000).alasan, 'konfigurasi_tidak_lengkap');
  assert.equal(siap().terima(dosis({ parameter: { larutan: 'AB', ml: 101 } }), 1000).alasan, 'ml_tidak_sah');
});

test('v0.3 sim: reboot saat dosis berjalan → laporan volume TIDAK DIKETAHUI (server wajib LOCK, bukan kembalikan jatah)', () => {
  const nvs = NVS();
  const a = siap(nvs);
  a.terima(dosis(), 1000);
  a.reboot(0);
  assert.equal(a.output, false);
  assert.deepEqual(a.laporan, [{ id: 10, status: 'gagal', hasil: { alasan: 'reboot_saat_jalan', ml_nyata: null, sumber_volume: 'tidak_diketahui' } }]);
});

test('v0.3 sim: DOSIS tanpa identitas persetujuan/percobaan ditolak', () => {
  const a = siap();
  assert.equal(a.terima(dosis({ kejadian: undefined }), 1000).alasan, 'tanpa_persetujuan');
  assert.equal(a.terima(dosis({ percobaan: '1' }), 1000).alasan, 'tanpa_persetujuan');
  assert.equal(a.output, false);
});

test('v0.3 sim: laporan berulang tidak menjalankan ulang pompa', () => {
  const a = siap();
  a.terima(dosis(), 1000);
  a.tick(11_000);
  const sekali = a.kirimLaporan();
  const lagi = a.kirimLaporan();
  assert.deepEqual(sekali, lagi);
  assert.equal(a.output, false);
  assert.equal(a.nvs.idTerakhir, 10);
});
