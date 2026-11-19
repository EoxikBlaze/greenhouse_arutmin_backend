'use strict';
/**
 * Rekomendasi pertanyaan lanjutan kontekstual (/api/ai/chat & /kolaborasi-trio).
 *
 * Setiap jalur & topik mengembalikan lanjutan yang relevan dengan bahasan pengguna
 * dan kondisi kebun terkini (batch aktif, status sensor, alert), bukan daftar generik
 * yang sama untuk semua jawaban.
 */
const { normalisasi } = require('./aiGuard');

const SARAN_PANDUAN = {
  durasi_melon: [
    'Bagaimana cara nutrisi melon Naik Harian?',
    'Bagaimana cara meningkatkan rasa manis (Brix) melon?',
    'Bagaimana cara polinasi bunga melon?',
    'Bagaimana cara pindah tahap dari semai ke meja?',
  ],
  nutrisi_melon: [
    'Apa perbedaan PPM dan EC serta cara konversinya?',
    'Berapa suhu dan kelembapan ideal untuk melon?',
    'Bagaimana cara meningkatkan rasa manis (Brix) melon?',
    'Bagaimana cara menurunkan pH air secara aman?',
  ],
  kalibrasi: [
    'Bagaimana cara kerja pompa dosing otomatis GARAP?',
    'Bagaimana cara nutrisi melon Naik Harian?',
    'Kenapa air di penampung berlumut atau berubah keruh?',
    'Tampilkan kondisi sensor kebun saat ini',
  ],
  polinasi_melon: [
    'Kenapa bunga atau bakal buah melon rontok?',
    'Berapa target PPM nutrisi melon saat berbuah?',
    'Bagaimana cara meningkatkan rasa manis (Brix) melon?',
    'Kapan melon siap panen?',
  ],
  hama_melon: [
    'Kenapa daun melon berbintik putih dan menggulung ke atas?',
    'Berapa suhu dan kelembapan ideal untuk melon?',
    'Kenapa air di penampung berlumut atau berbau?',
    'Bagaimana cara menjaga VPD greenhouse tetap stabil?',
  ],
  semai: [
    'Kenapa bibit melon mengambang saat direndam?',
    'Berapa jumlah benih yang sedang disemai sekarang?',
    'Bagaimana cara pindah tahap dari semai ke meja?',
    'Bagaimana cara nutrisi melon Naik Harian?',
  ],
  pindah_tahap: [
    'Bagaimana cara nutrisi melon Naik Harian?',
    'Bagaimana cara polinasi bunga melon?',
    'Cek status tahap tanam saat ini',
    'Berapa hari melon siap panen?',
  ],
  panen: [
    'Bagaimana cara meningkatkan rasa manis (Brix) melon?',
    'Bagaimana cara mencatat logbook kegiatan kebun?',
    'Bagaimana cara memulai semai batch baru?',
    'Apa saran dan langkah budidaya selanjutnya?',
  ],
  nutrisi_ab_mix: [
    'Bagaimana cara nutrisi melon Naik Harian?',
    'Apa perbedaan PPM dan EC serta cara konversinya?',
    'Bagaimana cara menurunkan pH air yang terlalu tinggi?',
    'Kenapa air di penampung berlumut atau ada endapan?',
  ],
  media_tanam: [
    'Bagaimana cara memulai semai benih melon?',
    'Bagaimana cara pindah tahap dari semai ke meja?',
    'Bagaimana ciri busuk akar Pythium dan pencegahannya?',
    'Bagaimana cara nutrisi melon Naik Harian?',
  ],
  durasi_sayuran: [
    'Kapan melon siap panen?',
    'Bagaimana cara nutrisi melon Naik Harian?',
    'Bagaimana cara memulai semai baru?',
  ],
  tanaman_buah: [
    'Bagaimana cara mengatasi bunga atau buah rontok?',
    'Bagaimana cara meningkatkan rasa manis (Brix) melon?',
    'Bagaimana cara polinasi bunga melon?',
  ],
  dosing: [
    'Cara kalibrasi sensor pH dan EC lewat website?',
    'Bagaimana cara memakai saklar aman dosing otomatis?',
    'Bagaimana cara nutrisi melon Naik Harian?',
    'Tampilkan status penampung dan dosing saat ini',
  ],
  saklar: [
    'Cara kalibrasi sensor pH dan EC lewat website?',
    'Bagaimana cara kerja pompa dosing otomatis GARAP?',
    'Tampilkan status penampung dan dosing saat ini',
  ],
  uji_lab: [
    'Cara kalibrasi sensor pH dan EC lewat website?',
    'Bagaimana cara meningkatkan rasa manis (Brix) melon?',
    'Bagaimana cara kerja saklar aman dosing otomatis?',
  ],
  alat_baru: [
    'Cara kalibrasi sensor pH dan EC lewat website?',
    'Tampilkan kondisi sensor kebun saat ini',
    'Bagaimana cara input data kebun secara berurutan?',
  ],
  input_data: [
    'Bagaimana cara memulai semai benih melon?',
    'Bagaimana cara nutrisi melon Naik Harian?',
    'Cara kalibrasi sensor pH dan EC lewat website?',
    'Tampilkan status tahap tanam saat ini',
  ],
  fitur: [
    'Cara kalibrasi sensor pH dan EC lewat website?',
    'Bagaimana cara nutrisi melon Naik Harian?',
    'Lakukan diagnosa menyeluruh kebun',
    'Apa alur kerja budidaya di GARAP?',
  ],
  alur: [
    'Bagaimana cara memulai semai benih melon?',
    'Bagaimana cara pindah tahap dari semai ke meja?',
    'Cara kalibrasi sensor pH dan EC lewat website?',
    'Bagaimana cara kerja pompa dosing otomatis GARAP?',
  ],
  logbook: [
    'Berapa jumlah benih yang sedang disemai sekarang?',
    'Ada peringatan atau alert gak hari ini?',
    'Lakukan diagnosa menyeluruh kebun',
  ],
  tim: [
    'Jelaskan semua fitur aplikasi GARAP',
    'Bagaimana alur kerja budidaya di aplikasi GARAP?',
    'Lakukan diagnosa menyeluruh kebun',
  ],
  fase: [
    'Apa keputusan keselamatan yang masih ditunggu?',
    'Cara kalibrasi sensor pH dan EC lewat website?',
    'Bagaimana cara kerja saklar aman dosing otomatis?',
  ],
  keputusan: [
    'Bagaimana cara kerja saklar aman dosing otomatis?',
    'Cara kalibrasi sensor pH dan EC lewat website?',
    'Bagaimana perkembangan fase sistem saat ini?',
  ],
  login_akses: [
    'Apa langkah harian petani di website GARAP dari awal sampai panen?',
    'Bagaimana cara mulai menyemai benih melon di GARAP?',
    'Apa arti lampu pilot dan pesan LCD pada panel alat IoT?',
    'Tampilkan kondisi sensor kebun saat ini',
  ],
  alat_iot_k3: [
    'Cara kalibrasi sensor pH dan EC lewat website?',
    'Bagaimana cara mengatasi bila website tidak bisa dibuka?',
    'Bagaimana cara memakai saklar aman dosing otomatis?',
    'Apa langkah harian petani di website GARAP?',
  ],
  langkah_petani: [
    'Bagaimana cara membuka website dan login akun GARAP?',
    'Apa arti lampu pilot dan pesan LCD pada panel alat IoT?',
    'Bagaimana cara memulai semai benih melon dari awal?',
    'Cara kalibrasi sensor pH dan EC lewat website?',
  ],
};

