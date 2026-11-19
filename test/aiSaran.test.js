'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { saranPertanyaan, SARAN_PANDUAN } = require('../src/aiSaran');
const guard = require('../src/aiGuard');
const panduan = require('../src/aiPanduan');

test('rekomendasi pertanyaan berbeda sesuai konteks topik, bukan daftar generik sama', () => {
  const daftar = [
    saranPertanyaan({ pesan: 'kapan melon bisa dimakan', jalur: 'panduan', kunci: 'durasi_melon' }),
    saranPertanyaan({ pesan: 'kenapa daun melon berbintik putih dan menggulung ke atas?', jalur: 'matriks', kunci: 'daun_bintik_putih_menggulung' }),
    saranPertanyaan({ pesan: 'cara kalibrasi sensor ph dan ec lewat website', jalur: 'panduan', kunci: 'kalibrasi' }),
    saranPertanyaan({ pesan: 'bagaimana kondisi ph air sekarang?', jalur: 'ollama' }),
    saranPertanyaan({ pesan: 'berapa jumlah benih yang sedang disemai sekarang?', jalur: 'niat', kunci: 'tahap' }),
    saranPertanyaan({ pesan: 'melon manis atau brix tinggi caranya gimana?', jalur: 'matriks', kunci: 'melon_manis_brix' }),
  ];

  const signature = new Set(daftar.map((d) => JSON.stringify(d)));
  assert.equal(signature.size, daftar.length, 'setiap topik wajib punya rekomendasi pertanyaan berbeda');
  for (const list of daftar) {
    assert.ok(list.length >= 3 && list.length <= 4, 'jumlah saran wajar (3-4 item)');
    assert.equal(new Set(list).size, list.length, 'tidak ada saran duplikat');
    for (const s of list) {
      assert.equal(guard.periksaPesan(s).ok, true, `saran harus lolos pagar topik: ${s}`);
    }
  }
});

test('semua kunci di aiPanduan punya saran khusus atau fallback kata kunci kontekstual dan tidak mengulang pertanyaan user', () => {
  for (const kunci of Object.keys(panduan.TEKS)) {
    const saran = saranPertanyaan({ pesan: `tanya soal ${kunci}`, jalur: 'panduan', kunci });
    assert.ok(saran.length >= 3, `kunci panduan ${kunci} minimal 3 saran`);
    assert.ok(kunci in SARAN_PANDUAN, `kunci panduan ${kunci} terdaftar di SARAN_PANDUAN`);
  }

  const ulang = saranPertanyaan({
    pesan: 'Bagaimana cara nutrisi melon Naik Harian?',
    jalur: 'panduan',
    kunci: 'durasi_melon',
  });
  assert.ok(!ulang.some((s) => /nutrisi melon naik harian/i.test(s)), 'tidak mengulang pertanyaan yang sama persis');
});

test('rekomendasi beradaptasi dengan konteks DB (alert terbuka & batch semai aktif)', () => {
  const sapaanAktif = saranPertanyaan({
    pesan: 'halo',
    jalur: 'sapaan',
    data: { tahap: [{ tahap: 'semai', status: 'berjalan', jumlah: 50 }], alert: { total: 0 } },
  });
  assert.ok(sapaanAktif.some((s) => /tahap semai/i.test(s)), 'sapaan menyebut tahap aktif');

  const denganAlert = saranPertanyaan({
    pesan: 'bagaimana kondisi tds sekarang?',
    jalur: 'ollama',
    data: { sensor: { tds: 900 }, alert: { total: 2 } },
  });
  assert.ok(denganAlert.some((s) => /alert/i.test(s)), 'alert terbuka disisipkan saat relevan');
});

