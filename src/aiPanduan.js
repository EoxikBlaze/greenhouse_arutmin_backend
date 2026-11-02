'use strict';
/**
 * PANDUAN APLIKASI untuk asisten AI lokal — jawaban TETAP, tanpa LLM.
 *
 * Model kecil (qwen2.5:1.5b) sering mengarang langkah dan nama menu. Pertanyaan tentang cara memakai aplikasi,
 * status pengembangan, dan keputusan yang menunggu dijawab dari teks yang ditulis di sini, jadi isinya bisa
 * ditinjau dan diuji. Angka kondisi kebun TIDAK ada di sini (itu tugas data langsung).
 *
 * PERAWATAN: ubah teks di bawah bila alur aplikasi berubah. Tanggal status ada di STATUS_DIPERBARUI.
 */

const STATUS_DIPERBARUI = '2 Nov 2026';

const TEKS = {
  alur: [
    'Alur GARAP secara singkat:',
    '1. Alat sensor (ESP32) mengukur pH, nutrisi (TDS), dan suhu di tandon, lalu mengirimnya ke server.',
    '2. Server menyimpan bacaan dan menampilkannya di Dashboard dan Telemetri & Sensor. Bila nilai keluar dari batas aman, muncul peringatan.',
    '3. Tanaman melewati empat tahap: Semai → Peremajaan → Pendewasaan → Panen. Admin memulai semai dan memindahkan tahap; petani memantau di Kebun Saya.',
    '4. Nutrisi: sistem hanya menyarankan. Pompa dosing otomatis sengaja dimatikan sampai alat dan keputusan keselamatan siap.',
    'Tanyakan "cara menyemai", "cara pindah tahap", "cara panen", atau "alat baru" untuk langkah rincinya.',
  ].join('\n'),

  semai: [
    'Cara menyemai (memulai batch baru) di aplikasi:',
    '1. Masuk sebagai admin, buka menu Tanam (Kebun Saya).',
    '2. Tekan "Mulai Semai Baru" (juga ada di Dashboard).',
    '3. Pilih tanaman, pilih meja tanam, atur tanggal mulai semai, isi jumlah benih, dan boleh menambah keterangan singkat.',
    '4. Simpan. Batch muncul di daftar tanam dengan tahap Semai dan hitungan "Hari ke-X dari Y".',
    'Catatan: saat ini hanya admin yang bisa memulai semai. Petani memantau batch dan target nutrisi di Kebun Saya. Kalau petani perlu memulai semai sendiri, itu keputusan pemilik.',
    'Siapkan juga: meja kosong untuk batch itu, dan target nutrisi tanaman (halaman Jenis Tanaman) bila ingin target naik harian.',
  ].join('\n'),

  pindah_tahap: [
    'Cara memindahkan tahap tanam:',
    '1. Di daftar tanam, batch yang umurnya cukup bertanda "Siap pindah ke ...".',
    '2. Admin membuka halaman tahapnya (Semai, Peremajaan, atau Pendewasaan) dan memindahkan batch ke tahap berikutnya, mencatat jumlahnya.',
    '3. Tahap berikutnya mulai berhitung dari hari pemindahan.',
    'Catatan: durasi tahap diambil dari pengaturan aplikasi. Kalau tertulis "durasi tahap belum diatur", minta admin mengisinya.',
  ].join('\n'),

  panen: [
    'Cara mencatat panen:',
    '1. Pastikan batch sudah di tahap Pendewasaan dan siap dipanen.',
    '2. Admin membuka halaman Panen dan mencatat batch serta jumlah yang dipetik.',
    '3. Hasilnya masuk hitungan "Tanaman dipanen" di Dashboard dan laporan.',
  ].join('\n'),

  alat_baru: [
    'Bila alat sensor belum ada atau baru dipasang:',
    '1. Siapkan server (Raspberry Pi) dan pasang aplikasi GARAP.',
    '2. Admin mengisi data dasar: meja/penampung, jenis tanaman, dan batas aman sensor.',
    '3. Daftarkan alat dan buat kuncinya di server (satu kunci rahasia per alat). Jangan bagikan kunci itu.',
    '4. Nyalakan broker MQTT di server, lalu isi firmware ESP32 (Wi-Fi, alamat server, kunci, nomor meja) dan unggah.',
    '5. Kalibrasi sensor dengan cairan standar supaya angkanya benar.',
    '6. Buka Telemetri & Sensor: bila status "Alat mengirim data" dan angka berubah, alat sudah terhubung.',
    'Selama alat belum mengirim data, Dashboard menulis bahwa alat tidak mengirim data dan angka yang tampil adalah bacaan lama.',
  ].join('\n'),

  dosing: [
    'Soal dosing nutrisi otomatis:',
    '• Aplikasi sudah bisa membuat usulan dosing, dan petani/admin bisa menyetujui, menolak, atau mencabutnya.',
    '• Pompa belum dijalankan oleh aplikasi. Eksekusi dosing sengaja dikunci (gerbang keselamatan) sampai alat, kalibrasi pompa, dan keputusan keselamatan siap.',
    '• Jadi untuk saat ini nutrisi ditambahkan manual sesuai saran di aplikasi. Aplikasi hanya memberi saran dan tidak menyalakan pompa.',
  ].join('\n'),

  keputusan: [
    `Keputusan yang masih menunggu pemilik (per ${STATUS_DIPERBARUI}):`,
    'A. Boleh atau tidak pengaju dosing menyetujui sendiri usulannya.',
    'B. Siapa saja yang boleh melihat data dosing (cakupan akses baca).',
    'C. Kapan siklus dosing dianggap kedaluwarsa.',
    'D. Kapan persetujuan dicabut otomatis (invalidasi).',
    'E. Cara menangani versi preset yang sama dikirim dua kali.',
    'F. Cara menggolongkan overshoot (nutrisi melebihi target).',
    'G. Lama menunggu antar dosis dan masa berlaku persetujuan.',
    'Selain itu, sejumlah parameter keselamatan masih kosong dan perlu angka yang divalidasi pemilik. Saya tidak boleh mengarang angkanya.',
  ].join('\n'),

  fase: [
    `Posisi pengembangan (per ${STATUS_DIPERBARUI}):`,
    '• Fase 3A–3D selesai dan sudah di GitHub: dasar data siklus budidaya, layanan, alur persetujuan dosing, dan audit keamanan API.',
    '• Fase 3E–3F sudah dikerjakan dan di-commit di backend lokal (penahanan perintah dosis, ketahanan, kontrak API), belum di-push.',
    '• Fase 3G baru berupa kriteria penerimaan; 3H belum ada spesifikasi.',
    '• Aplikasi web dan mobile sudah punya mode terang/gelap dan tampilan lebih jelas saat alat mati.',
    '• Belum siap dosing fisik: gerbang eksekusi dikunci, firmware aktuator v0.3 belum ada, kalibrasi dan keputusan A–G belum selesai.',
    'Ringkasnya: perangkat lunak persetujuan sudah jauh, perangkat keras dan keputusan keselamatan belum.',
  ].join('\n'),
};