const SARAN_MATRIKS = {
  daun_bintik_putih_menggulung: [
    'Kenapa ujung daun melon kering atau terbakar?',
    'Berapa suhu dan kelembapan ideal untuk melon?',
    'Bagaimana cara mengatasi embun tepung pada daun?',
    'Tampilkan kondisi sensor kebun saat ini',
  ],
  hama_thrips: [
    'Kenapa daun melon berbintik putih dan menggulung ke atas?',
    'Berapa suhu dan kelembapan ideal agar hama terkendali?',
    'Kenapa ujung daun melon kering atau melengkung?',
  ],
  hama_kutu_kebul: [
    'Kenapa daun melon berbintik putih dan menggulung ke atas?',
    'Bagaimana cara menjaga sirkulasi dan VPD greenhouse?',
    'Kenapa bunga atau bakal buah melon rontok?',
  ],
  hama_tungau_merah: [
    'Berapa suhu dan kelembapan ideal untuk melon?',
    'Kenapa daun melon berbintik putih dan menggulung ke atas?',
    'Kenapa ujung daun melon kering atau terbakar?',
  ],
  hama_liriomyza: [
    'Kenapa daun melon berbintik putih dan menggulung ke atas?',
    'Bagaimana cara menjaga VPD greenhouse tetap stabil?',
    'Lakukan diagnosa menyeluruh kebun',
  ],
  penyakit_powdery_mildew: [
    'Berapa suhu dan kelembapan ideal untuk melon?',
    'Kenapa daun melon berbintik putih dan menggulung ke atas?',
    'Bagaimana cara menjaga VPD greenhouse tetap seimbang?',
  ],
  penyakit_downy_mildew: [
    'Berapa suhu dan kelembapan ideal untuk melon?',
    'Bagaimana cara mencegah embun tepung pada daun melon?',
    'Bagaimana cara menjaga VPD greenhouse tetap seimbang?',
  ],
  penyakit_gummy_stem: [
    'Bagaimana cara mencegah busuk akar Pythium di penampung air?',
    'Berapa suhu dan kelembapan ideal untuk melon?',
    'Kenapa air di penampung berlumut atau berbau?',
  ],
  penyakit_pythium_akar: [
    'Kenapa air di penampung berlumut atau berbau?',
    'Berapa suhu air di penampung ideal untuk melon?',
    'Bagaimana kompensasi suhu air pada pembacaan sensor EC?',
  ],
  iklim_ideal_melon: [
    'Kenapa ujung daun melon kering atau terbakar?',
    'Bagaimana cara meningkatkan rasa manis (Brix) melon?',
    'Bagaimana cara menjaga VPD greenhouse tetap seimbang?',
    'Tampilkan kondisi sensor suhu dan kelembapan sekarang',
  ],
  iklim_vpd_manajemen: [
    'Berapa suhu dan kelembapan ideal untuk melon?',
    'Kenapa ujung daun melon kering atau melengkung?',
    'Kenapa bunga atau bakal buah melon rontok?',
  ],
  iklim_heat_stress: [
    'Berapa suhu dan kelembapan ideal untuk melon?',
    'Bagaimana cara mencegah busuk akar Pythium saat air panas?',
    'Kenapa ujung daun melon kering atau terbakar?',
  ],
  kompensasi_suhu_atc: [
    'Apa perbedaan PPM dan EC serta cara konversinya?',
    'Cara kalibrasi sensor pH dan EC lewat website?',
    'Berapa suhu air di penampung ideal untuk melon?',
  ],
  melon_manis_brix: [
    'Bagaimana cara nutrisi melon Naik Harian?',
    'Bagaimana cara polinasi dan seleksi buah melon?',
    'Kapan melon siap panen?',
    'Kenapa bunga atau bakal buah melon rontok?',
  ],
  perbedaan_ppm_ec: [
    'Bagaimana cara nutrisi melon Naik Harian?',
    'Cara kalibrasi sensor pH dan EC lewat website?',
    'Bagaimana kompensasi suhu air (ATC) mempengaruhi EC?',
  ],
  sanitasi_tandon_lumut: [
    'Bagaimana cara mencegah busuk akar Pythium di penampung air?',
    'Bagaimana cara melarutkan pekatan AB Mix tanpa endapan?',
    'Cara kalibrasi sensor pH dan EC lewat website?',
  ],
  bunga_buah_melon_masalah: [
    'Bagaimana cara polinasi bunga melon yang benar?',
    'Bagaimana cara meningkatkan rasa manis (Brix) melon?',
    'Bagaimana cara nutrisi melon Naik Harian?',
  ],
  ujung_daun_kering_melon: [
    'Berapa suhu dan kelembapan ideal untuk melon?',
    'Apa perbedaan PPM dan EC serta cara konversinya?',
    'Bagaimana cara nutrisi melon Naik Harian?',
  ],
  darurat_pompa_mati: [
    'Bagaimana cara mencegah busuk akar Pythium saat sirkulasi berhenti?',
    'Tampilkan status penampung dan dosing saat ini',
    'Ada peringatan atau alert gak hari ini?',
  ],
  semai_bawang_merah_kain_hitam: [
    'Bagaimana cara menanam melon di GARAP dari awal?',
    'Bagaimana cara nutrisi melon Naik Harian?',
    'Berapa jumlah benih yang sedang disemai sekarang?',
    'Berapa suhu dan kelembapan ideal untuk melon?',
  ],
};

