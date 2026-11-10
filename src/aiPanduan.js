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

const STATUS_DIPERBARUI = '4 Nov 2026';

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
    'Langkah menyemai melon (memulai batch baru):',
    'Persiapan: media semai dan benih siap, penampung berisi air, sensor mengirim data (cek Dashboard). Target nutrisi tanaman diatur di Pengaturan Nutrisi bila ingin naik harian.',
    '1. Masuk sebagai admin, buka menu Kebun Saya.',
    '2. Tekan "Mulai Semai Baru" (juga ada di Dashboard).',
    '3. Pilih tanaman, atur tanggal mulai semai, isi jumlah benih, dan boleh menambah keterangan singkat.',
    '4. Simpan. Batch muncul di daftar dengan tahap Semai dan hitungan "Hari ke-X dari Y".',
    '5. Selama semai, pantau pH dan nutrisi di Dashboard; peringatan muncul di menu Peringatan.',
    '6. Saat umurnya cukup, batch bertanda "Siap pindah"; lanjut ke tahap Peremajaan (tanya "cara pindah tahap").',
    'Catatan: saat ini hanya admin yang bisa memulai semai. Petani memantau batch dan target nutrisi di Kebun Saya. Kalau petani perlu memulai semai sendiri, itu keputusan pemilik.',
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

  durasi_melon: [
    'Panduan Masa Tanam Melon Hingga Siap Makan / Panen:',
    '• Jika Anda mulai menanam melon (semai benih) besok, buah melon rata-rata siap dipanen dan dimakan dalam 60 hingga 75 hari setelah tanam (HST), atau sekitar 2 hingga 2,5 bulan (tergantung varietas seperti Golden Aroma, Inthanon, atau Rock Melon).',
    '',
    'Jadwal dan fase pertumbuhannya:',
    '1. Tahap Semai (Hari ke 1–14): Benih berkecambah di rockwool/tray hingga tumbuh 2–3 helai daun sejati (nutrisi 400–600 PPM).',
    '2. Tahap Peremajaan / Vegetatif (Hari ke 15–28): Pembentukan batang dan tajuk daun yang kokoh (nutrisi 800–1000 PPM).',
    '3. Tahap Pembungaan & Polinasi (Hari ke 28–35): Bunga betina mekar di ruas ke-9 s/d 12. Lakukan penyerbukan/polinasi buatan di pagi hari (pukul 07.00–10.00).',
    '4. Tahap Pembesaran Buah & Netting (Hari ke 35–55): Jaring (net) mulai terbentuk sempurna. Seleksi 1 buah terbaik per pohon dan gantung buah (nutrisi 1200–1800 PPM).',
    '5. Tahap Pematangan (Hari ke 60–75): Buah mengeluarkan aroma harum khas melon, jaring rapat tebal, tangkai retak melingkar, dan daun bendera menguning. Pada fase ini kurangi penyiraman agar kadar gula (Brix) manis maksimal (12–15+). Melon siap dipetik dan dinikmati!',
  ].join('\n'),

  nutrisi_melon: [
    'Panduan Target Nutrisi AB Mix & pH untuk Melon Hidroponik:',
    '• pH Air Ideal: 5,8 – 6,5 (menjamin penyerapan unsur hara mikro dan makro optimal).',
    '• Tahap Semai: 400 – 600 PPM (EC 0,8 – 1,2 mS/cm).',
    '• Tahap Vegetatif / Peremajaan: 800 – 1.000 PPM (EC 1,6 – 2,0 mS/cm).',
    '• Tahap Pembungaan / Polinasi: 1.000 – 1.200 PPM (EC 2,0 – 2,4 mS/cm).',
    '• Tahap Pembesaran Buah (Netting): 1.400 – 1.800 PPM (EC 2,8 – 3,6 mS/cm).',
    '• Tahap Pematangan (10 hari sebelum panen): Turunkan kembali ke 800–1000 PPM dan kurangi air agar rasa buah manis pekat (Brix tinggi).',
  ].join('\n'),

  polinasi_melon: [
    'Panduan Polinasi (Penyerbukan) & Pemangkasan Melon:',
    '1. Penyerbukan Buatan (Polinasi): Dilakukan saat bunga betina (memiliki bakal buah bulat kecil di bawah kelopak) mekar, biasanya di ruas ke-9 hingga ke-12.',
    '2. Waktu Terbaik: Pagi hari pukul 07.00 – 10.00 saat serbuk sari jantan masih segar dan putik betina reseptif.',
    '3. Cara: Petik bunga jantan yang mekar sempurna, buang kelopak mahkotanya, lalu oleskan kepala sari jantan ke kepala putik betina secara merata.',
    '4. Pemangkasan (Pruning): Buang semua tunas air di bawah ruas ke-8. Di atas ruas tempat buah dipelihara, sisakan 2–3 helai daun lalu pangkas pucuk cabangnya.',
    '5. Seleksi Buah: Setelah bakal buah sebesar telur ayam, pilih 1 buah yang paling bulat simetris dan sehat, lalu buang calon buah lainnya.',
  ].join('\n'),

  hama_melon: [
    'Panduan Penanganan Hama, Penyakit, & Daun Keriting/Kuning Hidroponik:',
    '1. Daun Keriting & Menguning (Melon / Cabai):',
    '   • Penyebab Utama: Hama pengisap seperti Kutu Kebul (Bemisia tabaci), Thrips, atau Tungau (Mites) yang menyebarkan virus gemini.',
    '   • Penanganan Segera: Pasang perangkap lekat kuning (yellow sticky trap) di sekitar meja tanam setinggi tajuk tanaman. Semprot minyak nimba (neem oil) 3-5 mililiter/liter air atau pestisida nabati pada sore hari di bagian bawah daun.',
    '   • Periksa pH & EC: Daun menguning (klorosis) juga bisa disebabkan defisiensi zat besi/magnesium akibat pH air tandon terlalu tinggi (>6.8). Sesuaikan pH ke 5.8–6.5.',
    '2. Embun Tepung (Powdery Mildew):',
    '   • Daun tampak bercak serbuk putih kelabu. Jaga sirkulasi udara greenhouse dengan exhaust fan dan semprot fungisida hayati (Trichoderma).',
    '3. Busuk Akar (Pythium) & Layu:',
    '   • Akar kecokelatan berbau busuk, tanaman layu saat terik matahari. Solusi: sanitasi instalasi tandon, jaga suhu air di bawah 28°C, dan tambahkan aerasi oksigen terlarut (DO tinggi).',
  ].join('\n'),

  tanaman_buah: [
    'Panduan Budidaya Tanaman Buah Hidroponik (Cabai, Tomat, Stroberi):',
    '• Cabai Hidroponik: Masa panen 75–90 HST. Kebutuhan PPM bertahap: vegetatif 800–1200 PPM, berbunga & berbuah 1500–2000 PPM (pH 5.8–6.5). Pastikan pencahayaan cukup dan pasang perangkap kuning untuk mencegah kutu kebul.',
    '• Tomat / Tomat Cherry: Masa panen 70–85 HST. Kebutuhan PPM: 1400–2200 PPM (pH 5.5–6.5). Lakukan pemangkasan tunas air (pruning) dan ikat batang rambatan.',
    '• Stroberi Hidroponik: Masa panen 60–80 HST. Kebutuhan PPM: 800–1200 PPM (pH 5.5–6.2). Suhu lingkungan sejuk (<25°C) sangat mendukung pembungaan dan rasa manis buah.',
  ].join('\n'),

  nutrisi_ab_mix: [
    'Panduan Pembuatan & Penggunaan Pupuk AB Mix Hidroponik:',
    '1. Komposisi: Pekatan A berisi Kalsium Nitrat & Zat Besi (Fe-EDTA). Pekatan B berisi Kalium, Fosfat, Sulfat, Magnesium, dan Unsur Mikro.',
    '2. ATURAN PENTING: JANGAN PERNAH mencampur pekatan A dan pekatan B dalam keadaan pekat langsung! Jika dicampur pekat, Kalsium akan bereaksi dengan Sulfat membentuk Kalsium Sulfat (endapan putih tidak larut) sehingga nutrisi rusak/tidak bisa diserap tanaman.',
    '3. Cara Melarutkan ke Tandon: Masukkan air baku ke tandon > tuang pekatan A > aduk hingga rata > baru tuang pekatan B > aduk rata > ukur nilai PPM dan pH dengan TDS meter.',
  ].join('\n'),

  media_tanam: [
    'Panduan Media Tanam & Cara Semai Hidroponik:',
    '1. Rockwool: Potong kubus ukuran 2,5 x 2,5 cm, basahi dengan air baku (air netral tanpa nutrisi) sampai lembap tidak menggenang.',
    '2. Lubangi sedalam 0,5 cm, masukkan 1 benih per kotak.',
    '3. Tutup nampan semai di tempat gelap selama 24–48 jam hingga berkecambah (pecah benih/sprout).',
    '4. Begitu muncul daun kecambah (daun kotiledon), segera kenalkan ke sinar matahari pagi agar tidak kutilang (kurus tinggi langsing).',
    '5. Setelah daun sejati muncul (biasanya umur 7-10 hari), mulai berikan nutrisi AB Mix 300–500 PPM hingga siap pindah ke meja tanam.',
  ].join('\n'),

  durasi_sayuran: [
    'Panduan Masa Panen Sayuran Daun Hidroponik:',
    '• Selada (Lettuce): 30 – 40 hari setelah tanam (PPM 600–800, pH 5.8–6.5).',
    '• Pakcoy / Sawi Sendok: 30 – 35 hari setelah tanam (PPM 800–1000, pH 5.8–6.5).',
    '• Kangkung: 21 – 25 hari setelah tanam (PPM 800–1200, pH 6.0–6.8). Cepat panen!',
    '• Bayam Hijau / Merah: 25 – 30 hari setelah tanam (PPM 800–1200, pH 6.0–7.0).',
    '• Seledri: 45 – 60 hari setelah tanam (PPM 800–1200, pH 6.0–6.5).',
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

  saklar: [
    'Cara memakai Saklar:',
    '1. Admin buka menu Saklar. Tiap aktuator (Nutrisi A+B, pH Up, pH Down, Pengenceran, Isi air) punya tombol ON/OFF.',
    '2. OFF = otomasi (preset, jadwal) tidak boleh menyalakan aktuator itu. Nutrisi Manual tetap boleh (override manual).',
    '3. Setiap perubahan tercatat di Catatan Aktivitas (siapa, kapan, dari/ke) dan tampil di Dashboard.',
  ].join('\n'),

  nutrisi_manual: [
    'Cara memakai Nutrisi Manual:',
    '1. Admin buka menu Nutrisi Manual, pilih zat (Nutrisi A, Nutrisi B, pH Up, pH Down).',
    '2. Isi volume (mL) atau durasi (detik), lalu tekan Dosing.',
    '3. Server memeriksa batas per sekali dosing, jeda minimum, jatah harian, LOCK, dan E-STOP.',
    '4. Saat ini pompa dari aplikasi masih DIKUNCI: permintaan yang lolos dicatat "gagal" dan tidak ada pompa menyala. Tambahkan nutrisi secara manual di lapangan.',
  ].join('\n'),

  uji_lab: [
    'Cara mencatat Uji Lab hasil panen:',
    '1. Buka menu Data, tab Uji Lab.',
    '2. Pilih Buah (bawaan untuk melon) atau Sayur.',
    '3. Isi parameter yang diukur (pH, EC/PPM, brix, ukuran, bobot) dan tanggal, lalu Simpan hasil.',
    '4. Riwayat dan grafik per parameter ada di halaman yang sama.',
  ].join('\n'),

  input_data: [
    'Urutan lengkap cara input data di aplikasi GARAP dari awal untuk petani & pengelola:',
    '1. Input Jenis Tanaman & Siklus: Masuk ke menu Jenis Tanaman untuk mendaftarkan varietas melon, lalu atur lama hari tiap tahap (Semai, Peremajaan, Pendewasaan).',
    '2. Input Meja & Penampung: Buka menu Pengaturan Alat / Master Meja untuk mendaftarkan nomor meja hidroponik dan tandon nutrisi yang terhubung ke sensor.',
    '3. Input Ambang Sensor & Target Nutrisi: Buka menu Ambang Sensor untuk mengatur batas aman pH (5,8–6,5), PPM nutrisi, dan suhu air, serta buka menu Dosing untuk mengisi target nutrisi per tahap.',
    '4. Input Batch Tanam Baru (Mulai Menanam): Buka menu Kebun Saya (ikon tanaman di navigasi bawah), klik tombol "Mulai Semai Baru", pilih tanaman, tanggal semai, dan jumlah benih, lalu klik Simpan.',
    '5. Input Pindah Tahap & Panen: Saat umur melon bertambah dan muncul tanda "Siap Pindah", klik tombol pindah tahap (dari Semai ke Peremajaan, lalu ke Pendewasaan), dan catat hasil panen di menu Panen serta Uji Lab.',
  ].join('\n'),

  fitur: [
    'Daftar lengkap seluruh fitur Website & Aplikasi GARAP (Vertonik Smart Farm):',
    '1. Dashboard / Beranda Utama: Ringkasan kondisi kebun, bacaan sensor terakhir, status tandon air, dan pintasan cepat.',
    '2. Telemetri & Sensor: Grafik pantauan langsung pH air, nutrisi TDS/EC, suhu air tandon, serta suhu & kelembaban udara greenhouse.',
    '3. Kebun Saya & Tahap Tanam: Mengelola siklus hidup tanaman melon dari semai, peremajaan, pendewasaan, hingga panen.',
    '4. Dosing & Naik Harian: Mengatur preset target nutrisi per tahap, kenaikan target harian otomatis, dan rekomendasi pupuk AB Mix.',
    '5. Saklar & Nutrisi Manual: Mengatur izin pompa ON/OFF dan pencatatan suntik nutrisi manual.',
    '6. Kalibrasi & Ambang Sensor: Menyesuaikan akurasi sensor dengan cairan standar serta batas peringatan bahaya.',
    '7. Peringatan, Data Uji Lab, CCTV & Asisten AI: Deteksi masalah otomatis, pencatatan brix (rasa manis), pantauan kamera kebun, dan konsultasi cerdas dengan AI lokal Qwen.',
  ].join('\n'),

  logbook: 'Logbook kebun: ringkasan kegiatan 7 hari terakhir diambil dari data aplikasi.', // isi sebenarnya dibuat di routes/ai.js (aiLogbook)

  tim: [
    'Tim Vertonik Smart Farm (KKN Arutmin Asik 2026, Politeknik Negeri Tanah Laut, TRKJ):',
    '• Rivi Ramdani — Project Manager',
    '• Nova Atika Angelia — Finance',
    '• Putri Nadilatu Zahra — Secretary',
    '• Siti Azizahtusholihah — Creative & Public Relations',
    '• Muhammad Rizki Maulana — Backend Engineering',
    '• Muhammad Zainal Haqi — IoT Engineer',
    '• Eka Ridhoni August Firmansyah — Web & Application Developer',
    'Data lain (NIM, kontak) tidak disimpan di aplikasi, jadi tidak bisa saya jawab.',
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
  ['logbook', /\blog ?book\b|catatan kegiatan|riwayat kegiatan|kegiatan (?:terakhir|minggu ini|hari ini|kemarin)/],
  ['tim', /\b(?:anggota|biodata|bio data|profil tim|susunan tim)\b|\bsiapa\b.{0,20}\b(?:tim|anggota|pembuat|pengembang)\b/],
  ['durasi_melon', /\b(?:berapa hari|berapa lama|kapan|kapan saja)\b.{0,30}\b(?:siap (?:makan|panen|petik)|panen|bisa makan|bisa dipanen|umur panen|masa tanam)\b|\b(?:siap (?:makan|panen|petik)|panen)\b.{0,30}\b(?:berapa hari|berapa lama|kapan)\b|\b(?:umur|masa|durasi|lama)\b.{0,20}\b(?:panen|tanam|hidup)\b.{0,15}\bmelon\b|\bmelon\b.{0,25}\b(?:berapa hari|berapa lama|kapan|siap makan|siap panen)\b/],
  ['nutrisi_melon', /\b(?:nutrisi|ppm|tds|ec|ab mix|abmix|pupuk|dosis)\b.{0,25}\b(?:melon|tanaman buah)\b|\bmelon\b.{0,25}\b(?:nutrisi|ppm|tds|ec|ab mix|pupuk)\b|\btarget (?:ppm|nutrisi|tds)\b/],
  ['polinasi_melon', /\b(?:polinasi|penyerbukan|kawin|kawinkan|bunga betina|bunga jantan)\b|\b(?:pruning|pemangkasan|pangkas|tunas air|seleksi buah)\b/],
  ['tanaman_buah', /\b(?:cabai|cabe|tomat|stroberi|strawberry)\b/],
  ['durasi_sayuran', /\b(?:sayur|sayuran|selada|pakcoy|kangkung|bayam|sawi|seledri)\b.{0,25}\b(?:berapa hari|berapa lama|panen|masa tanam)\b|\b(?:berapa hari|berapa lama)\b.{0,25}\b(?:selada|pakcoy|kangkung|bayam|sawi)\b/],
  ['nutrisi_ab_mix', /\b(?:ab mix|abmix|campur nutrisi|larutan pekatan|pekatan a|pekatan b|cara buat nutrisi|cara melarutkan|endapan)\b/],
  ['media_tanam', /\b(?:rockwool|rokbul|media tanam|cocopeat|hidroton|netpot|kutilang|pecah benih|biji kecambah)\b/],
  ['hama_melon', /\b(?:hama|penyakit|kutu kebul|thrips|tungau|ulat|jamur|keriting|kuning|menguning|embun tepung|busuk akar|pythium|layu)\b/],
  ['input_data', /\b(?:cara|langkah|bagaimana|gimana|panduan|urutan)\b.{0,25}\b(?:input|masukkan|memasukkan|mengisi|isi|tambah|menambah)\b.{0,20}\bdata\b|\binput data\b|\bisi data\b/],
  ['fitur', /\b(?:semua|seluruh|daftar|apa saja)\b.{0,20}\b(?:fitur|menu|halaman)\b|\b(?:fitur|menu)\b.{0,20}\b(?:aplikasi|website|web|garap|lengkap)\b|\bjelaskan (?:semua )?fitur\b/],
  ['saklar', /\bsaklar\b/],
  ['nutrisi_manual', /\bnutrisi manual\b|\bdosing manual\b|\bmanual dosing\b/],
  ['uji_lab', /\buji lab\b|\bhasil lab\b|\bbrix\b/],
  ['fase', /\bfase\b|sudah sampai (?:mana|fase)|sampai (?:mana|fase)|status (?:proyek|pengembangan)|progres (?:proyek|pengembangan)/],
  ['keputusan', /\bkeputusan\b|belum diputuskan|menunggu (?:pemilik|keputusan)/],
  ['dosing', /\b(?:dosing|dosis|pompa nutrisi)\b.{0,20}\b(?:otomatis|aktif|jalan|menyala)\b|\bnutrisi otomatis\b|kenapa (?:dosing|pompa)/],
  ['alat_baru', /\balat\b.{0,20}\b(?:baru|belum ada|belum terpasang)\b|\b(?:pasang|memasang|pemasangan|konfigurasi|mengonfigurasi|menyambung\w*|menghubung\w*)\b.{0,20}\b(?:alat|sensor|esp32|mqtt)\b|\bmqtt\b/],
  ['pindah_tahap', /\bpindah\w*\b.{0,15}\btahap\b|\bnaik tahap\b|\bsiap pindah\b|\bpeming?ndahan\b.{0,10}\btahap\b/],
  ['panen', /\b(?:cara|langkah|bagaimana|gimana)\b.{0,25}\b(?:panen|memanen|mencatat panen)\b|\b(?:mencatat|catat)\b.{0,10}\bpanen\b/],
  ['semai', /\b(?:cara|langkah|bagaimana|gimana|mulai|memulai)\b.{0,30}\b(?:semai|menyemai|nyemai|menanam|tanam|batch|budidaya)\b|\b(?:semai|menyemai|nyemai|menanam)\b.{0,30}\b(?:cara|langkah|bagaimana|gimana)\b|\bmenyemai\b|\bsemai baru\b|\bcara menanam\b/],
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
  ambang: { to: '/ambang', label: 'Ambang Sensor', izin: ADMIN },
  kalibrasi: { to: '/kalibrasi', label: 'Kalibrasi', izin: ADMIN },
  dosing: { to: '/dosing', label: 'Dosing', izin: ADMIN },
  saklar: { to: '/saklar', label: 'Saklar', izin: ADMIN },
  nutrisiManual: { to: '/dosing-manual', label: 'Nutrisi Manual', izin: ADMIN },
  data: { to: '/data', label: 'Data', izin: ADMIN },
  pengaturanAlat: { to: '/pengaturan-alat', label: 'Pengaturan Alat', izin: ADMIN },
  mqtt: { to: '/mqtt-diagnostik', label: 'Diagnostik MQTT', izin: ADMIN },
};

const TAUTAN_TOPIK = {
  durasi_melon: ['tanam', 'semai', 'pendewasaan', 'panen'],
  nutrisi_melon: ['dosing', 'sensor', 'tanam'],
  polinasi_melon: ['tanam', 'pendewasaan'],
  hama_melon: ['peringatan', 'tanam', 'sensor'],
  durasi_sayuran: ['tanam', 'semai', 'panen'],
  tanaman_buah: ['tanam', 'sensor', 'dosing'],
  nutrisi_ab_mix: ['dosing', 'sensor', 'nutrisiManual'],
  media_tanam: ['semai', 'tanam'],
  alur: ['dashboard', 'tanam', 'sensor', 'peringatan'],
  semai: ['tanam', 'semai', 'tanaman'],
  pindah_tahap: ['tanam', 'semai', 'peremajaan', 'pendewasaan'],
  panen: ['tanam', 'panen'],
  alat_baru: ['sensor', 'ambang', 'kalibrasi', 'pengaturanAlat', 'mqtt'],
  dosing: ['dosing', 'saklar', 'peringatan'],
  saklar: ['saklar'],
  nutrisi_manual: ['nutrisiManual', 'saklar'],
  uji_lab: ['data'],
  input_data: ['tanam', 'tanaman', 'ambang', 'dosing', 'data'],
  fitur: ['dashboard', 'sensor', 'tanam', 'peringatan', 'dosing', 'saklar', 'kalibrasi', 'data'],
  logbook: [],
  tim: [],
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

/* ── TANGKAPAN LAYAR / SCREENSHOT RESMI GARAP ──────────────────────────────
 * Menyertakan gambar nyata dan alasan petani diarahkan ke layar tersebut agar
 * orang awam/petani tidak bingung dan tahu persis ke mana harus melangkah. */
const GAMBAR = {
  durasi_melon: [
    {
      url: '/panduan/tanam.png',
      judul: 'Layar Kebun Saya & Siklus Tanam',
      kenapa: 'Petani memantau hitungan hari melon (Hari ke-X) dan kemajuan fase pertumbuhan dari semai hingga siap panen.',
    },
  ],
  nutrisi_melon: [
    {
      url: '/panduan/dosing.png',
      judul: 'Pengaturan Target Nutrisi & Kenaikan Harian',
      kenapa: 'Petani melihat target PPM dan menaikkan dosis AB Mix harian sesuai fase tanaman.',
    },
    {
      url: '/panduan/sensor.png',
      judul: 'Pantauan Telemetri TDS & pH Realtime',
      kenapa: 'Melihat bacaan sensor nutrisi saat ini di tandon greenhouse.',
    },
  ],
  polinasi_melon: [
    {
      url: '/panduan/tanam.png',
      judul: 'Layar Tahap Pendewasaan & Buah',
      kenapa: 'Mencatat tanggal penyerbukan bunga betina di ruas ke-9 s/d 12 dan seleksi calon buah.',
    },
  ],
  hama_melon: [
    {
      url: '/panduan/beranda.png',
      judul: 'Peringatan & Status Kebun',
      kenapa: 'Memeriksa deteksi anomali suhu/kelembaban yang berpotensi memicu timbulnya hama dan jamur.',
    },
  ],
  durasi_sayuran: [
    {
      url: '/panduan/tanam.png',
      judul: 'Siklus Tanaman Sayuran',
      kenapa: 'Memantau waktu panen cepat sayuran daun.',
    },
  ],
  tanaman_buah: [
    {
      url: '/panduan/tanam.png',
      judul: 'Layar Kebun Saya & Tanaman Buah',
      kenapa: 'Memilih komoditas budidaya dan target siklus tanam cabai, tomat, dan melon.',
    },
  ],
  nutrisi_ab_mix: [
    {
      url: '/panduan/sensor.png',
      judul: 'Layar Telemetri & Sensor Nutrisi',
      kenapa: 'Memantau kenaikan PPM larutan nutrisi secara langsung di tandon.',
    },
  ],
  media_tanam: [
    {
      url: '/panduan/tanam.png',
      judul: 'Layar Semai & Pembibitan',
      kenapa: 'Pencatatan batch semai awal sebelum dipindahkan ke meja tanam.',
    },
  ],
  alur: [
    {
      url: '/panduan/beranda.png',
      judul: '1. Layar Beranda Utama (Dashboard)',
      kenapa: 'Petani diarahkan ke sini untuk melihat status greenhouse hari ini secara sekilas (kondisi tandon, sensor pH/TDS, dan peringatan penting).',
    },
    {
      url: '/panduan/tanam.png',
      judul: '2. Layar Kebun Saya & Tahap Tanam',
      kenapa: 'Petani diarahkan ke sini untuk melihat umur tanaman melon (hari ke-X), target nutrisi harian, dan tanda siap pindah tahap.',
    },
    {
      url: '/panduan/kontrol.png',
      judul: '3. Layar Kontrol Air & Saklar Pompa',
      kenapa: 'Petani diarahkan ke sini untuk memeriksa saklar pompa pengisian air tandon dan sirkulasi nutrisi.',
    },
  ],
  input_data: [
    {
      url: '/panduan/tanam.png',
      judul: 'Langkah Input: Formulir Mulai Tanam & Pindah Tahap',
      kenapa: 'Petani membuka menu Kebun Saya untuk mendaftarkan benih melon baru dan mencatat bibit yang tumbuh berhasil.',
    },
    {
      url: '/panduan/web-dashboard.png',
      judul: 'Pusat Manajemen Kebun (Dashboard Web)',
      kenapa: 'Admin mendaftarkan jenis tanaman melon, meja hidroponik, dan batas ambang sensor.',
    },
    {
      url: '/panduan/dosing.png',
      judul: 'Pengaturan Target Nutrisi & Kenaikan Harian',
      kenapa: 'Petani mengatur target kenaikan PPM nutrisi harian agar pupuk AB Mix bertambah stabil sesuai umur tanaman.',
    },
  ],
  fitur: [
    {
      url: '/panduan/beranda.png',
      judul: 'Menu Beranda (Ringkasan Kebun)',
      kenapa: 'Pusat pantauan cepat harian untuk petani dan pengelola.',
    },
    {
      url: '/panduan/tanam.png',
      judul: 'Menu Kebun Saya (Tahap Tanam)',
      kenapa: 'Memantau perkembangan melon dari semai, peremajaan, pendewasaan, hingga panen.',
    },
    {
      url: '/panduan/sensor.png',
      judul: 'Menu Sensor & Telemetri Realtime',
      kenapa: 'Melihat grafik pergerakan sensor pH, TDS, dan suhu air secara langsung.',
    },
    {
      url: '/panduan/kontrol.png',
      judul: 'Menu Kontrol Air & Saklar',
      kenapa: 'Melihat status pompa tandon dan aktuator solenoid valve.',
    },
    {
      url: '/panduan/ai.png',
      judul: 'Asisten AI GARAP',
      kenapa: 'Konsultasi cerdas kapan saja untuk diagnosa masalah daun atau dosis nutrisi.',
    },
  ],
  semai: [
    {
      url: '/panduan/tanam.png',
      judul: 'Menu Kebun Saya — Mulai Semai Baru',
      kenapa: 'Petani diarahkan ke tombol "Mulai Semai Baru" di menu Kebun Saya untuk mendaftarkan benih melon yang disemai.',
    },
  ],
  pindah_tahap: [
    {
      url: '/panduan/tanam.png',
      judul: 'Menu Kebun Saya — Pindah Tahap Tanam',
      kenapa: 'Ketika umur tanaman cukup dan muncul label "Siap pindah", petani menekan tombol untuk memindahkan melon ke meja peremajaan.',
    },
  ],
  panen: [
    {
      url: '/panduan/tanam.png',
      judul: 'Menu Kebun Saya — Pencatatan Panen',
      kenapa: 'Petani mencatat jumlah buah melon yang dipanen beserta hasil timbangan bobot dan rasa manis (brix).',
    },
  ],
  dosing: [
    {
      url: '/panduan/dosing.png',
      judul: 'Menu Pengaturan Target Nutrisi & Dosing',
      kenapa: 'Petani diarahkan ke sini untuk melihat target PPM nutrisi melon dan rekomendasi penambahan AB Mix.',
    },
  ],
  saklar: [
    {
      url: '/panduan/kontrol.png',
      judul: 'Menu Kontrol Air & Saklar Aktuator',
      kenapa: 'Petani memeriksa apakah pompa sirkulasi dan katup nutrisi dalam status aman (ON/OFF).',
    },
  ],
};

function jawabPanduan(kunci) {
  const jawaban = TEKS[kunci];
  if (!jawaban) return null;
  return { jawaban, tabel: [], status: undefined, gambar: GAMBAR[kunci] || [] };
}

/** Saran umum ("apa saran/rekomendasinya", "sebaiknya bagaimana", "langkah selanjutnya") → diarahkan ke diagnosa data nyata. */
function apakahMintaSaran(pesanTernormalisasi) {
  return /\b(?:saran|masukan|rekomendasi|langkah selanjutnya|langkah berikutnya)\b|\bapa (?:yang )?(?:harus|sebaiknya|perlu) (?:saya |aku |kami )?(?:lakukan|kerjakan)\b/.test(String(pesanTernormalisasi || ''));
}

module.exports = { deteksiPanduan, jawabPanduan, apakahMintaSaran, tautanUntuk, PATH_SAH, HALAMAN, TAUTAN_TOPIK, STATUS_DIPERBARUI, TEKS, GAMBAR };
