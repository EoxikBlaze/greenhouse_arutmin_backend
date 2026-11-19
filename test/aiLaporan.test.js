'use strict';
/* Data di berkas ini SINTETIS, bukan bacaan alat nyata. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { susunInsight } = require('../src/aiInsight');
const { susunLaporan } = require('../src/aiLaporan');

const T0 = Date.UTC(2026, 10, 13, 0, 0, 0);
const AMBANG = { ph: { min: 5.5, max: 6.5 }, tds: { min: 1200, max: 1600 } };
/** n bacaan tiap 5 dtk berakhir tepat di `sekarangMs`. */
const baris = (n, sekarangMs, f) => Array.from({ length: n }, (_, i) => ({ t: sekarangMs - (n - 1 - i) * 5000, ...f(i) }));

test('laporan harian normal: ringkasan berangka + satuan, tanpa tindak lanjut', () => {
  // derau kecil: nilai persis sama 1000× sengaja ditandai sensor macet oleh aiInsight
  const kini = T0 + 86_400_000;
  const insight = susunInsight(baris(1000, kini, (i) => { const d = (i % 3) - 1; return { ph: 6.0 + d * 0.01, tds: 1400 + d, waterTemp: 26 + d * 0.1, airTemp: 29 + d * 0.1, humidity: 70 + d }; }), { periode: '24j', sekarangMs: kini, ambang: AMBANG });
  const l = susunLaporan(insight, { alert: { total: 0, aktif: 0, kritis: 0 }, perintah: [] });
  assert.equal(l.jenis, 'harian');
  assert.match(l.ringkasan.find((s) => s.startsWith('TDS')), /rata-rata 1400 ppm/);
  assert.match(l.ringkasan.find((s) => s.startsWith('pH')), /dalam target 5\.5–6\.5/);
  assert.deepEqual(l.tindak_lanjut.filter((s) => !/kelengkapan/i.test(s)), []);
  assert.equal(l.sifat, 'rekomendasi');
  assert.ok(l.teks.includes('24 jam terakhir'));
});

test('laporan: TDS turun di bawah target → saran periksa lewat alur persetujuan, bukan perintah', () => {
  const kini = T0 + 3_600_000;
  const insight = susunInsight(baris(700, kini, (i) => ({ ph: 6.0, tds: 1400 - i * 0.5 })), { periode: '1j', sekarangMs: kini, ambang: AMBANG });
  const l = susunLaporan(insight, {});
  const tds = l.ringkasan.find((s) => s.startsWith('TDS'));
  assert.match(tds, /turun/);
  assert.match(tds, /di bawah target/);
  assert.ok(l.tindak_lanjut.some((s) => /TDS/.test(s) && /persetujuan dosing/.test(s)));
  assert.ok(!/nyalakan|jalankan pompa|dosis sekarang/i.test(l.teks));
});

test('laporan: data basi → peringatan pertama, target tidak dinilai sebagai kondisi sekarang', () => {
  const kini = T0 + 3_600_000;
  const lama = baris(100, kini - 1_800_000, () => ({ ph: 4.0, tds: 1400 }));
  const l = susunLaporan(susunInsight(lama, { periode: '1j', sekarangMs: kini, ambang: AMBANG }), {});
  assert.match(l.tindak_lanjut[0], /bukan kondisi saat ini/);
  assert.ok(!l.tindak_lanjut.some((s) => /persetujuan dosing/.test(s)));
  assert.equal(l.real_time, false);
});

test('laporan: anomali dihitung per jenis; alert dan aktivitas alat ikut', () => {
  const kini = T0 + 3_600_000;
  const data = baris(200, kini, (i) => ({ ph: i === 100 ? 8.9 : 6.0, tds: 1400 }));
  const l = susunLaporan(susunInsight(data, { periode: '1j', sekarangMs: kini, ambang: AMBANG }), {
    alert: { total: 3, aktif: 1, kritis: 1 },
    perintah: [{ tipe: 'isi_air', status: 'selesai', jumlah: 2 }],
  });
  assert.equal(l.anomali.per_jenis.lompatan, 1);
  assert.ok(l.tindak_lanjut.some((s) => /pH/.test(s) && /probe/i.test(s)));
  assert.ok(l.ringkasan.some((s) => /3 alert/.test(s) && /1 kritis/.test(s)));
  assert.ok(l.ringkasan.some((s) => /isi_air/.test(s) && /2/.test(s)));
});

test('laporan: tanpa data sama sekali → jujur, tidak mengarang angka', () => {
  const l = susunLaporan(susunInsight([], { periode: '7h', sekarangMs: T0, ambang: AMBANG }), {});
  assert.equal(l.jenis, 'mingguan');
  assert.ok(l.ringkasan.every((s) => !/rata-rata/.test(s)));
  assert.match(l.tindak_lanjut[0], /tidak ada data/i);
});