/** Pola pada teks yang SUDAH dinormalisasi (huruf kecil, tanpa diakritik). Urutan = prioritas. */
const POLA = [
  ['fase', /\bfase\b|sudah sampai (?:mana|fase)|sampai (?:mana|fase)|status (?:proyek|pengembangan)|progres (?:proyek|pengembangan)/],
  ['keputusan', /\bkeputusan\b|belum diputuskan|menunggu (?:pemilik|keputusan)/],
  ['dosing', /\b(?:dosing|dosis|pompa nutrisi)\b.{0,20}\b(?:otomatis|aktif|jalan|menyala)\b|\bnutrisi otomatis\b|kenapa (?:dosing|pompa)/],
  ['alat_baru', /\balat\b.{0,20}\b(?:baru|belum ada|belum terpasang)\b|\b(?:pasang|memasang|pemasangan|konfigurasi|mengonfigurasi|menyambung\w*|menghubung\w*)\b.{0,20}\b(?:alat|sensor|esp32|mqtt)\b|\bmqtt\b/],
  ['pindah_tahap', /\bpindah\w*\b.{0,15}\btahap\b|\bnaik tahap\b|\bsiap pindah\b|\bpeming?ndahan\b.{0,10}\btahap\b/],
  ['panen', /\b(?:cara|langkah|bagaimana|gimana)\b.{0,25}\b(?:panen|memanen|mencatat panen)\b|\b(?:mencatat|catat)\b.{0,10}\bpanen\b/],
  ['semai', /\b(?:cara|langkah|bagaimana|gimana|mulai|memulai)\b.{0,30}\b(?:semai|menyemai|nyemai|menanam|tanam|batch)\b|\b(?:semai|menyemai|nyemai)\b.{0,30}\b(?:cara|langkah|bagaimana|gimana)\b|\bmenyemai\b|\bsemai baru\b/],
  ['alur', /\balur\b|\bcara kerja\b|bagaimana (?:aplikasi|sistem|website|web) (?:ini )?(?:bekerja|jalan)|\b(?:panduan|tutorial)\b|\bcara (?:pakai|memakai|menggunakan)\b.{0,15}\b(?:aplikasi|website|web|garap)\b/],
];


