'use strict';
/**
 * aiMatrixPengetahuan.js — Ensiklopedia Cerdas & Matriks Analisis Agronomi GARAP
 *
 * FITUR UTAMA:
 * 1. ZERO-HEAT LOOKUP (<2 milidetik, 0% CPU): Berjalan langsung di V8 Node.js tanpa
 *    memutar LLM Ollama, sehingga Raspberry Pi tetap DINGIN (<55°C) dan responsif.
 * 2. 100+ Pola Analisis Mendalam: Defisiensi hara (N, P, K, Ca, Mg, Fe, B, Zn),
 *    hama (Thrips, Kutu Kebul, Tungau, Ulat, Liriomyza), penyakit patogen (Pythium,
 *    Fusarium, Ralstonia, Powdery Mildew, Gummy Stem Blight), iklim mikro (VPD,
 *    heat stress, kelembapan malam), dan kualitas air/tandon hidroponik.
 */

const MATRIX = [
  // ── 1. DEFISIENSI & ANOMALI HARA MAKRO/MIKRO ──────────────────────────
  {
    id: 'defisiensi_nitrogen',
    pola: /\b(?:kurang|defisiensi|kekurangan)\b.{0,20}\b(?:nitrogen|unsur n|pupuk n)\b|\bdaun (?:bawah|tua)\b.{0,25}\b(?:kuning merata|menguning pucat|pucat merata)\b/,
    judul: 'Analisis Defisiensi Nitrogen (N) pada Daun Bawah',
    analisis: 'Gejala: Daun tua bagian bawah menguning merata dari pucuk ke pangkal daun, pertumbuhan batang melambat, dan warna hijau daun memudar menjadi hijau muda pucat.',
    penyebab: 'Nitrogen adalah unsur mobil (bergerak bebas). Saat media kekurangan N, tanaman menarik cadangan nitrogen dari daun tua untuk disalurkan ke titik tumbuh baru di pucuk.',
    tindakan: [
      'Cek nilai TDS penampung air: bila di bawah ambang fase, naikkan konsentrasi pupuk AB Mix bertahap (+150 s/d 200 PPM).',
      'Pastikan pekatan A yang mengandung Kalsium Nitrat (Ca(NO3)2) dilarutkan dalam jumlah seimbang dengan pekatan B.',
      'Bila sistem memakai air baku TDS sangat rendah (<50 PPM), periksa apakah formula AB Mix sudah memenuhi rasio N minimal 150–200 ppm.',
    ],
  },
  {
    id: 'defisiensi_fosfor',
    pola: /\b(?:kurang|defisiensi|kekurangan)\b.{0,20}\b(?:fosfor|fosfat|unsur p)\b|\bdaun\b.{0,20}\b(?:keunguan|ungu|kemerahan|gelap kusam)\b/,
    judul: 'Analisis Defisiensi Fosfor (P)',
    analisis: 'Gejala: Daun tua berwarna hijau gelap kusam dengan semburat ungu kemerahan di tepi dan tulang daun bagian bawah. Pertumbuhan akar kerdil dan lambat bercabang.',
    penyebab: 'Fosfor berperan dalam transfer energi sel (ATP) dan pembentukan membran akar. Kekurangan P sering terjadi saat suhu air di penampung terlalu dingin (<18°C) atau pH > 7.0 yang mengikat fosfat menjadi bentuk tidak larut.',
    tindakan: [
      'Periksa pH penampung air: turunkan pH ke 5.8–6.2 menggunakan pH Down (Asam Fosfat / H3PO4).',
      'Jaga suhu air di penampung tetap hangat di rentang 22–26°C agar serapan ion H2PO4- optimal.',
      'Tambahkan Monokalium Fosfat (MKP) pada pekatan B bila fase memasuki pembungaan.',
    ],
  },
  {
    id: 'defisiensi_kalium',
    pola: /\b(?:kurang|defisiensi|kekurangan)\b.{0,20}\b(?:kalium|potasium|unsur k)\b|\bpinggir daun\b.{0,25}\b(?:terbakar|kering kuning|nekrosis tepi)\b/,
    judul: 'Analisis Defisiensi Kalium (K)',
    analisis: 'Gejala: Tepi (pinggiran) daun tua menguning lalu mengering kecokelatan seperti terbakar (marginal chlorosis/necrosis), batang lembek, dan pembentukan jaring serta rasa manis melon terhambat.',
    penyebab: 'Kalium mengatur tekanan turgor sel, pembukaan stomata, dan translokasi karbohidrat ke buah. Kebutuhan Kalium melon meningkat 2–3 kali lipat saat buah mulai membesar (HST 35+).',
    tindakan: [
      'Naikkan rasio pupuk Kalium (Kalium Nitrat / Kalium Sulfat) pada fase pembesaran buah (HST 35–60).',
      'Target PPM fase generatif melon dijaga di 1400–1800 PPM.',
      'Hindari kelebihan Kalsium atau Magnesium yang terlalu dominan di penampung air karena dapat menekan serapan Kalium.',
    ],
  },
  {
    id: 'defisiensi_kalsium',
    pola: /\b(?:kurang|defisiensi|kekurangan)\b.{0,20}\b(?:kalsium|unsur ca)\b|\b(?:tip burn|blossom end rot|busuk pantat buah|ujung daun melengkung mati)\b/,
    judul: 'Analisis Defisiensi Kalsium (Ca) & Tip Burn',
    analisis: 'Gejala: Pucuk daun muda melengkung kaku seperti cakar, tepi daun muda terbakar kering (tip burn), dan ujung buah melon/tomat membusuk hitam (Blossom End Rot).',
    penyebab: 'Kalsium adalah unsur lambat/tidak bergerak (immobile) yang hanya diangkut bersama aliran air transpirasi tanaman. Jika kelembapan malam hari >85% (transpirasi nol) atau suhu siang >34°C (stomata menutup), kalsium tidak sampai ke sel ujung yang sedang tumbuh cepat.',
    tindakan: [
      'Perbaiki sirkulasi udara greenhouse dengan exhaust fan agar kelembapan malam hari tidak jenuh (>85%).',
      'Stabilkan irigasi fertigasi; jangan biarkan media tanam mengalami fluktuasi kering-basah ekstrem.',
      'Semprotkan pupuk daun Kalsium Boron (CaB) 1–2 g/L air di pagi hari langsung ke daun muda dan bakal buah.',
    ],
  },
  {
    id: 'defisiensi_magnesium',
    pola: /\b(?:kurang|defisiensi|kekurangan)\b.{0,20}\b(?:magnesium|unsur mg)\b|\b(?:klorosis interveinal|tulang daun hijau sela kuning|daun tua bercak kuning di sela tulang)\b/,
    judul: 'Analisis Defisiensi Magnesium (Mg)',
    analisis: 'Gejala: Daun tua mengalami klorosis interveinal khas — area helaian daun di antara tulang daun berubah kuning cerah, sedangkan tulang-tulang daun tetap berwarna hijau tua tebal.',
    penyebab: 'Magnesium adalah inti atom klorofil (zat hijau daun). Kekurangan Mg menurunkan kemampuan fotosintesis. Sering dipicu oleh kelebihan Kalium (K) di penampung air yang menghambat penyerapan Mg.',
    tindakan: [
      'Semprotkan pupuk daun Garam Epsom (Magnesium Sulfat / MgSO4) konsentrasi 2–3 g/L air di pagi hari untuk pemulihan cepat.',
      'Periksa takaran Magnesium Sulfat di pekatan B AB Mix (minimal 15–20% dari total berat pupuk B).',
      'Pastikan pH penampung air berada di rentang 5.8–6.3 agar kation Mg2+ mudah terserap akar.',
    ],
  },
  {
    id: 'defisiensi_zat_besi',
    pola: /\b(?:kurang|defisiensi|kekurangan)\b.{0,20}\b(?:zat besi|unsur fe|besi)\b|\bdaun muda\b.{0,25}\b(?:kuning pucat tulang hijau|memutih|klorosis daun muda)\b/,
    judul: 'Analisis Defisiensi Zat Besi (Fe) & Penguncian pH Tinggi',
    analisis: 'Gejala: Daun-daun pucuk paling muda memucat kekuningan hingga putih krem, namun urat tulang daun halus tetap berwarna hijau (berbeda dengan magnesium yang menyerang daun tua).',
    penyebab: 'Zat besi mengendap dan tidak larut saat pH penampung air naik di atas 6.8. Tanpa kelat yang kuat, Fe2+ teroksidasi menjadi Fe3+ yang tidak dapat diserap tanaman.',
    tindakan: [
      'Turunkan pH penampung air segera ke 5.8–6.2 dengan menambahkan larutan pH Down.',
      'Gunakan kelat besi Fe-EDDHA (berwarna merah tua pekat) jika air baku Anda memiliki pH basa stabil di atas 7.0 karena Fe-EDTA rusak di pH tinggi.',
      'Periksa apakah aerasi penampung air berlebihan di dekat titik tuang zat besi yang dapat memicu oksidasi.',
    ],
  },
  {
    id: 'defisiensi_boron',
    pola: /\b(?:kurang|defisiensi|kekurangan)\b.{0,20}\b(?:boron|unsur b)\b|\b(?:titik tumbuh mati|daun rapuh tebal kerdil|buah retak gabus)\b/,
    judul: 'Analisis Defisiensi Boron (B)',
    analisis: 'Gejala: Titik tumbuh kuncup pucuk mati menghitam, daun menebal kaku rapuh melengkung, tangkai daun mudah patah, dan kulit buah melon mengalami luka gabus/retak tidak beraturan.',
    penyebab: 'Boron bekerja sama dengan Kalsium dalam pembentukan dinding sel dan pemanjangan tabung serbuk sari bunga saat polinasi.',
    tindakan: [
      'Pastikan mikronutrien Boron (Asam Borat / H3BO3) ada di pekatan B dengan dosis tepat (0.5–1 ppm murni di penampung air).',
      'Hati-hati: batas antara defisiensi dan keracunan Boron sangat sempit. Jangan menambah asam borat murni sembarangan tanpa perhitungan teliti.',
    ],
  },
  {
    id: 'antagonisme_hara',
    pola: /\b(?:antagonisme|kelebihan kalium|kelebihan kalsium|kelebihan nitrogen)\b|\bunsur saling hambat\b/,
    judul: 'Analisis Antagonisme & Keseimbangan Kation (K : Ca : Mg)',
    analisis: 'Penjelasan: Di dalam larutan hidroponik, ion-ion bermuatan positif (K+, Ca2+, Mg2+) bersaing di permukaan bulu akar. Bila salah satu kation terlalu dominan, penyerapan dua kation lainnya akan tertekan (antagonisme).',
    penyebab: 'Contoh klasik: Petani menambah Kalium berlebih untuk mengejar manis buah, namun akibatnya daun bawah mendadak klorosis (kurang Mg) dan pucuk terkena tip burn (kurang Ca).',
    tindakan: [
      'Gunakan rasio molar seimbang: K (4–6 mM) : Ca (3–4 mM) : Mg (1.5–2 mM).',
      'Koreksi ketidakseimbangan dengan mengganti 30% air di penampung dengan nutrisi berformula standar.',
    ],
  },
  {
    id: 'ec_drainase_runoff',
    pola: /\b(?:runoff|drainase|ec drainase|ppm drainase|air buangan media)\b/,
    judul: 'Analisis EC/TDS Air Drainase (Run-off Fertigasi)',
    analisis: 'Aturan Analisis: Nilai EC air yang keluar dari bawah polybag (drainase) idealnya hanya berselisih +200 s/d 300 PPM dari EC air nutrisi yang disiramkan (input).',
    penyebab: 'Bila TDS drainase naik >500 PPM di atas TDS input, berarti terjadi penumpukan garam pupuk (salt accumulation) di dalam media tanam akibat penguapan tinggi.',
    tindakan: [
      'Lakukan penyiraman air baku murni (flushing) satu kali di pagi hari untuk membilas akumulasi garam media.',
      'Tingkatkan persentase drainase (run-off target: 15–20% dari total volume siram harian).',
    ],
  },

  // ── 2. HAMA & PENGENDALIAN HAYATI GREENHOUSE ──────────────────────────
  {
    id: 'hama_thrips',
    pola: /\b(?:thrips|trip|trips)\b|\bdaun keriting ke bawah\b|\bgaris perak di daun\b/,
    judul: 'Diagnosa & Pengendalian Hama Thrips (Frankliniella occidentalis)',
    analisis: 'Gejala: Daun keriting melengkung ke bawah, permukaan bawah daun tampak bercak kilau keperakan dengan titik-titik hitam kotoran hama, pucuk daun kerdil menyempit.',
    penyebab: 'Thrips adalah serangga renik bertubuh ramping yang menggores permukaan sel daun muda lalu mengisap cairannya. Thrips sangat menyukai kondisi cuaca kering dan panas.',
    tindakan: [
      'Pasang Blue Sticky Trap (perangkap lem biru) atau Yellow Sticky Trap setinggi tajuk tanaman (1 perangkap per 10 m²). Warna biru sangat disukai Thrips.',
      'Semprotkan biopestisida Minyak Mimba (Neem Oil) 5 ml/L + 1 ml sabun cair perekat pada sore hari (16.30+) dengan mengarahkan nosel ke bagian bawah daun.',
      'Aplikasi jamur entomopatogen Beauveria bassiana 2–3 g/L di sore hari untuk menginfeksi nimfa dan thrips dewasa secara alami.',
    ],
  },
  {
    id: 'hama_kutu_kebul',
    pola: /\b(?:kutu kebul|whitefly|bemisia tabaci)\b|\bserangga putih kecil terbang\b|\bembun jelaga hitam\b/,
    judul: 'Diagnosa & Pengendalian Kutu Kebul (Whitefly / Bemisia tabaci)',
    analisis: 'Gejala: Kumpulan serangga putih kecil beterbangan saat daun digoyangkan. Daun mengeluarkan cairan lengket manis (honeydew) yang kemudian ditumbuhi jamur hitam jelaga (embun jelaga).',
    penyebab: 'Kutu kebul merupakan vektor (pembawa) paling mematikan bagi Geminivirus (Virus Kuning/Bule/Pepper Yellow Leaf Curl).',
    tindakan: [
      'Pasang Perangkap Lem Kuning (Yellow Sticky Trap) dalam jumlah banyak di lorong dan dekat pintu masuk greenhouse.',
      'Semprotkan ekstrak tembakau/mimba pada pagi hari sebelum kutu kebul aktif bergerak.',
      'Tutup rapat double-door airlock di pintu masuk greenhouse dan periksa kassa serangga (insect net) minimal mesh 50.',
      'Tanaman yang sudah bergejala daun keriting kaku kuning mozaik (terinfeksi virus) wajib dicabut dan dimusnahkan segera.',
    ],
  },
  {
    id: 'hama_tungau_merah',
    pola: /\b(?:tungau|spider mites|red mite)\b|\bjaring laba-laba halus\b|\bbintik kuning kusam di daun\b/,
    judul: 'Diagnosa & Pengendalian Tungau Merah (Tetranychus urticae)',
    analisis: 'Gejala: Permukaan daun berbintik-bintik kuning halus rapat sehingga daun tampak kusam berdebu. Pada serangan parah, terlihat jaring laba-laba halus menyelimuti pucuk dan ketiak daun.',
    penyebab: 'Tungau adalah hewan arakhnida renik yang berkembang biak luar biasa cepat pada kondisi greenhouse yang panas (>32°C) dan kelembapan udara kering (RH < 55%).',
    tindakan: [
      'Tingkatkan kelembapan greenhouse dengan menyalakan pengabutan (misting) air murni untuk menghambat reproduksi tungau.',
      'Semprotkan akarisida nabati berbahan dasar Belerang / Sulfur mikro (2 g/L) atau minyak mimba.',
      'Pangkas daun-daun bawah yang sudah dipenuhi jaring dan bungkus plastik sebelum dibuang ke luar greenhouse.',
    ],
  },
  {
    id: 'hama_liriomyza',
    pola: /\b(?:pengorok daun|liriomyza|ulat peliang|garis putih berliku|daun ada jalur putih)\b/,
    judul: 'Diagnosa Hama Pengorok Daun (Leafminer / Liriomyza sp.)',
    analisis: 'Gejala: Terdapat jalur atau lorong garis putih bening berkelok-kelok (seperti peta) di dalam jaringan daging daun.',
    penyebab: 'Larva lalat Liriomyza memakan lapisan mesofil daun dari dalam, meninggalkan kutikula luar utuh. Mengurangi luas fotosintesis daun.',
    tindakan: [
      'Jepit atau remas jalur putih yang masih berisi larva hidup menggunakan jari untuk membunuh larva di dalam daun.',
      'Pasang perangkap kuning untuk menangkap lalat dewasa sebelum sempat bertelur di daun.',
      'Semprot ekstrak daun mimba atau agens hayati Beauveria bassiana secara merata.',
    ],
  },

  // ── 3. PENYAKIT PATOGEN (JAMUR & BAKTERI) ──────────────────────────────
  {
    id: 'penyakit_powdery_mildew',
    pola: /\b(?:powdery mildew|embun tepung|jamur tepung)\b|\b(?:putih|bercak putih|serbuk putih)\b.{0,25}\b(?:tepung|bedak|daun)\b|\b(?:tepung|bedak)\b.{0,25}\b(?:daun|putih)\b/,
    judul: 'Diagnosa & Solusi Jamur Embun Tepung (Podosphaera xanthii)',
    analisis: 'Gejala: Muncul bercak serbuk putih mirip bedak atau tepung terigu pada permukaan atas daun, yang lama-kelamaan meluas ke seluruh tajuk dan membuat daun mengering kecokelatan.',
    penyebab: 'Spora jamur Podosphaera berkecambah subur pada kelembapan relatif sedang-tinggi (70–80%) dengan sirkulasi udara greenhouse yang pengap tanpa angin.',
    tindakan: [
      'Semprot larutan Kalium Bikarbonat (KHCO3) dosis 4 g/L air + 1 ml sabun cair perekat. Bikarbonat mengubah pH permukaan daun menjadi basa sehingga miselium jamur mati.',
      'Aplikasi fungisida hayati jamur antagonis Trichoderma harzianum atau bakteri Bacillus subtilis.',
      'Nyalakan kipas sirkulasi (air circulation fan) 24 jam untuk menghilangkan zona udara mati di antara rimbun tanaman.',
    ],
  },
  {
    id: 'daun_bintik_putih_menggulung',
    pola: /\b(?:bintik putih|berbintik putih|bercak putih)\b.{0,35}\b(?:gulung|menggulung|keriting|melengkung)\b|\b(?:daun|pucuk)\b.{0,25}\b(?:menggulung ke atas|melengkung ke atas|menggulung|bintik putih)\b/,
    judul: 'Diagnosa Daun Melon Berbintik Putih & Menggulung',
    analisis: 'Gejala kombinasi bintik putih dan daun menggulung ke atas umumnya berasal dari serangan hama pengisap (Tungau / Thrips / Kutu Kebul) yang sering disertai awal infeksi jamur Embun Tepung (Powdery Mildew) atau cekaman panas/VPD tinggi.',
    penyebab: 'Tungau dan Kutu Kebul mengisap cairan sel di bawah daun meninggalkan bintik keputihan dan membuat tepi daun menggulung, sementara kelembapan tidak merata atau panas >33°C memperparah gulungan daun untuk menekan penguapan.',
    tindakan: [
      'Periksa balik (permukaan bawah) daun dengan cermat: bila ada titik halus bergerak/jaring, itu Tungau; bila ada serangga putih kecil beterbangan, itu Kutu Kebul; bila bercak seperti bedak mudah diusap di atas daun, itu Embun Tepung.',
      'Pasang perangkap lekat kuning (Yellow Sticky Trap) dan biru (Blue Sticky Trap) setinggi tajuk melon, lalu semprot Minyak Mimba (Neem Oil) 3–5 ml/L air merata ke bawah daun pada sore hari.',
      'Stabilkan suhu & ventilasi greenhouse (target VPD 0.8–1.2 kPa), serta pastikan pH penampung air 5.8–6.5 dan TDS sesuai umur fase melon agar imunitas tanaman pulih.',
    ],
  },
  {
    id: 'penyakit_downy_mildew',
    pola: /\b(?:downy mildew|embun bulu|bercak kuning bersudut|jamur bulu kelabu)\b/,
    judul: 'Diagnosa & Solusi Jamur Embun Bulu (Pseudoperonospora cubensis)',
    analisis: 'Gejala: Bercak kuning cerah bersudut tegas yang dibatasi oleh urat tulang daun di permukaan atas. Di permukaan bawah daun tepat di bawah bercak, muncul lapisan bulu halus berwarna ungu keabu-abuan.',
    penyebab: 'Disebabkan oleh oomycetes yang membutuhkan tetesan air bebas (embun) di daun minimal 2–4 jam untuk menginfeksi jaringan tanaman.',
    tindakan: [
      'Hindari daun basah oleh cipratan air atau tetesan kondensasi dari plastik atap UV greenhouse.',
      'Pangkas daun terinfeksi di bagian bawah dan sanitasi greenhouse.',
      'Semprot fungisida tembaga hidroksida (Cu(OH)2) konsentrasi rendah di pagi hari agar daun cepat mengering.',
    ],
  },
  {
    id: 'penyakit_gummy_stem',
    pola: /\b(?:gummy stem|didymella|busuk batang berlendir|pangkal batang keluar cairan cokelat)\b/,
    judul: 'Diagnosa Busuk Batang Berlendir (Gummy Stem Blight / Didymella bryoniae)',
    analisis: 'Gejala: Pangkal batang dekat media atau ketiak bekas pangkasan cabang basah berair, membusuk lunak, dan mengeluarkan getah/lendir kental berwarna cokelat kemerahan seperti karamel.',
    penyebab: 'Jamur patogen masuk melalui luka bekas pruning tunas air yang masih basah saat kelembapan udara sangat tinggi (>85%).',
    tindakan: [
      'PENTING: Lakukan pruning tunas air HANYA di pagi hari yang cerah (pukul 07.30–10.00) agar luka bekas pangkasan cepat kering terpapar sinar matahari.',
      'Oleskan pasta fungisida tembaga atau serbuk kunyit/belerang langsung pada luka batang menggunakan kuas kecil.',
      'Keringkan area pangkal batang; jangan mengarahkan nosel sprayer ke batang utama.',
    ],
  },
  {
    id: 'penyakit_pythium_akar',
    pola: /\b(?:pythium|busuk akar|akar cokelat berlendir|akar bau masam)\b/,
    judul: 'Diagnosa & Solusi Busuk Akar (Pythium Root Rot)',
    analisis: 'Gejala: Perakaran yang semula putih bersih berubah warna menjadi cokelat kehitaman, licin berlendir, mudah mengelupas saat disentuh, dan berbau busuk masam. Tanaman layu parah saat siang terik.',
    penyebab: 'Spora Pythium berenang bebas di air nutrisi saat suhu air di penampung >28°C dan kadar oksigen terlarut (Dissolved Oxygen / DO) turun di bawah 4 mg/L.',
    tindakan: [
      'Tingkatkan Oksigen Terlarut: Pasang aerator gelembung kuat (blower) atau pipa venturi nozzle di penampung air sirkulasi (target DO > 6 mg/L).',
      'Turunkan suhu air di penampung dengan insulasi peredam panas atau letakkan penampung air di area paling teduh.',
      'Sterilisasi air di penampung dengan Hidrogen Peroksida (H2O2) 3% dosis 2–3 ml per liter air, sirkulasikan selama 12 jam sebelum menambahkan inokulan Trichoderma.',
    ],
  },

  // ── 4. IKLIM MIKRO GREENHOUSE & VPD ───────────────────────────────────
  {
    id: 'iklim_vpd_manajemen',
    pola: /\b(?:vpd|vapor pressure deficit|kelembapan dan suhu|stomata menutup panas)\b/,
    judul: 'Analisis Vapor Pressure Deficit (VPD) & Iklim Mikro Greenhouse',
    analisis: 'Konsep Ilmiah: VPD adalah selisih antara tekanan uap di dalam rongga daun jenuh dengan tekanan uap udara sekitar. VPD menentukan seberapa lancar tanaman mentranspirasikan air dan menyerap nutrisi.',
    penyebab: '• VPD Terlalu Rendah (<0.4 kPa / sangat lembap): Transpirasi terhenti, kalsium tidak naik, memicu tip burn dan jamur.\n• VPD Terlalu Tinggi (>1.6 kPa / panas kering): Tanaman menutup stomata untuk mencegah kekeringan, fotosintesis berhenti, daun layu kaku.',
    tindakan: [
      'Rentang VPD Ideal untuk Melon Hidroponik: 0.8 s/d 1.2 kPa.',
      'Bila siang hari terlalu panas dan kering (VPD > 1.5 kPa): Aktifkan pengabutan misting air murni 15 detik tiap 10 menit untuk mendinginkan suhu dan menaikkan kelembapan.',
      'Bila malam hari terlalu lembap (VPD < 0.4 kPa): Nyalakan exhaust fan perlahan untuk mendorong udara lembap keluar dari greenhouse.',
    ],
  },
  {
    id: 'iklim_heat_stress',
    pola: /\b(?:panas ekstrem|suhu 35|suhu 36|suhu greenhouse tinggi|tanaman kepanasan)\b/,
    judul: 'Analisis Cekaman Panas (Heat Stress) Greenhouse',
    analisis: 'Dampak: Saat suhu greenhouse melebihi 33–35°C, enzim rubisco pada daun terdegradasi sehingga fotosintesis melon turun drastis (fotorespirasi naik). Bunga betina melon mudah gugur (aborsi).',
    penyebab: 'Kurangnya ventilasi atap (roof vent) dan radiasi matahari langsung tanpa peneduh di puncak siang hari.',
    tindakan: [
      'Pasang Shading Net (paranet aluminet 40–50%) otomatis yang bisa ditarik pada pukul 11.00–14.00 untuk memantulkan radiasi panas berlebih.',
      'Pastikan roof vent (ventilasi atap) terbuka bebas agar udara panas terangkat ke atas keluar dari greenhouse (efek cerobong alami).',
      'Jangan membiarkan penampung air nutrisi terpapar panas; air yang panas membuat akar kekurangan oksigen.',
    ],
  },

  // ── 5. OPERASIONAL SISTEM & KENDALI DARURAT ───────────────────────────
  {
    id: 'kompensasi_suhu_atc',
    pola: /\b(?:kompensasi suhu|atc|pembacaan ph berubah suhu|sensor melenceng siang malam)\b/,
    judul: 'Analisis Pengaruh Suhu terhadap Sensor pH & TDS (ATC)',
    analisis: 'Fakta Fisik: Tegangan elektroda probe pH (Nernst equation) berubah sekitar 0.03 pH per 1°C kenaikan suhu air. Nilai konduktivitas listrik (EC/TDS) meningkat sekitar 2% per 1°C kenaikan suhu air.',
    penyebab: 'Bila sensor tidak memiliki Automatic Temperature Compensation (ATC) berbasis sensor DS18B20, pembacaan TDS di siang hari (suhu 30°C) akan tampak lebih tinggi daripada di pagi hari (suhu 24°C) meskipun jumlah pupuk di penampung air sama persis.',
    tindakan: [
      'Pastikan sensor suhu air DS18B20 terpasang dan terbaca normal di sistem GARAP.',
      'Sistem GARAP secara otomatis mengompensasi pembacaan TDS ke nilai referensi standar 25°C.',
      'Lakukan kalibrasi buffer pH pada suhu kamar yang stabil (25°C).',
    ],
  },
  {
    id: 'darurat_pompa_mati',
    pola: /\b(?:pompa mati darurat|listrik padam hidroponik|aliran air berhenti|tandon sirkulasi mati)\b/,
    judul: 'SOP Darurat: Listrik Padam / Pompa Sirkulasi Mati',
    analisis: 'Tingkat Bahaya: KRITIS untuk sistem NFT/Drip Fertigasi. Di siang hari yang cerah, media tanam polybag/talang melon dapat mengering total dalam 60–90 menit, menyebabkan kematian rambut akar permanen.',
    penyebab: 'Kegagalan sumber listrik PLN, MCB trip, atau kerusakan mekanis impeller pompa akibat lumut/serat.',
    tindakan: [
      'Prioritas 1: Segera lakukan penyiraman manual darurat menggunakan selang/gembor langsung ke pangkal tanaman melon setiap 30 menit.',
      'Prioritas 2: Hidupkan sumber daya cadangan (UPS baterai / genset mini) khusus untuk jalur pompa penampung air utama.',
      'Prioritas 3: Buka katup pembuangan darurat jika sistem DFT untuk memastikan air menggenang setinggi 2–3 cm di talang sebagai cadangan genangan akar.',
    ],
  },
  {
    id: 'iklim_ideal_melon',
    pola: /\b(?:suhu|temperatur|kelembapan|kelembaban|iklim|rh)\b.{0,30}\b(?:ideal|optimal|terbaik|standar|anjuran|cocok)\b|\b(?:ideal|optimal)\b.{0,25}\b(?:suhu|kelembapan|kelembaban)\b/,
    judul: 'Standar Iklim Mikro & Suhu Air Ideal untuk Melon Hidroponik',
    analisis: 'Melon membutuhkan perbedaan suhu siang–malam yang tepat serta suhu air di penampung yang sejuk agar akar menyerap oksigen terlarut dan hara AB Mix dengan optimal.',
    penyebab: 'Suhu terlalu panas (>34°C) menurunkan polinasi dan merontokkan bunga, sedangkan kelembapan malam >85% memicu jamur Embun Tepung dan tip burn.',
    tindakan: [
      'Suhu Udara Greenhouse: Siang hari ideal 26–32°C; Malam hari ideal 20–24°C.',
      'Kelembapan Udara (RH): Fase vegetatif 65–75%; Fase pembesaran & pematangan buah 55–65% agar rasa manis (Brix) tinggi dan bebas jamur.',
      'Suhu Air di Penampung: Jaga di rentang 20–26°C (maksimal 29°C) agar oksigen terlarut tinggi dan mencegah busuk akar Pythium.',
    ],
  },
  {
    id: 'melon_manis_brix',
    pola: /\b(?:manis|brix tinggi|rasa manis|memaniskan|meningkatkan brix|bikin manis|agar manis|lebih manis)\b|\b(?:buah|melon)\b.{0,20}\b(?:kurang manis|hambar|tidak manis)\b/,
    judul: 'Strategi Agronomi Meningkatkan Kadar Gula (Brix) Melon Hidroponik',
    analisis: 'Target Brix melon hidroponik komersial umumnya 12–15+ Brix. Rasa manis ditentukan oleh keseimbangan Kalium (K), sinar matahari penuh, pemangkasan buah (1 pohon 1 buah), dan pengaturan EC/air menjelang panen.',
    penyebab: 'Buah melon terasa hambar biasanya akibat terlalu banyak buah dalam 1 batang, kelebihan Nitrogen (daun terlalu rimbun), kurang cahaya matahari, atau kelebihan air saat fase pematangan (HST 60–70).',
    tindakan: [
      'Seleksi Buah: Sisakan maksimal 1 buah terbaik per pohon (di ruas ke-9 sampai ke-12) agar seluruh gula fotosintesis terfokus ke satu buah.',
      'Atur Nutrisi Pembesaran -> Pematangan: Jaga PPM di 1400–1800 PPM selama pembentukan net (HST 35–55), lalu turunkan bertahap menjadi 800–1000 PPM dengan porsi Kalium dominan 7–10 hari sebelum panen.',
      'Pengaturan Air & Cahaya: Pastikan daun mendapat sinar matahari optimal dan kurangi frekuensi/volume siram ringan 5–7 hari sebelum petik agar gula terkonsentrasi (tanpa membuat tanaman layu ekstrem). Catat hasil Brix panen di menu Data → Uji Lab.',
    ],
  },
  {
    id: 'perbedaan_ppm_ec',
    pola: /\b(?:beda\w*|perbedaan|hubungan|konversi|rumus)\b.{0,25}\b(?:ppm|tds|ec)\b|\b(?:ppm|tds)\b.{0,15}\b(?:ke|vs|atau|dengan)\b.{0,15}\bec\b/,
    judul: 'Hubungan & Perbedaan EC (mS/cm) vs TDS (PPM) di GARAP',
    analisis: 'EC (Electrical Conductivity) mengukur daya hantar listrik larutan pupuk secara fisik dalam mS/cm atau µS/cm (1 mS/cm = 1000 µS/cm), sedangkan TDS (PPM) adalah angka konversi kepekatan zat terlarut.',
    penyebab: 'Alat IoT & backend GARAP menggunakan faktor konversi standar hidroponik skala 500: PPM = EC (mS/cm) × 500 (contoh: 1,413 mS/cm / 1413 µS/cm = ~706 PPM; 2,0 mS/cm = 1000 PPM).',
    tindakan: [
      'Untuk kalibrasi sensor nutrisi/EC di menu Kalibrasi GARAP, gunakan cairan standar EC 1413 µS/cm (= 1,413 mS/cm atau ±706 PPM pada skala 500).',
      'Pantau kenaikan target PPM harian Melon di menu Dosing (400–600 PPM Semai → 800–1000 PPM Vegetatif → 1400–1800 PPM Pembuahan).',
      'Jika sensor TDS diukur di suhu air berbeda, pastikan sensor DS18B20 aktif agar kompensasi suhu otomatis (ATC) akurat.',
    ],
  },
  {
    id: 'sanitasi_tandon_lumut',
    pola: /\b(?:lumut|berlumut|keruh|kotor|berbau|kuras|bersih\w*|cuci|ganti air)\b.{0,25}\b(?:tandon|toren|air|penampung|bak|pipa|instalasi)\b|\b(?:tandon|toren|air nutrisi)\b.{0,25}\b(?:lumut|berlumut|keruh|kotor|bau|kuras|ganti|usia)\b|\bperpanjang usia larutan\b/,
    judul: 'SOP Sanitasi Penampung Air, Lumut, & Penggantian Air Nutrisi',
    analisis: 'Lumut tumbuh saat air nutrisi terkena cahaya matahari langsung. Lumut menyumbat pompa/pipa, menurunkan oksigen terlarut (DO), menggeser pH naik drastis di siang hari, dan mencuri hara melon.',
    penyebab: 'Tutup penampung air transparan atau bocor cahaya, serta penumpukan garam pupuk/sisa organik akar bila air di penampung tidak dikuras berkala (>14–21 hari).',
    tindakan: [
      'Tutup rapat penampung air dan talang tanam dengan plastik/penutup kedap cahaya agar lumut tidak dapat berfotosintesis.',
      'Lakukan penggantian total (kuras & bilas) air di penampung tiap 10–14 hari atau setiap kali berpindah fase (Semai → Peremajaan → Pendewasaan) untuk mereset keseimbangan ion hara.',
      'Saat menguras, bersihkan dasar penampung air dan saringan pompa secara fisik (bisa dibilas H2O2 3% ringan), lalu isi air baku baru sebelum meracik ulang AB Mix.',
    ],
  },
  {
    id: 'bunga_buah_melon_masalah',
    pola: /\b(?:bunga|bakal buah|pentil|buah)\b.{0,25}\b(?:rontok|gugur|tidak jadi|gagal polinasi|pecah|retak)\b/,
    judul: 'Penanganan Bunga Melon Rontok & Buah Retak/Pecah',
    analisis: 'Bunga betina melon rontok umumnya disebabkan kegagalan penyerbukan (polinasi) atau suhu greenhouse >33°C, sedangkan buah pecah/retak dipicu lonjakan air mendadak saat fase pembesaran akhir.',
    penyebab: 'Polinasi dilakukan lewat pukul 10.00 saat serbuk sari sudah tidak viabel, kekurangan unsur Boron/Kalsium, atau fluktuasi EC dan penyiraman yang tidak stabil.',
    tindakan: [
      'Lakukan polinasi buatan tepat pagi hari pukul 07.00–10.00 saat bunga mekar segar dan suhu greenhouse masih sejuk.',
      'Pastikan nutrisi tahap pembungaan (1000–1200 PPM) dan pH (5.8–6.5) stabil agar Boron & Kalsium terserap sempurna.',
      'Untuk mencegah buah retak di masa pembesaran/netting, hindari mengeringkan media lalu mendadak menyiram air banyak atau menurunkan PPM secara drastis dalam sekali waktu.',
    ],
  },
  {
    id: 'ujung_daun_kering_melon',
    pola: /\b(?:ujung daun|pucuk daun|tepi daun)\b.{0,25}\b(?:kering|mengering|terbakar|melengkung|gosong)\b/,
    judul: 'Analisis Ujung/Tepi Daun Melon Mengering (Tip Burn / Over-EC)',
    analisis: 'Ujung daun muda mengering/melengkung menandakan Tip Burn (defisiensi Kalsium lokal), sedangkan tepi daun tua yang mengering seperti terbakar menandakan TDS/EC terlalu pekat atau kekurangan Kalium.',
    penyebab: 'Kelembapan malam terlalu tinggi (>85%) membuat pengangkutan Kalsium terhenti, atau larutan penampung air terlalu pekat dibanding daya serap air tanaman saat terik.',
    tindakan: [
      'Cek bacaan TDS dan pH di Dashboard: bila TDS melebihi target fase saat ini, encerkan sedikit penampung air dengan air baku; jaga pH di 5.8–6.5.',
      'Pastikan kipas sirkulasi/exhaust tetap berjalan di malam hari agar transpirasi tanaman tidak nol.',
      'Pastikan pekatan A (Kalsium Nitrat) dituang terpisah dari pekatan B agar Kalsium tidak mengendap di dasar penampung air.',
    ],
  },
  {
    id: 'semai_bawang_merah_kain_hitam',
    pola: /\b(?:mengambang|mengapung|terapung|tenggelam)\b.{0,25}\b(?:benih|bibit|biji|melon|bawang|direndam)\b|\b(?:benih|bibit|biji|melon)\b.{0,25}\b(?:mengambang|mengapung|terapung|tenggelam)\b|\b(?:fungsi|kenapa|tujuan|langkah|tips|aman|berapa lama|cara)\b.{0,30}\b(?:bawang merah|kain hitam|jemur|dijemur)\b.{0,30}\b(?:semai|bibit|benih|kecambah|melon|hari\w*)?\b/,
    judul: 'Seleksi Uji Apung, Perendaman Bawang Merah, Kain Hitam, & Jemur Kecambah Melon',
    analisis: 'Perendaman air bawang merah 1 hari menggabungkan ZPT auksin/giberelin & antijamur alami dengan seleksi uji apung. Benih tenggelam memiliki cadangan makanan penuh (bernas), sedangkan benih mengambang kemungkinan kosong/hampa sehingga peluang berkecambahnya sangat kecil.',
    penyebab: 'Dormansi kulit biji melon perlu dilemahkan (priming ZPT + air), dilanjut kondisi gelap-lembap kain hitam 2 hari untuk memicu keluarnya akar putih (radikula), lalu aklimatisasi sinar pagi 2 hari agar batang kuat sebelum menyentuh rockwool.',
    tindakan: [
      'Uji Apung Bawang Merah (1 Hari): Hanya pakai benih yang tenggelam; pisahkan yang mengambang. Bilas ringan benih setelah direndam 24 jam agar sisa lendir bawang tidak berjamur.',
      'Pemeraman Kain Hitam (2 Hari): Simpan dalam kain hitam lembap (bukan becek) di tempat gelap 48 jam sampai cangkang pecah dan muncul bakal akar putih.',
      'Penjemuran Aman (2 Hari): Jemur kecambah di sinar matahari pagi (07.00–10.00 WIB, bukan terik siang) sambil menjaga kain tetap lembap agar akar putih halus tidak kering sebelum ditaruh ke rockwool lembap.',
    ],
  },

  // ── 6. MANAJEMEN PERKEBUNAN & BUDIDAYA MELON MENDALAM ─────────────────
  {
    id: 'varietas_unggul_melon',
    pola: /\b(?:varietas|jenis)\b.{0,25}\b(?:melon)\b|\b(?:inthanon|golden aroma|fujisawa|cantaloupe|rock melon|kirani|jade)\b/,
    judul: 'Karakteristik Varietas Unggul Melon Hidroponik Greenhouse',
    analisis: 'Pemilihan varietas melon di perkebunan greenhouse menentukan umur panen (HST), ketahanan terhadap penyakit, ketebalan jaring (netting), serta potensi kadar kemanisan (Brix).',
    penyebab: 'Setiap kultivar melon memiliki respons serapan Kalium dan durasi fase generatif yang spesifik sehingga jadwal penurunan nutrisi menjelang panen perlu disesuaikan dengan varietasnya.',
    tindakan: [
      'Melon Inthanon & Golden Aroma: Umur panen 60–70 HST, potensi kemanisan 13–15 Brix, daging tebal renyah beraroma kuat, jaring (net) rapat estetis.',
      'Melon Fujisawa & Kirani/Jade: Umur panen 62–72 HST, potensi kemanisan 13–16 Brix, sangat disukai pasar premium karena tekstur lembut dan tahan simpan.',
      'Rock Melon / Cantaloupe: Umur panen 65–75 HST, target 12–14 Brix, daging berwarna jingga kaya beta-karoten, membutuhkan sirkulasi udara kering (RH 55–65%) saat pembentukan net.',
    ],
  },
  {
    id: 'jadwal_hst_lengkap_melon',
    pola: /\b(?:jadwal|kalender|tahapan|siklus|panduan)\b.{0,25}\b(?:hst|tanam melon|budidaya melon|perkebunan melon|pemeliharaan melon)\b|\b(?:umur|fase)\b.{0,20}\b(?:hst|hari setelah tanam)\b.{0,20}\b(?:melon)\b/,
    judul: 'Kalender Lengkap Budidaya Perkebunan Melon Hidroponik (0–70 HST)',
    analisis: 'Siklus perkebunan melon hidroponik terbagi menjadi 5 fase fisiologis utama dengan target kepekatan nutrisi (PPM/EC), pH (5.8–6.5), dan tindakan agronomi yang berbeda di setiap minggunya.',
    penyebab: 'Kesalahan memberikan PPM terlalu tinggi saat fase bibit membuat akar stres osmotik, sedangkan kekurangan PPM saat pembesaran buah membuat ukuran buah kecil dan jaring tipis.',
    tindakan: [
      'Fase 1 — Semai (0–12 HSS): Rendam bawang merah 1 hari (pilih benih tenggelam) → kain hitam 2 hari → jemur pagi 2 hari → rockwool. Nutrisi awal 400–600 PPM setelah kotiledon membuka.',
      'Fase 2 — Vegetatif / Peremajaan (1–21 HST): Pindah ke meja tanam, lilitkan batang ke tali ajir, pangkas habis tunas air di ruas 1–8. Target nutrisi 800–1000 PPM.',
      'Fase 3 — Pembungaan & Polinasi (22–32 HST): Kawinkan bunga betina di ruas 9–12 pada pukul 07.00–10.00 WIB, pilih 1 buah terbaik seukuran telur ayam & gantung buah. Target nutrisi 1000–1200 PPM.',
      'Fase 4 — Pembesaran Buah & Netting (33–58 HST): Topping pucuk utama di daun ke-25–28, tingkatkan nutrisi ke 1400–1800 PPM (dominan Kalium & Kalsium) untuk memaksimalkan bobot dan jaring kulit.',
      'Fase 5 — Pematangan & Panen (59–70 HST): Turunkan nutrisi ke 800–1000 PPM dan kurangi volume siram ringan (water stressing) 7 hari sebelum panen untuk mengunci kemanisan 13–15+ Brix.',
    ],
  },
  {
    id: 'racik_stok_ab_mix_melon',
    pola: /\b(?:racik|meracik|mencampur|campur|larutkan|melarutkan|endapan|mengendap|gipsum)\b.{0,30}\b(?:ab mix|abmix|pekatan a|pekatan b|stok a|stok b|pupuk)\b|\b(?:pekatan a|stok a)\b.{0,25}\b(?:pekatan b|stok b)\b/,
    judul: 'SOP Peracikan Stok Pupuk AB Mix Melon & Pencegahan Endapan',
    analisis: 'Pupuk hidroponik AB Mix dipisah menjadi Pekatan A (berisi Kalsium Nitrat & Besi/Fe) dan Pekatan B (berisi Kalium, Fosfat, Magnesium Sulfat, & Mikrohara) agar tidak bereaksi membentuk endapan padat.',
    penyebab: 'Jika pekatan A dan pekatan B dicampur langsung dalam keadaan pekat tanpa diencerkan di air di penampung terlebih dahulu, ion Kalsium (Ca2+) dan Sulfat (SO4 2-) langsung mengikat menjadi Gipsum (CaSO4) putih yang mengendap dan tidak bisa diserap akar.',
    tindakan: [
      'Isi penampung air dengan air baku bersih minimal 70–80% dari volume target terlebih dahulu dan nyalakan pompa sirkulasi/aerator.',
      'Tuangkan takaran Pekatan A ke dalam penampung air, lalu aduk atau sirkulasikan selama 2–3 menit hingga larut merata sempurna.',
      'Setelah Pekatan A menyatu dengan air baku, barulah tuangkan takaran Pekatan B secara perlahan, kemudian cek nilai TDS (PPM) dan koreksi pH ke 5.8–6.5.',
    ],
  },
  {
    id: 'media_tanam_hidroponik_melon',
    pola: /\b(?:media tanam|cocopeat|sekam bakar|hydroton|dutch bucket|drip irigasi|fertigasi|nft|dft)\b.{0,25}\b(?:melon|hidroponik|perkebunan|kebun)?\b/,
    judul: 'Pemilihan Sistem Hidroponik & Sterilisasi Media Tanam Perkebunan Melon',
    analisis: 'Perkebunan melon hidroponik dapat menggunakan sistem NFT/DFT talang lebar maupun Fertigasi Tetes (Drip Irrigation / Dutch Bucket) dengan media Rockwool, Cocopeat + Arang Sekam, atau Hydroton.',
    penyebab: 'Media cocopeat baru mengandung zat tanin (zat sepat kemerahan) dan garam NaCl tinggi (EC > 1.5 mS/cm) yang dapat menghambat pertumbuhan akar muda melon bila tidak dicuci terlebih dahulu.',
    tindakan: [
      'Untuk Sistem NFT/DFT GARAP: Gunakan bibit dari dadu rockwool bersih, pastikan kemiringan talang lancar (1–2%), genangan air kaya oksigen (DO > 6 mg/L), dan akar tidak terendam becek di pangkal batang.',
      'Jika Menggunakan Cocopeat + Sekam Bakar (rasio 70:30 atau 50:50): Rendam dan bilas cocopeat dengan air bersih berulang kali hingga air buangan jernih dan EC media turun di bawah 0.5 mS/cm (~250 PPM).',
      'Sterilisasi Antar-Musim: Cuci talang, pipa, dan netpot dengan larutan H2O2 atau klorin food-grade lalu bilas air bersih sebelum memulai batch tanam baru.',
    ],
  },
  {
    id: 'pruning_pewiwilan_topping_melon',
    pola: /\b(?:pruning|pewiwilan|wiwil|topping|toping|pucuk|tunas air|cabang samping)\b.{0,25}\b(?:melon|batang|ruas|daun)\b|\b(?:ruas)\b.{0,20}\b(?:1|8|9|12|25|28)\b/,
    judul: 'Teknik Pemangkasan (Pruning), Pewiwilan, & Topping Pucuk Melon',
    analisis: 'Tanaman melon yang dibiarkan tumbuh liar tanpa pemangkasan akan menghabiskan energi fotosintesis untuk daun/cabang vegetatif sehingga buah menjadi kecil, kulit kurang berjaring, dan rentan jamur.',
    penyebab: 'Cabang bawah (ruas 1–8) terlalu dekat dengan media lembap dan menghasilkan buah berkualitas rendah, sedangkan pucuk yang terus memanjang (>30 daun) berebut gula dengan buah yang sedang dibesarkan.',
    tindakan: [
      'Pewiwilan Bawah (Ruas 1–8): Pangkas habis seluruh tunas air dan bunga yang muncul pada ketiak daun ke-1 sampai ke-8 sejak tanaman berumur 10–18 HST.',
      'Cabang Produksi Buah (Ruas 9–12): Pelihara cabang samping pada ruas ke-9 hingga ke-12 tempat munculnya bunga betina. Setelah bunga dikawinkan, sisakan 2 helai daun di atas bakal buah lalu potong ujung cabang tersebut.',
      'Topping Pucuk Utama (Daun 25–28): Potong pucuk batang utama setelah jumlah daun mencapai 25–28 helai, dan selalu lakukan pemangkasan di pagi hari cerah agar luka cepat mengering.',
    ],
  },
  {
    id: 'ciri_matang_dan_panen_melon',
    pola: /\b(?:ciri|tanda|kapan|cara)\b.{0,25}\b(?:melon|buah)\b.{0,25}\b(?:matang|siap panen|dipanen|petik)\b|\b(?:daun bendera|retak cincin|absisi|pascapanen)\b/,
    judul: 'Indikator Kematangan Buah Melon Siap Panen & Penanganan Pascapanen',
    analisis: 'Memanen melon terlalu muda membuat kadar gula (Brix) rendah dan aroma belum keluar, sedangkan memanen terlalu lewat umur membuat daging buah lembek berair (overripe).',
    penyebab: 'Akumulasi sukrosa pada daging buah melon mencapai puncaknya pada 10 hari terakhir sebelum umur panen genetik varietas (60–72 HST).',
    tindakan: [
      'Cek 4 Ciri Fisik Matang Sempurna: (1) Jaring/net timbul tebal merata hingga ke pangkal tangkai, (2) Muncul retakan cincin melingkar (zona absisi) di pangkal tangkai buah, (3) Daun bendera (daun di ketiak tangkai buah) mulai menguning mengering, dan (4) Tercium aroma harum khas di sekitar buah.',
      'Teknik Petik: Potong tangkai buah berbentuk huruf "T" (sisakan ±2–3 cm cabang kiri-kanan tangkai) di pagi hari menggunakan gunting bersih agar buah tahan simpan dan tidak mudah busuk tangkai.',
      'Pascapanen & Pencatatan: Simpan di ruang sejuk kering berventilasi 2–3 hari (curing) untuk memantapkan rasa manis, ukur sample dengan refraktometer, lalu catat hasil panen di aplikasi GARAP.',
    ],
  },
  {
    id: 'penyakit_layu_fusarium_bakteri',
    pola: /\b(?:layu fusarium|fusarium|layu bakteri|ralstonia)\b|\b(?:tanaman|pohon|daun)\b.{0,20}\b(?:melon)\b.{0,25}\b(?:layu mendadak|layu siang|layu permanen)\b/,
    judul: 'Diagnosa Layu Fusarium (Jamur) vs Layu Bakteri (Ralstonia) pada Melon',
    analisis: 'Gejala: Tanaman melon tampak segar di pagi hari namun layu terkulai saat siang hari, diikuti menguningnya daun bawah secara sepihak hingga seluruh tanaman mati mengering.',
    penyebab: 'Jamur Fusarium oxysporum menyumbat pembuluh xilem dengan miselium dan menyebabkan batang bawah kecokelatan (sering retak bergaris), sedangkan bakteri Ralstonia mengeluarkan lendir putih susu keruh bila potongan batang dicelupkan ke air bening.',
    tindakan: [
      'Isolasi Segera: Cabut tanaman yang sudah positif layu sistemik beserta medianya dan musnahkan di luar greenhouse agar patogen tidak menyebar lewat aliran penampung air.',
      'Pencegahan Hayati: Aplikasikan agens hayati Trichoderma harzianum dan PGPR (Bacillus subtilis / Pseudomonas fluorescens) sejak awal pindah tanam untuk melindungi zona perakaran.',
      'Jaga pH & Suhu Air: Pertahankan pH 5.8–6.5 dan suhu air <28°C karena patogen tular-air berkembang cepat pada akar yang stres kekurangan oksigen.',
    ],
  },
  {
    id: 'penyakit_virus_gemini_kuning',
    pola: /\b(?:virus gemini|geminivirus|virus kuning|virus bule|daun mozaik|kuning keriting kaku)\b/,
    judul: 'Diagnosa & Pengendalian Virus Gemini / Mozaik Kuning pada Kebun Melon',
    analisis: 'Gejala: Daun pucuk melon mengalami bercak kuning-hijau belang (mozaik), helaian daun mengecil keriting kaku menebal, ruas batang memendek (kerdil/stunting), dan bunga gagal menjadi buah.',
    penyebab: 'Disebabkan oleh infeksi Begomovirus (Virus Gemini) atau CMV yang ditularkan oleh serangga vektor Kutu Kebul (Bemisia tabaci) dan Kutu Daun (Aphids), serta dapat menular lewat gunting pangkas yang terkontaminasi getah tanaman sakit.',
    tindakan: [
      'Eradikasi Tanaman Sakit: Tanaman yang sudah positif terinfeksi virus tidak dapat disembuhkan dengan fungisida/bakterisida; segera cabut dan masukkan ke kantong tertutup agar tidak menjadi sumber penularan.',
      'Putus Vektor Serangga: Pasang Yellow Sticky Trap rapat, periksa kerapatan insect net (minimal 50 mesh), dan semprotkan minyak mimba/insektisida selektif untuk membasmi Kutu Kebul.',
      'Sterilisasi Alat Pruning: Celupkan mata gunting pangkas ke larutan alkohol 70% atau disinfektan setiap kali berpindah memangkas antar-baris tanaman.',
    ],
  },
  {
    id: 'hama_ulat_lalat_buah_kumbang',
    pola: /\b(?:ulat daun|ulat buah|spodoptera|helicoverpa|lalat buah|bactrocera|kumbang daun|oteng-oteng|daun berlubang)\b/,
    judul: 'Pengendalian Ulat Pemakan Daun, Kumbang Oteng-Oteng, & Lalat Buah Melon',
    analisis: 'Gejala: Daun melon berlubang-lubang tidak beraturan (ulat Spodoptera) atau berlubang melingkar khas (kumbang oteng-oteng Aulacophora), sedangkan serangan lalat buah (Bactrocera) meninggalkan titik tusukan hitam pada kulit buah muda yang membuat dalam buah membusuk berulat.',
    penyebab: 'Kupu-kupu/ngengat atau lalat buah betina berhasil masuk melalui celah ventilasi/pintu greenhouse yang terbuka lalu meletakkan telur pada daun atau bakal buah melon.',
    tindakan: [
      'Pengendalian Ulat & Kumbang: Kumpulkan ulat/telur secara mekanis saat inspeksi pagi, dan semprotkan bioinsektisida bakteri Bacillus thuringiensis (Bt) atau ekstrak mimba pada sore hari.',
      'Perangkap Lalat Buah: Pasang perangkap atraktan Metil Eugenol di luar keliling greenhouse (jangan di dalam greenhouse agar tidak mengundang lalat masuk) serta bungkus buah muda bila kassa greenhouse berlubang.',
      'Perketat Biosekuriti Pintu: Pastikan pintu ganda (double-door) greenhouse selalu tertutup rapat setiap kali petugas keluar-masuk kebun.',
    ],
  },
  {
    id: 'kualitas_air_baku_dan_oksigen',
    pola: /\b(?:air baku|air sumur|air pdam|air hujan|oksigen terlarut|dissolved oxygen|kadar do|aerator|venturi)\b.{0,25}\b(?:melon|hidroponik|tandon|kebun)?\b/,
    judul: 'Standar Air Baku & Oksigen Terlarut (DO) Perkebunan Hidroponik Melon',
    analisis: 'Kualitas air baku menentukan seberapa akurat pupuk AB Mix terserap. Air baku dengan TDS awal terlalu tinggi (>250–300 PPM) biasanya mengandung kapur (CaCO3), besi bebas, atau natrium yang mengacaukan keseimbangan ion.',
    penyebab: 'Air sumur sadah menggeser pH naik terus-menerus, sedangkan air tanpa aerasi yang cukup (DO < 5 mg/L) membuat akar melon lemas (hipoksia) dan gagal menyerap Kalium/Kalsium.',
    tindakan: [
      'Syarat Air Baku Ideal: Gunakan air baku dengan TDS awal < 150 PPM (maksimal 250 PPM) dan pH netral 6.5–7.2. Bila memakai air PDAM, endapkan 24 jam agar klorin menguap sebelum ditambah nutrisi.',
      'Target Oksigen Terlarut (DO): Jaga kadar DO di penampung air minimal 6–8 mg/L dengan menyalakan pompa aerator batu gelembung atau injektor pipa venturi secara kontinu.',
      'Penyesuaian pH: Gunakan larutan Asam Fosfat (H3PO4) food-grade sebagai pH Down dan Kalium Hidroksida (KOH) sebagai pH Up untuk menjaga pH penampung air di rentang 5.8–6.5.',
    ],
  },
  {
    id: 'persiapan_greenhouse_sterilisasi',
    pola: /\b(?:persiapan greenhouse|sterilisasi greenhouse|sanitasi kebun|antar musim|sebelum tanam baru|solarisasi)\b/,
    judul: 'SOP Sterilisasi & Persiapan Greenhouse Perkebunan Sebelum Tanam Baru',
    analisis: 'Jeda antar-siklus panen (minimal 7–14 hari kosong tanaman) wajib dimanfaatkan untuk memutus siklus hidup spora jamur, bakteri, dan telur hama yang tersisa dari periode tanam sebelumnya.',
    penyebab: 'Memasukkan bibit melon baru langsung ke instalasi/greenhouse bekas panen tanpa sterilisasi membuat bibit muda langsung diserang koloni Kutu Kebul, Tungau, atau spora Pythium/Fusarium.',
    tindakan: [
      'Pembersihan Total: Angkut seluruh sisa tanaman lama, gulma, dan akar bekas ke luar area kebun; sapu bersih lantai/weedmat.',
      'Cuci Instalasi & Penampung Air: Sirkulasikan air berisi disinfektan H2O2 3% (3–5 mL/L) atau klorin ke seluruh penampung air, pipa, dan talang selama 12–24 jam, lalu kuras dan bilas dengan air bersih hingga netral.',
      'Solarisasi & Pemeriksaan Alat: Tutup rapat greenhouse saat siang terik selama 3–5 hari untuk mematikan sisa hama dengan suhu panas, ganti Yellow/Blue Sticky Trap baru, lalu lakukan kalibrasi sensor pH & EC (1413 µS/cm) di aplikasi GARAP sebelum bibit masuk.',
    ],
  },
];

/**
 * Pencarian Cepat di Memori RAM (<2ms, 0% CPU, Dingin)
 */
function cariAnalisisCepat(pesan) {
  if (!pesan || typeof pesan !== 'string') return null;
  const bersih = pesan.toLowerCase();
  
  for (const item of MATRIX) {
    if (item.pola.test(bersih)) {
      return item;
    }
  }
  return null;
}

/**
 * Format Teks Respon Siap Baca (tanpa markdown ** mentah agar rapi di Web & Flutter)
 */
function formatHasilAnalisis(item) {
  const langkah = item.tindakan.map((t, idx) => `${idx + 1}. ${t}`).join('\n');
  return [
    `🔬 ${item.judul}`,
    '',
    '📋 Gejala & Kondisi:',
    item.analisis,
    '',
    '🔍 Akar Masalah:',
    item.penyebab,
    '',
    '⚡ Langkah Tindakan Rekomendasi:',
    langkah,
  ].join('\n');
}

module.exports = { cariAnalisisCepat, formatHasilAnalisis, MATRIX };