const SARAN_NIAT = {
  diagnosa: [
    'Bagaimana cara menurunkan pH air jika terlalu tinggi?',
    'Bagaimana cara nutrisi melon Naik Harian?',
    'Tampilkan status penampung dan dosing saat ini',
    'Cara kalibrasi sensor pH dan EC lewat website?',
  ],
  sensor: [
    'Cara kalibrasi sensor pH dan EC lewat website?',
    'Berapa suhu dan kelembapan ideal untuk melon?',
    'Lakukan diagnosa menyeluruh kebun',
    'Ada peringatan atau alert gak hari ini?',
  ],
  alert: [
    'Lakukan diagnosa menyeluruh kebun',
    'Tampilkan kondisi sensor kebun saat ini',
    'Tampilkan status penampung dan dosing saat ini',
  ],
  penampung: [
    'Bagaimana cara kerja pompa dosing otomatis GARAP?',
    'Kenapa air di penampung berlumut atau berubah keruh?',
    'Bagaimana cara nutrisi melon Naik Harian?',
  ],
  tahap: [
    'Bagaimana cara pindah tahap dari semai ke meja?',
    'Bagaimana cara nutrisi melon Naik Harian?',
    'Kapan melon siap panen?',
    'Bagaimana cara meningkatkan rasa manis (Brix) melon?',
  ],
  ph_turun: [
    'Berapa target pH dan nutrisi PPM melon?',
    'Cara kalibrasi sensor pH dan EC lewat website?',
    'Bagaimana jika pH tinggi mengunci penyerapan nutrisi?',
  ],
  ph_naik: [
    'Berapa target pH dan nutrisi PPM melon?',
    'Cara kalibrasi sensor pH dan EC lewat website?',
    'Bagaimana cara nutrisi melon Naik Harian?',
  ],
  tds_turun: [
    'Apa perbedaan PPM dan EC serta cara konversinya?',
    'Bagaimana cara nutrisi melon Naik Harian?',
    'Cara kalibrasi sensor pH dan EC lewat website?',
  ],
  tds_naik: [
    'Apa perbedaan PPM dan EC serta cara konversinya?',
    'Bagaimana cara nutrisi melon Naik Harian?',
    'Cara kalibrasi sensor pH dan EC lewat website?',
  ],
  preset: [
    'Bagaimana cara nutrisi melon Naik Harian?',
    'Apa perbedaan PPM dan EC serta cara konversinya?',
    'Bagaimana cara meningkatkan rasa manis (Brix) melon?',
  ],
};

