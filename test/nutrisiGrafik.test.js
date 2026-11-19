'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { kejadianBaru, rencanaTarget, kosong } = require('../src/nutrisiGrafik');

const lama = (o) => new Map(Object.entries(o));

test('kejadian dosing = hitungan harian alat naik; sama / turun / laporan pertama bukan kejadian', () => {
  assert.deepEqual(kejadianBaru(lama({ dosing_ab_hari: 1 }), { dosing_ab_hari: 2 }), [{ jenis: 'AB', total_hari: 2 }]);
  assert.deepEqual(kejadianBaru(lama({ dosing_ab_hari: 2 }), { dosing_ab_hari: 2 }), []);
  assert.deepEqual(kejadianBaru(lama({ dosing_ab_hari: 5 }), { dosing_ab_hari: 0 }), []); // hari baru: hitungan kembali 0
  assert.deepEqual(kejadianBaru(lama({}), { dosing_ab_hari: 3 }), []); // belum ada pembanding: hanya dasar
});

test('beberapa jenis sekaligus; tipe tidak valid diabaikan; loncatan besar dibatasi', () => {
  const k = kejadianBaru(lama({ dosing_ab_hari: 0, dosing_ph_hari: 1, encer_hari: 0, isi_hari: 2 }), {
    dosing_ab_hari: 1, dosing_ph_hari: 2, encer_hari: 'x', isi_hari: null,
  });
  assert.deepEqual(k.map((x) => x.jenis).sort(), ['AB', 'PH']);
  assert.equal(kejadianBaru(lama({ dosing_ab_hari: 0 }), { dosing_ab_hari: 40 }).length, 5);
});

// 18 Nov 2026 12.00 waktu lokal server
const SEKARANG = new Date(2026, 10, 18, 12, 0, 0).getTime();
const KURVA = { kurva_cara: 'harian', kurva_ppm_awal: 400, kurva_ppm_target: 1200, kurva_hari_capai: 16, kurva_mulai_hari: 0, kurva_mulai_ppm: 400 };

test('rencana per hari: titik sekarang lalu target tiap tengah malam ke depan (naik 50 ppm per hari)', () => {
  const r = rencanaTarget({ tahap: 'Semai', hari_semai: 1, ...KURVA }, 2, SEKARANG);
  assert.deepEqual(r.map((x) => x.ppm), [450, 500, 550]);
  assert.equal(r[0].t, SEKARANG);
  assert.equal(new Date(r[1].t).getHours(), 0); // tengah malam
  assert.equal(new Date(r[1].t).getDate(), 19);
});

test('rencana per siklus: tetap sampai tahap dikonfirmasi pindah', () => {
  const tahap = { kurva_cara: 'tahap', kurva_ppm_semai: 300, kurva_ppm_peremajaan: 700, kurva_ppm_pendewasaan: 1100 };
  assert.deepEqual(rencanaTarget({ tahap: 'Semai', hari_semai: 9, ...tahap }, 2, SEKARANG).map((x) => x.ppm), [300, 300, 300]);
});

test('tanpa batch / tanpa resep: rencana kosong; bentuk jawaban kosong lengkap', () => {
  assert.deepEqual(rencanaTarget(null, 2, SEKARANG), []);
  assert.deepEqual(rencanaTarget({ tahap: 'Semai', hari_semai: 1 }, 2, SEKARANG), []);
  const k = kosong(7, SEKARANG);
  assert.equal(k.batch, null);
  assert.deepEqual(k.hari_ini.dosing, { AB: 0, PH: 0, ENCER: 0 });
  assert.equal(k.sampai, SEKARANG);
});