/* ── TAUTAN: arah ke halaman aplikasi ─────────────────────────────────────────────────────────
 * Tautan TIDAK pernah ditulis model. Server memilih dari daftar tetap di bawah, menyaring menurut peran
 * (petani tidak ditawari halaman admin), lalu klien merender sebagai tombol internal. */
const PETANI = 'semua';
const ADMIN = 'admin';
const HALAMAN = {
  dashboard: { to: '/dashboard', label: 'Dashboard', izin: PETANI },
  tanam: { to: '/tanam', label: 'Kebun Saya', izin: PETANI },
  sensor: { to: '/sensor-realtime', label: 'Telemetri & Sensor', izin: PETANI },
  peringatan: { to: '/peringatan', label: 'Peringatan', izin: PETANI },
  semai: { to: '/semai', label: 'Semai', izin: ADMIN },
  peremajaan: { to: '/peremajaan', label: 'Peremajaan', izin: ADMIN },
  pendewasaan: { to: '/pendewasaan', label: 'Pendewasaan', izin: ADMIN },
  panen: { to: '/panen', label: 'Panen', izin: ADMIN },
  tanaman: { to: '/tanaman', label: 'Jenis Tanaman', izin: ADMIN },
  meja: { to: '/meja', label: 'Meja Tanaman', izin: ADMIN },
  ambang: { to: '/ambang', label: 'Ambang Sensor', izin: ADMIN },
  kalibrasi: { to: '/kalibrasi', label: 'Kalibrasi', izin: ADMIN },
  dosing: { to: '/dosing', label: 'Dosing', izin: ADMIN },
  saklar: { to: '/saklar', label: 'Saklar & Mode', izin: ADMIN },
  pengaturanAlat: { to: '/pengaturan-alat', label: 'Pengaturan Alat', izin: ADMIN },
  mqtt: { to: '/mqtt-diagnostik', label: 'Diagnostik MQTT', izin: ADMIN },
};

const TAUTAN_TOPIK = {
  alur: ['dashboard', 'tanam', 'sensor', 'peringatan'],
  semai: ['tanam', 'semai', 'tanaman', 'meja'],
  pindah_tahap: ['tanam', 'semai', 'peremajaan', 'pendewasaan'],
  panen: ['tanam', 'panen'],
  alat_baru: ['sensor', 'ambang', 'kalibrasi', 'pengaturanAlat', 'mqtt'],
  dosing: ['dosing', 'saklar', 'peringatan'],
  keputusan: [],
  fase: [],
  // jalur data langsung (deteksiNiat di aiDiagnosa.js)
  diagnosa: ['peringatan', 'sensor'],
  alert: ['peringatan'],
  penampung: ['dosing', 'sensor'],
  tahap: ['tanam'],
  sensor: ['sensor'],
  ph_turun: ['sensor', 'dosing'],
  ph_naik: ['sensor', 'dosing'],
  tds_turun: ['sensor', 'dosing'],
  tds_naik: ['sensor', 'dosing'],
  preset: ['tanaman', 'dosing'],
};

/** Daftar tautan [{label,to}] untuk topik & peran. Peran selain admin/demo = hanya halaman umum. */
function tautanUntuk(topik, level) {
  const pengelola = level === 'admin' || level === 'demo';
  return (TAUTAN_TOPIK[topik] || [])
    .map((k) => HALAMAN[k])
    .filter((h) => h && (h.izin === PETANI || pengelola))
    .map((h) => ({ label: h.label, to: h.to }));
}

const PATH_SAH = new Set(Object.values(HALAMAN).map((h) => h.to));

/** Kunci panduan untuk pesan (ternormalisasi), atau null. */
function deteksiPanduan(pesanTernormalisasi) {
  const s = String(pesanTernormalisasi || '');
  for (const [kunci, re] of POLA) if (re.test(s)) return kunci;
  return null;
}

function jawabPanduan(kunci) {
  const jawaban = TEKS[kunci];
  if (!jawaban) return null;
  return { jawaban, tabel: [], status: undefined };
}

/** Saran umum ("apa saran/rekomendasinya", "sebaiknya bagaimana") → diarahkan ke diagnosa data nyata. */
function apakahMintaSaran(pesanTernormalisasi) {
  return /\b(?:saran|masukan|rekomendasi)\b|\bapa (?:yang )?(?:harus|sebaiknya|perlu) (?:saya |aku |kami )?(?:lakukan|kerjakan)\b/.test(String(pesanTernormalisasi || ''));
}

module.exports = { deteksiPanduan, jawabPanduan, apakahMintaSaran, tautanUntuk, PATH_SAH, HALAMAN, TAUTAN_TOPIK, STATUS_DIPERBARUI, TEKS };