function saranDariKataPesan(pesan) {
  const s = normalisasi(pesan);
  if (/\b(?:ph|asam|basa|ph down|ph up)\b/.test(s)) {
    return [
      'Bagaimana cara menurunkan pH air yang terlalu tinggi?',
      'Cara kalibrasi sensor pH dan EC lewat website?',
      'Bagaimana cara nutrisi melon Naik Harian?',
      'Kenapa nutrisi mengendap saat pH tidak stabil?',
    ];
  }
  if (/\b(?:tds|ppm|ec|nutrisi|ab mix|pupuk|pekat|encer)\b/.test(s)) {
    return [
      'Bagaimana cara nutrisi melon Naik Harian?',
      'Apa perbedaan PPM dan EC serta cara konversinya?',
      'Cara kalibrasi sensor pH dan EC lewat website?',
      'Bagaimana cara meningkatkan rasa manis (Brix) melon?',
    ];
  }
  if (/\b(?:suhu|panas|dingin|kelembap\w*|lembap|vpd|iklim|udara)\b/.test(s)) {
    return [
      'Berapa suhu dan kelembapan ideal untuk melon?',
      'Bagaimana cara mencegah busuk akar Pythium saat air panas?',
      'Kenapa ujung daun melon kering atau terbakar?',
      'Tampilkan kondisi sensor kebun saat ini',
    ];
  }
  if (/\b(?:daun|hama|jamur|bintik|keriting|kuning|layu|busuk|akar|kutu|tungau|thrips)\b/.test(s)) {
    return [
      'Kenapa daun melon berbintik putih dan menggulung ke atas?',
      'Bagaimana ciri busuk akar Pythium dan pencegahannya?',
      'Berapa suhu dan kelembapan ideal untuk melon?',
      'Kenapa ujung daun melon kering atau terbakar?',
    ];
  }
  if (/\b(?:brix|manis|buah|bunga|polinasi|panen|melon)\b/.test(s)) {
    return [
      'Bagaimana cara meningkatkan rasa manis (Brix) melon?',
      'Bagaimana cara polinasi bunga melon?',
      'Kapan melon siap panen?',
      'Berapa jumlah benih yang sedang disemai sekarang?',
    ];
  }
  if (/\b(?:semai|benih|bibit|tahap|pindah|meja|batch)\b/.test(s)) {
    return [
      'Berapa jumlah benih yang sedang disemai sekarang?',
      'Bagaimana cara pindah tahap dari semai ke meja?',
      'Bagaimana cara nutrisi melon Naik Harian?',
      'Kapan melon siap panen?',
    ];
  }
  if (/\b(?:kalibrasi|mqtt|esp|alat|sensor|pompa|dosing|tandon)\b/.test(s)) {
    return [
      'Cara kalibrasi sensor pH dan EC lewat website?',
      'Kenapa air di penampung berlumut atau berubah keruh?',
      'Tampilkan status penampung dan dosing saat ini',
      'Lakukan diagnosa menyeluruh kebun',
    ];
  }
  return [
    'Berapa jumlah benih yang sedang disemai sekarang?',
    'Bagaimana cara nutrisi melon Naik Harian?',
    'Berapa suhu dan kelembapan ideal untuk melon?',
    'Lakukan diagnosa menyeluruh kebun',
  ];
}

