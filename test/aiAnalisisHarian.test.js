'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { susunInsight } = require('../src/aiInsight');
const { susunAnalisis, SARAN_TETAP } = require('../src/aiAnalisisHarian');
const { tanggalWib, msSampai07Wib, sudahLewat07 } = require('../src/penjadwalAnalisisHarian');

const SEKARANG = Date.UTC(2026, 10, 17, 0, 0, 0); // 07.00 WIB
const ambang = { ph: { min: 5.5, max: 6.5 }, tds: { min: 800, max: 1200, satuan: 'ppm' } };

function baris(akhirMs, jumlah = 60) {
  return Array.from({ length: jumlah }, (_, i) => ({
    t: akhirMs - (jumlah - 1 - i) * 5000, ph: 6, tds: 1000, waterTemp: 25, airTemp: 29, humidity: 70,
  }));
}

function bahan({ basi = false } = {}) {
  const akhir = basi ? SEKARANG - 3 * 3600_000 : SEKARANG - 5000;
  const insight = susunInsight(baris(akhir), { periode: '24j', sekarangMs: SEKARANG, ambang });
  const sensor = { ph: 6, tds: 1000, waterTemp: 25, airTemp: 29, humidity: 70, created_at: new Date(akhir) };
  return {
    tanggal: '2026-11-17', insight,
    alert: { total: 1, aktif: 1, kritis: 0 }, perintah: [{ tipe: 'POMPA', status: 'SELESAI', jumlah: 2 }],
    data: { ambang, sensor, alert: { total: 0, terbaru: [] }, tahap: [], panen: null },
    penampung: [{ meja: 'Meja A', lock: false, dosis_hari: 0 }],
    logbook: 'Logbook kebun 7 hari terakhir (dari data aplikasi):\n• 15 Nov — Panen dicatat (10 tanaman)',
    heur: { keputusan: 'Pantau kondisi', prioritas: 'rendah' },
  };
}

const bagian = (a, judul) => a.bagian.find((b) => b.judul === judul).butir;

test('susunAnalisis: data segar → nilai terkini dan semua bagian terisi', () => {
  const a = susunAnalisis(bahan());
  assert.equal(a.sumber, 'deterministik');
  assert.equal(a.sifat, 'rekomendasi');
  assert.equal(a.prioritas, 'rendah');
  assert.deepEqual(a.bagian.map((b) => b.judul), ['Kondisi sensor terkini', 'Sensor 24 jam terakhir', 'Anomali', 'Alert',
    'Tahap tanam & panen', 'Penampung', 'Aktivitas alat 24 jam', 'Logbook 7 hari', 'Saran']);
  assert.match(bagian(a, 'Kondisi sensor terkini')[0], /^pH: 6 — dalam target 5\.5–6\.5/);
  assert.match(bagian(a, 'Kondisi sensor terkini')[2], /Suhu air: 25 °C \(target belum diatur\)/);
  assert.match(bagian(a, 'Alert')[0], /^Alert: 1 alert/);
  assert.match(bagian(a, 'Aktivitas alat 24 jam')[0], /POMPA SELESAI 2×/);
  assert.deepEqual(bagian(a, 'Logbook 7 hari'), ['• 15 Nov — Panen dicatat (10 tanaman)']);
  assert.ok(bagian(a, 'Saran').includes(SARAN_TETAP));
  assert.match(a.teks, /^Analisis harian 2026-11-17/);
});

test('susunAnalisis: data basi → "tidak tersedia", prioritas tinggi, tanpa saran koreksi larutan', () => {
  const b = bahan({ basi: true });
  b.data.sensor = { ...b.data.sensor, ph: 4 }; // angka lama di luar target tidak boleh dipakai
  const a = susunAnalisis(b);
  const terkini = bagian(a, 'Kondisi sensor terkini');
  assert.match(terkini[0], /basi/);
  for (const nama of ['pH', 'TDS', 'Suhu air', 'Suhu udara', 'Kelembapan udara']) {
    assert.ok(terkini.includes(`${nama}: tidak tersedia.`), nama);
  }
  assert.equal(a.prioritas, 'tinggi');
  assert.match(bagian(a, 'Anomali')[0], /Data sensor basi/);
  assert.ok(!bagian(a, 'Saran').some((s) => /alur persetujuan dosing\.$/.test(s) && /di bawah target|di atas target/.test(s)));
  assert.match(a.ringkasan_utama, /tidak terkini/);
});

test('susunAnalisis: tanpa data 24 jam & bahan kosong tetap aman', () => {
  const insight = susunInsight([], { periode: '24j', sekarangMs: SEKARANG, ambang });
  const a = susunAnalisis({ tanggal: '2026-11-17', insight, data: { ambang, sensor: null }, penampung: [], logbook: null });
  assert.match(bagian(a, 'Kondisi sensor terkini')[0], /Tidak ada bacaan/);
  assert.deepEqual(bagian(a, 'Penampung'), ['Data penampung tidak tersedia.']);
  assert.equal(a.prioritas, 'tinggi');
});

test('penjadwal: tanggal & jarak ke 07.00 WIB (UTC+7)', () => {
  const jam = (h, m = 0) => Date.UTC(2026, 10, 16, h, m); // UTC
  assert.equal(tanggalWib(jam(16, 59)), '2026-11-16');     // 23.59 WIB
  assert.equal(tanggalWib(jam(17, 0)), '2026-11-17');      // 00.00 WIB
  assert.equal(msSampai07Wib(jam(23, 0)), 3600_000);       // 06.00 WIB → 1 jam
  assert.equal(msSampai07Wib(jam(0, 0)), 86_400_000);      // tepat 07.00 → besok
  assert.equal(msSampai07Wib(jam(1, 0)), 23 * 3600_000);   // 08.00 WIB
  assert.equal(sudahLewat07(jam(23, 59)), false);
  assert.equal(sudahLewat07(jam(0, 0)), true);
});