function saranMatriks(id) {
  if (SARAN_MATRIKS[id]) return SARAN_MATRIKS[id];
  if (String(id).startsWith('defisiensi_') || id === 'antagonisme_hara' || id === 'ec_drainase_runoff') {
    return [
      'Berapa target pH dan nutrisi PPM melon?',
      'Apa perbedaan PPM dan EC serta cara konversinya?',
      'Bagaimana cara nutrisi melon Naik Harian?',
      'Kenapa ujung daun melon kering atau terbakar?',
    ];
  }
  return [
    'Bagaimana cara nutrisi melon Naik Harian?',
    'Berapa suhu dan kelembapan ideal untuk melon?',
    'Lakukan diagnosa menyeluruh kebun',
  ];
}

function terlaluMirip(calon, pesanNorm) {
  const c = normalisasi(calon);
  if (!c || !pesanNorm) return false;
  if (c === pesanNorm || pesanNorm.includes(c) || c.includes(pesanNorm)) return true;
  const kataC = new Set(c.split(' ').filter((w) => w.length > 2));
  const kataP = new Set(pesanNorm.split(' ').filter((w) => w.length > 2));
  if (!kataC.size || !kataP.size) return false;
  let sama = 0;
  for (const w of kataC) if (kataP.has(w)) sama += 1;
  return sama / Math.min(kataC.size, kataP.size) >= 0.75;
}

/**
 * Bangun daftar maksimal 4 rekomendasi pertanyaan lanjutan yang berbeda-beda sesuai
 * konteks pertanyaan, jalur jawaban, serta kondisi kebun saat ini.
 */
function saranPertanyaan({ pesan = '', jalur = 'umum', kunci = null, data = null } = {}) {
  let dasar;
  if (jalur === 'panduan') {
    dasar = SARAN_PANDUAN[kunci] || saranDariKataPesan(pesan);
  } else if (jalur === 'matriks') {
    dasar = saranMatriks(kunci);
  } else if (jalur === 'niat') {
    dasar = SARAN_NIAT[kunci] || saranDariKataPesan(pesan);
  } else if (jalur === 'sapaan') {
    const aktif = (data?.tahap || []).find((x) => x.status === 'berjalan');
    dasar = [
      aktif ? `Bagaimana nutrisi melon di tahap ${aktif.tahap} hari ini?` : 'Bagaimana cara memulai semai benih melon?',
      'Kapan melon siap panen?',
      'Cara kalibrasi sensor pH dan EC lewat website?',
      'Lakukan diagnosa menyeluruh kebun',
    ];
  } else {
    dasar = saranDariKataPesan(pesan);
  }

  const adaAlert = Number(data?.alert?.total || 0) > 0;
  const kandidat = [...dasar];
  // Sisipkan konteks kebun nyata jika relevan (tanpa mendominasi setiap jawaban)
  if (adaAlert && kunci !== 'alert' && kunci !== 'diagnosa') {
    kandidat.splice(Math.min(2, kandidat.length), 0, 'Ada peringatan atau alert gak hari ini?');
  } else if (jalur !== 'niat' && jalur !== 'panduan' && !(data?.sensor)) {
    kandidat.push('Cara kalibrasi sensor pH dan EC lewat website?');
  }

  const pesanNorm = normalisasi(pesan);
  const unik = [];
  const sudah = new Set();
  for (const item of kandidat) {
    const clean = String(item || '').trim();
    if (!clean) continue;
    const key = normalisasi(clean);
    if (sudah.has(key) || terlaluMirip(clean, pesanNorm)) continue;
    sudah.add(key);
    unik.push(clean);
    if (unik.length >= 4) break;
  }
  return unik;
}

module.exports = {
  saranPertanyaan,
  SARAN_PANDUAN,
  SARAN_MATRIKS,
  SARAN_NIAT,
};
